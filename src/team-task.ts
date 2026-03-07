/**
 * Team Task Manager
 * Manages multi-agent collaborative tasks: creation, planning, agent assignment.
 */

import { logger } from './logger.js';

export interface AgentRoleConfig {
  roleName: string;
  description: string;
  systemPrompt?: string;
}

export interface AgentAssignment {
  id: string;
  taskId: string;
  qqAccount: string;
  roleName: string;
  status: 'assigned' | 'active' | 'completed' | 'failed';
}

export type TeamTaskStatus = 'pending' | 'planning' | 'in_progress' | 'completed' | 'failed';

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

export class TeamTaskManager {
  constructor(
    private readonly db: TeamTaskDb,
    private readonly getAvailableAgents: (assignedAccounts: Set<string>) => string[],
  ) {}

  /**
   * Create a new team task from a user request.
   */
  createTask(userId: string, userChatJid: string, description: string, title?: string): TeamTask {
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

    if (availableAgents.length === 0) {
      logger.warn({
        taskId,
        needed: task.agentRoles.length,
        available: 0,
      }, 'No agents available');
      return null;
    }

    // Cycle through available agents when there are fewer accounts than roles.
    // This allows a single agent account to play multiple roles in turn-based
    // discussions, where messages are distinguished by role name prefix.
    const assignments: AgentAssignment[] = [];
    for (let i = 0; i < task.agentRoles.length; i++) {
      const role = task.agentRoles[i];
      const assignment: AgentAssignment = {
        id: `aa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        taskId,
        qqAccount: availableAgents[i % availableAgents.length],
        roleName: role.roleName,
        status: 'assigned',
      };
      this.db.createAgentAssignment(assignment);
      assignments.push(assignment);
    }

    this.db.updateTeamTask(taskId, {
      status: 'in_progress',
      updatedAt: new Date().toISOString(),
    });

    logger.info({ taskId, assignments: assignments.length }, 'Agents assigned to task');
    return assignments;
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
