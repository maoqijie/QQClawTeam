/**
 * Discussion Engine - Turn-based Multi-Agent Discussion
 *
 * Controls ordered discussion in QQ groups to prevent message storms.
 * State machine: idle → planning → discussing (Round 1..N) → synthesizing → completed
 *
 * Key design decisions:
 * - Bot group messages are ONLY recorded in discussion_messages, NOT in the main messages table
 * - Only triggerAgentTurn() can start agent containers (prevents feedback loops)
 * - Agent containers are one-shot: speak, then exit
 */

import { DISCUSSION_MAX_ROUNDS, DISCUSSION_TURN_TIMEOUT } from './config.js';
import { logger } from './logger.js';
import { type AgentAssignment } from './team-task.js';

export type DiscussionPhase = 'idle' | 'planning' | 'discussing' | 'synthesizing' | 'completed';

export interface DiscussionParticipant {
  qqAccount: string;
  roleName: string;
  systemPrompt?: string;
}

export interface DiscussionState {
  id: string;
  taskId: string;
  qqGroupId: string;
  phase: DiscussionPhase;
  currentRound: number;
  maxRounds: number;
  turnOrder: string[];  // QQ accounts in speaking order
  currentTurnIndex: number;
  participants: DiscussionParticipant[];
  createdAt: string;
  updatedAt: string;
}

export interface DiscussionMessage {
  id?: number;
  discussionId: string;
  round: number;
  senderAccount: string;
  senderRole: string;
  content: string;
  messageType: 'contribution' | 'synthesis' | 'system';
  timestamp: string;
}

export interface DiscussionDb {
  createDiscussion(state: DiscussionState): void;
  getDiscussion(id: string): DiscussionState | undefined;
  updateDiscussion(id: string, updates: Partial<DiscussionState>): void;
  addDiscussionMessage(msg: DiscussionMessage): void;
  getDiscussionMessages(discussionId: string, round?: number): DiscussionMessage[];
  getDiscussionByGroup(qqGroupId: string): DiscussionState | undefined;
}

export interface DiscussionEngineDeps {
  db: DiscussionDb;
  /**
   * Send a message as a specific QQ account to a group.
   */
  sendAsAccount: (groupId: string, qqAccount: string, text: string) => Promise<void>;
  /**
   * Set a bot account's group card (nickname) in a specific group.
   */
  setGroupCard: (groupId: string, qqAccount: string, card: string) => Promise<void>;
  /**
   * Run a short-lived agent container for a single turn.
   * Returns the agent's response text.
   */
  runAgentTurn: (
    participant: DiscussionParticipant,
    taskDescription: string,
    discussionHistory: string,
    round: number,
    taskId: string,
  ) => Promise<string>;
  /**
   * Get the task description for context.
   */
  getTaskDescription: (taskId: string) => string;
  /**
   * Send a message to the user who created the task.
   */
  sendToUser: (taskId: string, text: string) => Promise<void>;
  /**
   * Called when discussion completes, with the synthesis result.
   */
  onDiscussionComplete: (taskId: string, result: string) => Promise<void>;
}

export class DiscussionEngine {
  private activeDiscussions = new Map<string, DiscussionState>();

  constructor(private readonly deps: DiscussionEngineDeps) {
    // Load active discussions from DB
    // (will be done during init)
  }

