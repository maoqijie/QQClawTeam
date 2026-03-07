/**
 * Team Task IPC Extensions
 * Defines IPC types for team task operations and processes them.
 */

import { logger } from './logger.js';
import { TeamTaskManager, type AgentRoleConfig } from './team-task.js';
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

        // Allocate a group from the pool
        const group = deps.groupPool.allocateGroup(task.id);
        if (!group) {
          await deps.sendMessage(
            data.userChatJid,
            '⚠️ 当前没有可用的讨论群，请稍后再试。',
          );
          deps.taskManager.failTask(task.id, 'No available groups in pool');
          return;
        }

        // Start discussion
        const discussion = deps.discussionEngine.startDiscussion(
          task,
          group.qqGroupId,
          assignments,
        );
        deps.taskManager.setTaskGroup(task.id, group.qqGroupId, discussion.id);

        await deps.sendMessage(
          data.userChatJid,
          `✅ 任务已创建并开始讨论\n任务ID: ${task.id}\n讨论群: ${group.qqGroupId}\n参与角色: ${data.roles.map((r) => r.roleName).join(', ')}`,
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
      }
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
