/**
 * Team Task IPC Extensions
 * Defines IPC types for team task operations and processes them.
 */

import { logger } from './logger.js';
import {
  TeamTaskManager,
  formatAssignmentModelLabel,
  type AgentAssignment,
  type AgentRoleConfig,
  type TeamTask,
} from './team-task.js';
import { GroupPoolManager } from './group-pool.js';
import { DiscussionEngine } from './discussion-engine.js';

export interface TeamTaskIpcData {
  type: string;
  // create_team_task
  userId?: string;
  userChatJid?: string;
  description?: string;
  title?: string;
  roles?: AgentRoleConfig[];
  // update_team_task / start_discussion / end_discussion
  taskId?: string;
  result?: string;
}

export interface TeamTaskIpcDeps {
  taskManager: TeamTaskManager;
  groupPool: GroupPoolManager;
  discussionEngine: DiscussionEngine;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

function formatAssignmentPlanLines(assignments: AgentAssignment[]): string[] {
  const lines: string[] = [];
  for (const [index, assignment] of assignments.entries()) {
    lines.push(
      `${index + 1}. ${assignment.roleName}（账号 ${assignment.qqAccount}）`,
    );
    lines.push(`   - 模型：${formatAssignmentModelLabel(assignment)}`);
    if (assignment.assignmentReason) {
      lines.push(`   - 理由：${assignment.assignmentReason}`);
    }
  }
  return lines;
}

function formatTaskTitle(task: Pick<TeamTask, 'title' | 'description'>): string {
  return task.title || task.description.slice(0, 50);
}

function formatAssignmentProposalMessage(
  task: TeamTask,
  assignments: AgentAssignment[],
): string {
  return [
    '✅ 已完成任务分工与模型分配建议',
    `任务: ${formatTaskTitle(task)}`,
    `任务ID: ${task.id}`,
    '',
    '建议方案：',
    ...formatAssignmentPlanLines(assignments),
    '',
    '本小姐已经按每个角色的长处分配了更合适的模型。你觉得这个方案可以吗？',
    '如果你想调整，直接告诉我想改哪个角色；如果认可，再让我开始讨论。',
  ].join('\n');
}

function formatDiscussionStartedMessage(
  task: TeamTask,
  groupId: string,
  assignments: AgentAssignment[],
): string {
  return [
    '🚀 已按确认后的方案启动团队讨论',
    `任务: ${formatTaskTitle(task)}`,
    `任务ID: ${task.id}`,
    `讨论群: ${groupId}`,
    '',
    '当前分配：',
    ...formatAssignmentPlanLines(assignments),
  ].join('\n');
}

/**
 * Process team task IPC messages from container agents.
 */
export async function processTeamTaskIpc(
  data: TeamTaskIpcData,
  sourceGroup: string,
  isMain: boolean,
  deps: TeamTaskIpcDeps,
): Promise<void> {
  switch (data.type) {
    case 'create_team_task': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Non-main group attempted to create team task');
        return;
      }
      if (!data.description || !data.userId || !data.userChatJid) {
        logger.warn({ data }, 'create_team_task missing required fields');
        return;
      }

      const task = deps.taskManager.createTask(
        data.userId,
        data.userChatJid,
        data.description,
        data.title,
      );

      // If roles are provided, plan immediately
      if (data.roles && data.roles.length > 0) {
        deps.taskManager.planTask(task.id, data.roles);

        // Assign agents
        const assignments = deps.taskManager.assignAgents(task.id);
        if (!assignments) {
          await deps.sendMessage(
            data.userChatJid,
            '⚠️ 当前没有足够的可用Agent来执行此任务，请稍后再试。',
          );
          deps.taskManager.failTask(task.id, 'Not enough agents available');
          return;
        }

        await deps.sendMessage(
          data.userChatJid,
          formatAssignmentProposalMessage(task, assignments),
        );
      } else {
        await deps.sendMessage(
          data.userChatJid,
          `✅ 任务已创建: ${task.id}\n请提供角色配置以开始讨论。`,
        );
      }
      break;
    }

    case 'start_discussion': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Non-main group attempted to start discussion');
        return;
      }
      if (!data.taskId) {
        logger.warn({ data }, 'start_discussion missing taskId');
        return;
      }

      const task = deps.taskManager.getTask(data.taskId);
      if (!task) {
        logger.warn({ taskId: data.taskId }, 'Task not found for start_discussion');
        return;
      }

      if (task.discussionId) {
        // Resume existing discussion
        deps.discussionEngine.advanceDiscussion(task.discussionId);
        await deps.sendMessage(
          task.userChatJid,
          `🔁 任务 ${task.id} 的团队讨论已继续。`,
        );
        break;
      }

      const assignments = deps.taskManager.getAssignments(task.id);
      if (assignments.length === 0) {
        await deps.sendMessage(
          task.userChatJid,
          '⚠️ 当前任务还没有有效的 Agent 分配，请重新规划后再启动讨论。',
        );
        return;
      }

      const group = deps.groupPool.allocateGroup(task.id);
      if (!group) {
        await deps.sendMessage(
          task.userChatJid,
          '⚠️ 当前没有可用的讨论群，请稍后再试。',
        );
        deps.taskManager.failTask(task.id, 'No available groups in pool');
        return;
      }

      const discussion = deps.discussionEngine.startDiscussion(
        task,
        group.qqGroupId,
        assignments,
      );
      deps.taskManager.setTaskGroup(task.id, group.qqGroupId, discussion.id);
      deps.taskManager.markTaskInProgress(task.id);

      await deps.sendMessage(
        task.userChatJid,
        formatDiscussionStartedMessage(task, group.qqGroupId, assignments),
      );
      break;
    }

    case 'end_discussion': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Non-main group attempted to end discussion');
        return;
      }
      if (!data.taskId) {
        logger.warn({ data }, 'end_discussion missing taskId');
        return;
      }

      const task = deps.taskManager.getTask(data.taskId);
      if (!task || !task.discussionId) {
        logger.warn({ taskId: data.taskId }, 'Task/discussion not found');
        return;
      }

      const result = data.result || 'Discussion ended by main agent';
      deps.discussionEngine.endDiscussion(task.discussionId, result);
      deps.taskManager.completeTask(data.taskId, result);

      // Release the group back to pool
      if (task.qqGroupId) {
        deps.groupPool.releaseGroup(task.qqGroupId);
      }

      // Send result to user
      await deps.sendMessage(
        task.userChatJid,
        `📋 任务完成\n任务: ${task.title || task.description.slice(0, 50)}\n\n结果:\n${result}`,
      );
      break;
    }

    case 'get_team_task_status': {
      if (!data.taskId) {
        logger.warn({ data }, 'get_team_task_status missing taskId');
        return;
      }
      // This is handled by reading the IPC file, not sending a response
      const task = deps.taskManager.getTask(data.taskId);
      logger.info({ taskId: data.taskId, status: task?.status }, 'Team task status queried');
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown team task IPC type');
  }
}
