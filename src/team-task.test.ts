import { describe, it, expect, beforeEach } from 'vitest';
import { _initTestDatabase } from './db.js';
import {
  createTeamTask,
  getTeamTask,
  updateTeamTask,
  getActiveTaskForUser,
  getAllActiveTasks,
  createAgentAssignment,
  getAssignmentsForTask,
  updateAgentAssignment,
} from './db.js';
import { TeamTaskManager } from './team-task.js';
import type { TeamTask, AgentAssignment, TeamTaskDb } from './team-task.js';

describe('team-task DB operations', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('creates and retrieves a team task', () => {
    const task: TeamTask = {
      id: 'tt-001',
      userId: 'user1',
      userChatJid: 'qq:private:12345',
      title: '测试任务',
      description: '讨论如何实现新功能',
      status: 'pending',
      qqGroupId: null,
      discussionId: null,
      agentRoles: [{ roleName: '架构师', description: '负责系统设计' }],
      result: null,
      priority: 0,
      createdAt: '2026-03-07T00:00:00Z',
      updatedAt: '2026-03-07T00:00:00Z',
      completedAt: null,
    };

    createTeamTask(task);
    const retrieved = getTeamTask('tt-001');

    expect(retrieved).toBeDefined();
    expect(retrieved!.title).toBe('测试任务');
    expect(retrieved!.status).toBe('pending');
    expect(retrieved!.agentRoles).toEqual([{ roleName: '架构师', description: '负责系统设计' }]);
  });

  it('updates a team task', () => {
    createTeamTask({
      id: 'tt-002',
      userId: 'user1',
      userChatJid: 'qq:private:12345',
      title: null,
      description: 'test',
      status: 'pending',
      qqGroupId: null,
      discussionId: null,
      agentRoles: [],
      result: null,
      priority: 0,
      createdAt: '2026-03-07T00:00:00Z',
      updatedAt: '2026-03-07T00:00:00Z',
      completedAt: null,
    });

    updateTeamTask('tt-002', { status: 'in_progress', qqGroupId: '999' });
    const updated = getTeamTask('tt-002');
    expect(updated!.status).toBe('in_progress');
    expect(updated!.qqGroupId).toBe('999');
  });

  it('gets active tasks for user', () => {
    createTeamTask({
      id: 'tt-003',
      userId: 'user1',
      userChatJid: 'qq:private:12345',
      title: null,
      description: 'active task',
      status: 'in_progress',
      qqGroupId: null,
      discussionId: null,
      agentRoles: [],
      result: null,
      priority: 0,
      createdAt: '2026-03-07T00:00:00Z',
      updatedAt: '2026-03-07T00:00:00Z',
      completedAt: null,
    });
    createTeamTask({
      id: 'tt-004',
      userId: 'user1',
      userChatJid: 'qq:private:12345',
      title: null,
      description: 'done task',
      status: 'completed',
      qqGroupId: null,
      discussionId: null,
      agentRoles: [],
      result: 'done',
      priority: 0,
      createdAt: '2026-03-06T00:00:00Z',
      updatedAt: '2026-03-07T00:00:00Z',
      completedAt: '2026-03-07T00:00:00Z',
    });

    const active = getActiveTaskForUser('user1');
    expect(active).toBeDefined();
    expect(active!.id).toBe('tt-003');
  });

  it('lists all active tasks', () => {
    createTeamTask({
      id: 'tt-005', userId: 'user1', userChatJid: 'qq:private:1',
      title: null, description: 'a', status: 'in_progress',
      qqGroupId: null, discussionId: null, agentRoles: [], result: null,
      priority: 0, createdAt: '2026-03-07T00:00:00Z', updatedAt: '2026-03-07T00:00:00Z', completedAt: null,
    });
    createTeamTask({
      id: 'tt-006', userId: 'user2', userChatJid: 'qq:private:2',
      title: null, description: 'b', status: 'completed',
      qqGroupId: null, discussionId: null, agentRoles: [], result: 'done',
      priority: 0, createdAt: '2026-03-07T00:00:00Z', updatedAt: '2026-03-07T00:00:00Z', completedAt: '2026-03-07T00:00:00Z',
    });

    const active = getAllActiveTasks();
    expect(active.length).toBe(1);
    expect(active[0].id).toBe('tt-005');
  });
});

