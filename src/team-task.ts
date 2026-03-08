/**
 * Team Task Manager
 * Manages multi-agent collaborative tasks: creation, planning, agent assignment.
 */

import { LLM_BACKEND, OPENAI_MODEL } from './config.js';
import { logger } from './logger.js';

export interface AgentRoleConfig {
  roleName: string;
  description: string;
  systemPrompt?: string;
  llmBackend?: 'claude' | 'openai';
  llmModel?: string;
}

export interface AgentAssignment {
  id: string;
  taskId: string;
  qqAccount: string;
  roleName: string;
  status: 'assigned' | 'active' | 'completed' | 'failed';
  llmBackend?: 'claude' | 'openai';
  llmModel?: string;
  assignmentReason?: string;
}

export type TeamTaskStatus =
  | 'pending'
  | 'planning'
  | 'in_progress'
  | 'completed'
  | 'failed';

export interface TeamTask {
  id: string;
  userId: string;
  userChatJid: string;
  title: string | null;
  description: string;
  status: TeamTaskStatus;
  qqGroupId: string | null;
  discussionId: string | null;
  agentRoles: AgentRoleConfig[];
  result: string | null;
  priority: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface TeamTaskDb {
  createTeamTask(task: TeamTask): void;
  getTeamTask(id: string): TeamTask | undefined;
  updateTeamTask(id: string, updates: Partial<TeamTask>): void;
  getActiveTaskForUser(userId: string): TeamTask | undefined;
  getAllActiveTasks(): TeamTask[];
  createAgentAssignment(assignment: AgentAssignment): void;
  getAssignmentsForTask(taskId: string): AgentAssignment[];
  updateAgentAssignment(id: string, updates: Partial<AgentAssignment>): void;
}

const CLAUDE_ROLE_KEYWORDS = [
  '架构',
  '规划',
  '方案',
  '产品',
  '需求',
  '协调',
  '主持',
  '总结',
  '整合',
  '评审',
  '设计',
  '文档',
  '交互',
  '体验',
  '风控',
];

const OPENAI_ROLE_KEYWORDS = [
  '开发',
  '实现',
  '编码',
  '代码',
  '测试',
  'qa',
  '调试',
  '排错',
  '分析',
  '算法',
  '数据',
  '性能',
  '运维',
  '脚本',
  '自动化',
  '接口',
  '数据库',
  '工程',
];

function collectMatchedKeywords(text: string, keywords: string[]): string[] {
  return keywords.filter((keyword) => text.includes(keyword));
}

function normalizeRoleText(role: AgentRoleConfig): string {
  return [role.roleName, role.description, role.systemPrompt]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function formatMatchedKeywords(matches: string[]): string {
  return matches.slice(0, 3).join(' / ');
}

export function formatAssignmentModelLabel(
  assignment: Pick<AgentAssignment, 'llmBackend' | 'llmModel'>,
): string {
  if (assignment.llmBackend === 'openai') {
    return `OpenAI-compatible / ${assignment.llmModel || OPENAI_MODEL}`;
  }
  return 'Claude（官方 OAuth / 默认运行配置）';
}

export function recommendLlmForRole(
  role: AgentRoleConfig,
): Pick<AgentAssignment, 'llmBackend' | 'llmModel' | 'assignmentReason'> {
  if (role.llmBackend || role.llmModel) {
    const backend = role.llmBackend || 'openai';
    const model = backend === 'openai' ? role.llmModel || OPENAI_MODEL : undefined;
    return {
      llmBackend: backend,
      llmModel: model,
      assignmentReason:
        backend === 'openai'
          ? `该角色已显式指定使用 ${model}，本小姐就按你的要求分配给 OpenAI-compatible。`
          : '该角色已显式指定使用 Claude，本小姐保留官方 OAuth / 默认运行配置。',
    };
  }

  const text = normalizeRoleText(role);
  const claudeMatches = collectMatchedKeywords(text, CLAUDE_ROLE_KEYWORDS);
  const openaiMatches = collectMatchedKeywords(text, OPENAI_ROLE_KEYWORDS);

  if (openaiMatches.length > claudeMatches.length) {
    return {
      llmBackend: 'openai',
      llmModel: OPENAI_MODEL,
      assignmentReason: `该角色更偏 ${formatMatchedKeywords(openaiMatches)}，${OPENAI_MODEL} 更适合编码实现、调试验证和执行细节。`,
    };
  }

  if (claudeMatches.length > openaiMatches.length) {
    return {
      llmBackend: 'claude',
      assignmentReason: `该角色更偏 ${formatMatchedKeywords(claudeMatches)}，Claude 更适合长上下文推理、方案归纳和表达整合。`,
    };
  }

  if (/主持|协调|整合|总结|架构/.test(role.roleName)) {
    return {
      llmBackend: 'claude',
      assignmentReason: '这个角色偏统筹与收束，Claude 在讨论组织、方案提炼和多方观点整合上更稳。',
    };
  }

  if (LLM_BACKEND === 'openai') {
    return {
      llmBackend: 'openai',
      llmModel: OPENAI_MODEL,
      assignmentReason: `没有命中特殊偏好词，本小姐先沿用当前默认的 OpenAI-compatible 配置 ${OPENAI_MODEL}。`,
    };
  }

  return {
    llmBackend: 'claude',
    assignmentReason: '没有命中特殊偏好词，本小姐先给这个通用讨论角色使用 Claude 默认运行配置。',
  };
}

export class TeamTaskManager {
  constructor(
    private readonly db: TeamTaskDb,
    private readonly getAvailableAgents: (
      assignedAccounts: Set<string>,
    ) => string[],
  ) {}

  /**
   * Create a new team task from a user request.
   */
  createTask(
    userId: string,
    userChatJid: string,
    description: string,
    title?: string,
  ): TeamTask {
    const id = `tt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    const task: TeamTask = {
      id,
      userId,
      userChatJid,
      title: title || null,
      description,
      status: 'pending',
      qqGroupId: null,
      discussionId: null,
      agentRoles: [],
      result: null,
      priority: 0,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };

    this.db.createTeamTask(task);
    logger.info({ taskId: id, userId }, 'Team task created');
    return task;
  }

  /**
   * Plan a task with role assignments.
   */
  planTask(taskId: string, roles: AgentRoleConfig[]): void {
    const now = new Date().toISOString();
    this.db.updateTeamTask(taskId, {
      status: 'planning',
      agentRoles: roles,
      updatedAt: now,
    });
    logger.info({ taskId, roleCount: roles.length }, 'Team task planned');
  }

  /**
   * Assign available agent accounts to task roles.
   * Returns the assignments if enough agents are available, null otherwise.
   */
  assignAgents(taskId: string): AgentAssignment[] | null {
    const task = this.db.getTeamTask(taskId);
    if (!task) {
      logger.warn({ taskId }, 'Task not found for agent assignment');
      return null;
    }

    // Get currently assigned accounts across all active tasks
    const allActiveTasks = this.db.getAllActiveTasks();
    const assignedAccounts = new Set<string>();
    for (const t of allActiveTasks) {
      if (t.id === taskId) continue;
      const assignments = this.db.getAssignmentsForTask(t.id);
      for (const a of assignments) {
        if (a.status === 'assigned' || a.status === 'active') {
          assignedAccounts.add(a.qqAccount);
        }
      }
    }

    const availableAgents = this.getAvailableAgents(assignedAccounts);

    if (availableAgents.length < task.agentRoles.length) {
      logger.warn(
        {
          taskId,
          needed: task.agentRoles.length,
          available: availableAgents.length,
        },
        'Not enough agents available',
      );
      return null;
    }

    const assignments: AgentAssignment[] = [];
    for (let i = 0; i < task.agentRoles.length; i++) {
      const role = task.agentRoles[i];
      const llmRecommendation = recommendLlmForRole(role);
      const assignment: AgentAssignment = {
        id: `aa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        taskId,
        qqAccount: availableAgents[i],
        roleName: role.roleName,
        status: 'assigned',
        llmBackend: llmRecommendation.llmBackend,
        llmModel: llmRecommendation.llmModel,
        assignmentReason: llmRecommendation.assignmentReason,
      };
      this.db.createAgentAssignment(assignment);
      assignments.push(assignment);
    }

    logger.info(
      {
        taskId,
        assignments: assignments.map((assignment) => ({
          roleName: assignment.roleName,
          qqAccount: assignment.qqAccount,
          llmBackend: assignment.llmBackend,
          llmModel: assignment.llmModel,
        })),
      },
      'Agents assigned to task',
    );
    return assignments;
  }