  /**
   * Start a new discussion for a team task.
   */
  startDiscussion(
    task: { id: string; description: string; title?: string | null; agentRoles: Array<{ roleName: string; description: string; systemPrompt?: string }> },
    qqGroupId: string,
    assignments: AgentAssignment[],
  ): DiscussionState {
    const id = `disc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    const participants: DiscussionParticipant[] = assignments.map((a) => {
      const role = task.agentRoles.find((r) => r.roleName === a.roleName);
      return {
        qqAccount: a.qqAccount,
        roleName: a.roleName,
        systemPrompt: role?.systemPrompt || role?.description,
      };
    });

    const turnOrder = participants.map((p) => p.qqAccount);

    const state: DiscussionState = {
      id,
      taskId: task.id,
      qqGroupId,
      phase: 'planning',
      currentRound: 0,
      maxRounds: DISCUSSION_MAX_ROUNDS,
      turnOrder,
      currentTurnIndex: 0,
      participants,
      createdAt: now,
      updatedAt: now,
    };

    this.deps.db.createDiscussion(state);
    this.activeDiscussions.set(id, state);

    logger.info({
      discussionId: id,
      taskId: task.id,
      groupId: qqGroupId,
      participants: participants.map((p) => `${p.roleName}(${p.qqAccount})`),
    }, 'Discussion started');

    // Kick off the first round
    void this.startRound(state);

    return state;
  }

  /**
   * Start a new round of discussion.
   */
  private async startRound(state: DiscussionState): Promise<void> {
    state.currentRound += 1;
    state.currentTurnIndex = 0;
    state.phase = 'discussing';
    state.updatedAt = new Date().toISOString();
    this.deps.db.updateDiscussion(state.id, {
      phase: state.phase,
      currentRound: state.currentRound,
      currentTurnIndex: state.currentTurnIndex,
      updatedAt: state.updatedAt,
    });

    // Add system message
    this.deps.db.addDiscussionMessage({
      discussionId: state.id,
      round: state.currentRound,
      senderAccount: 'system',
      senderRole: 'system',
      content: `=== 第 ${state.currentRound} 轮讨论开始 ===`,
      messageType: 'system',
      timestamp: new Date().toISOString(),
    });

    logger.info({
      discussionId: state.id,
      round: state.currentRound,
    }, 'Discussion round started');

    // Trigger the first agent's turn
    await this.triggerNextTurn(state);
  }

  /**
   * Trigger the next agent's turn in the current round.
   */
  private async triggerNextTurn(state: DiscussionState): Promise<void> {
    if (state.currentTurnIndex >= state.turnOrder.length) {
      // All agents have spoken this round
      await this.evaluateRound(state);
      return;
    }

    const qqAccount = state.turnOrder[state.currentTurnIndex];
    const participant = state.participants.find((p) => p.qqAccount === qqAccount);
    if (!participant) {
      logger.error({ qqAccount, discussionId: state.id }, 'Participant not found');
      state.currentTurnIndex++;
      await this.triggerNextTurn(state);
      return;
    }

    await this.triggerAgentTurn(state, participant);
  }

  /**
   * Trigger a single agent's turn.
   * Starts a short-lived container, gets the response, sends it to the group.
   */
  private async triggerAgentTurn(
    state: DiscussionState,
    participant: DiscussionParticipant,
  ): Promise<void> {
    logger.info({
      discussionId: state.id,
      round: state.currentRound,
      role: participant.roleName,
      account: participant.qqAccount,
    }, 'Triggering agent turn');

    const taskDescription = this.deps.getTaskDescription(state.taskId);
    const history = this.formatDiscussionHistory(state);

    try {
      const response = await Promise.race([
        this.deps.runAgentTurn(
          participant,
          taskDescription,
          history,
          state.currentRound,
          state.taskId,
        ),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('Turn timeout')), DISCUSSION_TURN_TIMEOUT),
        ),
      ]);

      // Set the bot's group nickname to the role name before sending
      await this.deps.setGroupCard(state.qqGroupId, participant.qqAccount, participant.roleName);

      // Send the response directly — the group card already shows the role
      await this.deps.sendAsAccount(state.qqGroupId, participant.qqAccount, response);

      // Record in discussion messages
      this.deps.db.addDiscussionMessage({
        discussionId: state.id,
        round: state.currentRound,
        senderAccount: participant.qqAccount,
        senderRole: participant.roleName,
        content: response,
        messageType: 'contribution',
        timestamp: new Date().toISOString(),
      });

      logger.info({
        discussionId: state.id,
        role: participant.roleName,
        responseLength: response.length,
      }, 'Agent turn completed');
    } catch (err) {
      logger.error({
        discussionId: state.id,
        role: participant.roleName,
        err,
      }, 'Agent turn failed');

      // Record failure
      this.deps.db.addDiscussionMessage({
        discussionId: state.id,
        round: state.currentRound,
        senderAccount: participant.qqAccount,
        senderRole: participant.roleName,
        content: `[发言失败: ${err instanceof Error ? err.message : String(err)}]`,
        messageType: 'system',
        timestamp: new Date().toISOString(),
      });
    }

    // Advance to next turn
    state.currentTurnIndex++;
    state.updatedAt = new Date().toISOString();
    this.deps.db.updateDiscussion(state.id, {
      currentTurnIndex: state.currentTurnIndex,
      updatedAt: state.updatedAt,
    });

    // Small delay between turns to prevent rate limiting
    await new Promise((resolve) => setTimeout(resolve, 2000));

    await this.triggerNextTurn(state);
  }

  /**
   * Evaluate whether another round is needed after all agents have spoken.
   */
  private async evaluateRound(state: DiscussionState): Promise<void> {
    logger.info({
      discussionId: state.id,
      round: state.currentRound,
      maxRounds: state.maxRounds,
    }, 'Evaluating round');

    if (state.currentRound >= state.maxRounds) {
      // Max rounds reached, synthesize
      await this.synthesize(state);
      return;
    }

    // Simple heuristic: if the last round had short responses (< 100 chars avg),
    // the discussion has likely converged. Otherwise continue.
    const roundMessages = this.deps.db.getDiscussionMessages(state.id, state.currentRound);
    const contributions = roundMessages.filter((m) => m.messageType === 'contribution');

    if (contributions.length === 0) {
      await this.synthesize(state);
      return;
    }

    const avgLength = contributions.reduce((sum, m) => sum + m.content.length, 0) / contributions.length;

    if (avgLength < 100 && state.currentRound >= 2) {
      // Responses are getting short, likely converged
      logger.info({ discussionId: state.id, avgLength }, 'Discussion converged, synthesizing');
      await this.synthesize(state);
      return;
    }

    // Continue to next round
    await this.startRound(state);
  }

  /**
   * Synthesize the discussion into a final result.
   */
  private async synthesize(state: DiscussionState): Promise<void> {
    state.phase = 'synthesizing';
    state.updatedAt = new Date().toISOString();
    this.deps.db.updateDiscussion(state.id, {
      phase: state.phase,
      updatedAt: state.updatedAt,
    });

    logger.info({ discussionId: state.id }, 'Synthesizing discussion');

    const allMessages = this.deps.db.getDiscussionMessages(state.id);
    const contributions = allMessages.filter((m) => m.messageType === 'contribution');

    // Build synthesis from all contributions
    const synthesis = this.buildSynthesis(state, contributions);

    // Record synthesis
    this.deps.db.addDiscussionMessage({
      discussionId: state.id,
      round: state.currentRound,
      senderAccount: 'system',
      senderRole: 'synthesizer',
      content: synthesis,
      messageType: 'synthesis',
      timestamp: new Date().toISOString(),
    });

    // End discussion
    this.endDiscussion(state.id, synthesis);

    // Notify completion
    await this.deps.onDiscussionComplete(state.taskId, synthesis);
  }

  /**
   * Build a synthesis summary from discussion contributions.
   */
  private buildSynthesis(state: DiscussionState, contributions: DiscussionMessage[]): string {
    const lines: string[] = [
      `📋 讨论综合报告`,
      `任务ID: ${state.taskId}`,
      `讨论轮次: ${state.currentRound}`,
      `参与者: ${state.participants.map((p) => p.roleName).join(', ')}`,
      '',
      '--- 各方观点总结 ---',
      '',
    ];

    // Group by role
    const byRole = new Map<string, DiscussionMessage[]>();
    for (const msg of contributions) {
      const existing = byRole.get(msg.senderRole) || [];
      existing.push(msg);
      byRole.set(msg.senderRole, existing);
    }

    for (const [role, msgs] of byRole) {
      lines.push(`【${role}】`);
      for (const msg of msgs) {
        lines.push(`  第${msg.round}轮: ${msg.content.slice(0, 200)}${msg.content.length > 200 ? '...' : ''}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Format discussion history for agent context.
   */
  private formatDiscussionHistory(state: DiscussionState): string {
    const messages = this.deps.db.getDiscussionMessages(state.id);
    if (messages.length === 0) return '(讨论刚刚开始，还没有历史消息)';

    return messages
      .map((m) => {
        if (m.messageType === 'system') return `[系统] ${m.content}`;
        return `[第${m.round}轮 - ${m.senderRole}] ${m.content}`;
      })
      .join('\n\n');
  }

  /**
   * Record a group message into the discussion (for external messages).
   */
  handleGroupMessage(groupId: string, senderAccount: string, content: string): void {
    const state = this.deps.db.getDiscussionByGroup(groupId);
    if (!state || state.phase === 'completed') return;

    const participant = state.participants.find((p) => p.qqAccount === senderAccount);
    if (!participant) return; // Not a participant

    this.deps.db.addDiscussionMessage({
      discussionId: state.id,
      round: state.currentRound,
      senderAccount,
      senderRole: participant.roleName,
      content,
      messageType: 'contribution',
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * End a discussion.
   */
  endDiscussion(discussionId: string, result: string): void {
    const state = this.activeDiscussions.get(discussionId) || this.deps.db.getDiscussion(discussionId);
    if (!state) return;

    state.phase = 'completed';
    state.updatedAt = new Date().toISOString();
    this.deps.db.updateDiscussion(discussionId, {
      phase: 'completed',
      updatedAt: state.updatedAt,
    });

    this.activeDiscussions.delete(discussionId);
    logger.info({ discussionId, taskId: state.taskId }, 'Discussion ended');
  }

  /**
   * Advance a discussion (resume after pause).
   */
  advanceDiscussion(discussionId: string): void {
    const state = this.deps.db.getDiscussion(discussionId);
    if (!state || state.phase === 'completed') return;

    this.activeDiscussions.set(discussionId, state);

    if (state.phase === 'discussing') {
      void this.triggerNextTurn(state);
    }
  }

  /**
   * Get active discussion for a group.
   */
  getActiveDiscussion(groupId: string): DiscussionState | undefined {
    return this.deps.db.getDiscussionByGroup(groupId);
  }
}