describe('agent assignments DB', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('creates and retrieves assignments', () => {
    createTeamTask({
      id: 'tt-100', userId: 'u', userChatJid: 'qq:private:1',
      title: null, description: 't', status: 'in_progress',
      qqGroupId: null, discussionId: null, agentRoles: [], result: null,
      priority: 0, createdAt: '2026-03-07T00:00:00Z', updatedAt: '2026-03-07T00:00:00Z', completedAt: null,
    });

    createAgentAssignment({
      id: 'aa-1', taskId: 'tt-100', qqAccount: '11111', roleName: '架构师', status: 'assigned',
    });
    createAgentAssignment({
      id: 'aa-2', taskId: 'tt-100', qqAccount: '22222', roleName: '测试', status: 'assigned',
    });

    const assignments = getAssignmentsForTask('tt-100');
    expect(assignments.length).toBe(2);
  });

  it('updates assignment status', () => {
    createTeamTask({
      id: 'tt-101', userId: 'u', userChatJid: 'qq:private:1',
      title: null, description: 't', status: 'in_progress',
      qqGroupId: null, discussionId: null, agentRoles: [], result: null,
      priority: 0, createdAt: '2026-03-07T00:00:00Z', updatedAt: '2026-03-07T00:00:00Z', completedAt: null,
    });

    createAgentAssignment({
      id: 'aa-3', taskId: 'tt-101', qqAccount: '33333', roleName: '开发', status: 'assigned',
    });

    updateAgentAssignment('aa-3', { status: 'completed' });
    const assignments = getAssignmentsForTask('tt-101');
    expect(assignments[0].status).toBe('completed');
  });
});

describe('TeamTaskManager', () => {
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

  it('creates a task', () => {
    const manager = new TeamTaskManager(db, () => ['agent1', 'agent2']);
    const task = manager.createTask('user1', 'qq:private:1', '设计新功能', '新功能讨论');

    expect(task.id).toMatch(/^tt-/);
    expect(task.status).toBe('pending');
    expect(task.title).toBe('新功能讨论');
  });

  it('plans and assigns agents', () => {
    const manager = new TeamTaskManager(db, () => ['agent1', 'agent2', 'agent3']);
    const task = manager.createTask('user1', 'qq:private:1', '讨论架构');

    manager.planTask(task.id, [
      { roleName: '架构师', description: '系统设计' },
      { roleName: '开发者', description: '实现' },
    ]);

    const planned = manager.getTask(task.id);
    expect(planned!.status).toBe('planning');
    expect(planned!.agentRoles.length).toBe(2);

    const assignments = manager.assignAgents(task.id);
    expect(assignments).not.toBeNull();
    expect(assignments!.length).toBe(2);
    expect(assignments![0].qqAccount).toBe('agent1');
    expect(assignments![1].qqAccount).toBe('agent2');

    const updated = manager.getTask(task.id);
    expect(updated!.status).toBe('in_progress');
  });

  it('returns null when not enough agents', () => {
    const manager = new TeamTaskManager(db, () => ['agent1']); // only 1 agent
    const task = manager.createTask('user1', 'qq:private:1', '需要3个agent');

    manager.planTask(task.id, [
      { roleName: 'A', description: '' },
      { roleName: 'B', description: '' },
      { roleName: 'C', description: '' },
    ]);

    const assignments = manager.assignAgents(task.id);
    expect(assignments).toBeNull();
  });

  it('completes a task', () => {
    const manager = new TeamTaskManager(db, () => ['a1', 'a2']);
    const task = manager.createTask('user1', 'qq:private:1', 'test');
    manager.planTask(task.id, [
      { roleName: 'R1', description: '' },
      { roleName: 'R2', description: '' },
    ]);
    manager.assignAgents(task.id);

    manager.completeTask(task.id, '任务完成结果');

    const completed = manager.getTask(task.id);
    expect(completed!.status).toBe('completed');
    expect(completed!.result).toBe('任务完成结果');
    expect(completed!.completedAt).toBeTruthy();
  });
});