  markTaskInProgress(taskId: string): void {
    this.db.updateTeamTask(taskId, {
      status: 'in_progress',
      updatedAt: new Date().toISOString(),
    });
  }

  getAssignments(taskId: string): AgentAssignment[] {
    return this.db.getAssignmentsForTask(taskId);
  }

  /**
   * Complete a task with a result.
   */
  completeTask(taskId: string, result: string): void {
    const now = new Date().toISOString();
    this.db.updateTeamTask(taskId, {
      status: 'completed',
      result,
      updatedAt: now,
      completedAt: now,
    });

    // Mark all assignments as completed
    const assignments = this.db.getAssignmentsForTask(taskId);
    for (const a of assignments) {
      this.db.updateAgentAssignment(a.id, { status: 'completed' });
    }

    logger.info({ taskId }, 'Team task completed');
  }

  /**
   * Fail a task.
   */
  failTask(taskId: string, error: string): void {
    const now = new Date().toISOString();
    this.db.updateTeamTask(taskId, {
      status: 'failed',
      result: error,
      updatedAt: now,
      completedAt: now,
    });

    const assignments = this.db.getAssignmentsForTask(taskId);
    for (const a of assignments) {
      this.db.updateAgentAssignment(a.id, { status: 'failed' });
    }

    logger.warn({ taskId, error }, 'Team task failed');
  }

  /**
   * Get active task for a user (one at a time).
   */
  getActiveTask(userId: string): TeamTask | undefined {
    return this.db.getActiveTaskForUser(userId);
  }

  /**
   * Get a task by ID.
   */
  getTask(taskId: string): TeamTask | undefined {
    return this.db.getTeamTask(taskId);
  }

  /**
   * Set the discussion group for a task.
   */
  setTaskGroup(taskId: string, qqGroupId: string, discussionId: string): void {
    this.db.updateTeamTask(taskId, {
      qqGroupId,
      discussionId,
      updatedAt: new Date().toISOString(),
    });
  }
}
