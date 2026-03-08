import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createAgentAssignment,
  createTeamTask,
  getActiveTaskForUser,
  getAllActiveTasks,
  getAssignmentsForTask,
  getTeamTask,
  updateAgentAssignment,
  updateTeamTask,
} from './db.js';
import { processTeamTaskIpc } from './team-task-ipc.js';
import { TeamTaskManager, type TeamTaskDb } from './team-task.js';
import type { DiscussionState } from './discussion-engine.js';
import type { GroupPoolEntry } from './group-pool.js';

describe('processTeamTaskIpc', () => {
  let db: TeamTaskDb;

  beforeEach(() => {
    _initTestDatabase();
    db = {
      createTeamTask,
      getTeamTask,
      updateTeamTask,
      getActiveTaskForUser,
      getAllActiveTasks,
      createAgentAssignment,
      getAssignmentsForTask,
      updateAgentAssignment,
    };
  });

  it('creates an assignment proposal first and asks for user feedback', async () => {
    const taskManager = new TeamTaskManager(db, () => ['agent1', 'agent2', 'agent3']);
    const sentMessages: Array<{ jid: string; text: string }> = [];
    const startDiscussion = vi.fn();
    const allocateGroup = vi.fn();

    await processTeamTaskIpc(
      {
        type: 'create_team_task',
        userId: 'user1',
        userChatJid: 'qq:private:1',
        description: '为新功能讨论一个可落地方案',
        title: '新功能讨论',
        roles: [
          { roleName: '架构师', description: '负责系统架构规划' },
          { roleName: '开发者', description: '负责代码实现与调试' },
        ],
      },
      'main-group',
      true,
      {
        taskManager,
        groupPool: { allocateGroup } as unknown as any,
        discussionEngine: { startDiscussion } as unknown as any,
        sendMessage: async (jid, text) => {
          sentMessages.push({ jid, text });
        },
      },
    );

    expect(startDiscussion).not.toHaveBeenCalled();
    expect(allocateGroup).not.toHaveBeenCalled();
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toContain('已完成任务分工与模型分配建议');
    expect(sentMessages[0].text).toContain('你觉得这个方案可以吗');

    const task = getActiveTaskForUser('user1');
    expect(task?.status).toBe('planning');

    const assignments = getAssignmentsForTask(task!.id);
    expect(assignments).toHaveLength(2);
    expect(assignments[0].llmBackend).toBe('claude');
    expect(assignments[1].llmBackend).toBe('openai');
  });

  it('starts a planned discussion after approval', async () => {
    const taskManager = new TeamTaskManager(db, () => ['agent1', 'agent2']);
    const sentMessages: Array<{ jid: string; text: string }> = [];

    await processTeamTaskIpc(
      {
        type: 'create_team_task',
        userId: 'user1',
        userChatJid: 'qq:private:1',
        description: '讨论新功能实现',
        title: '实现讨论',
        roles: [
          { roleName: '架构师', description: '负责架构规划' },
          { roleName: '测试工程师', description: '负责测试与验证' },
        ],
      },
      'main-group',
      true,
      {
        taskManager,
        groupPool: { allocateGroup: vi.fn() } as unknown as any,
        discussionEngine: { startDiscussion: vi.fn() } as unknown as any,
        sendMessage: async (jid, text) => {
          sentMessages.push({ jid, text });
        },
      },
    );

    const task = getActiveTaskForUser('user1');
    const allocateGroup = vi.fn(
      (): GroupPoolEntry => ({
        qqGroupId: 'group-1',
        status: 'in_use',
        currentTaskId: task!.id,
        memberAccounts: ['agent1', 'agent2'],
        createdAt: '2026-03-08T00:00:00Z',
        updatedAt: '2026-03-08T00:00:00Z',
      }),
    );
    const startDiscussion = vi.fn(
      (): DiscussionState => ({
        id: 'disc-1',
        taskId: task!.id,
        qqGroupId: 'group-1',
        phase: 'planning',
        currentRound: 0,
        maxRounds: 5,
        turnOrder: ['agent1', 'agent2'],
        currentTurnIndex: 0,
        participants: [],
        createdAt: '2026-03-08T00:00:00Z',
        updatedAt: '2026-03-08T00:00:00Z',
      }),
    );

    await processTeamTaskIpc(
      {
        type: 'start_discussion',
        taskId: task!.id,
      },
      'main-group',
      true,
      {
        taskManager,
        groupPool: { allocateGroup } as unknown as any,
        discussionEngine: { startDiscussion } as unknown as any,
        sendMessage: async (jid, text) => {
          sentMessages.push({ jid, text });
        },
      },
    );

    expect(allocateGroup).toHaveBeenCalledOnce();
    expect(startDiscussion).toHaveBeenCalledOnce();
    expect(getTeamTask(task!.id)?.status).toBe('in_progress');
    expect(sentMessages.at(-1)?.text).toContain('已按确认后的方案启动团队讨论');
    expect(sentMessages.at(-1)?.text).toContain('group-1');
  });
});
