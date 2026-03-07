import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _initTestDatabase } from './db.js';
import {
  createDiscussion,
  getDiscussion,
  updateDiscussion,
  addDiscussionMessage,
  getDiscussionMessages,
  getDiscussionByGroup,
} from './db.js';
import {
  createTeamTask,
  getTeamTask,
  createAgentAssignment,
} from './db.js';
import {
  getAllGroupPool,
  upsertGroupPool,
  updateGroupPoolStatus,
  getGroupPool,
} from './db.js';
import { GroupPoolManager } from './group-pool.js';
import type { DiscussionState, DiscussionMessage } from './discussion-engine.js';

describe('discussion DB operations', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('creates and retrieves a discussion', () => {
    const state: DiscussionState = {
      id: 'disc-001',
      taskId: 'tt-001',
      qqGroupId: '999888',
      phase: 'discussing',
      currentRound: 1,
      maxRounds: 5,
      turnOrder: ['acc1', 'acc2'],
      currentTurnIndex: 0,
      participants: [
        { qqAccount: 'acc1', roleName: '架构师' },
        { qqAccount: 'acc2', roleName: '测试' },
      ],
      createdAt: '2026-03-07T00:00:00Z',
      updatedAt: '2026-03-07T00:00:00Z',
    };

    createDiscussion(state);
    const retrieved = getDiscussion('disc-001');

    expect(retrieved).toBeDefined();
    expect(retrieved!.taskId).toBe('tt-001');
    expect(retrieved!.turnOrder).toEqual(['acc1', 'acc2']);
    expect(retrieved!.participants.length).toBe(2);
    expect(retrieved!.participants[0].roleName).toBe('架构师');
  });

  it('updates discussion state', () => {
    createDiscussion({
      id: 'disc-002',
      taskId: 'tt-002',
      qqGroupId: '999777',
      phase: 'idle',
      currentRound: 0,
      maxRounds: 3,
      turnOrder: ['a'],
      currentTurnIndex: 0,
      participants: [{ qqAccount: 'a', roleName: 'r' }],
      createdAt: '2026-03-07T00:00:00Z',
      updatedAt: '2026-03-07T00:00:00Z',
    });

    updateDiscussion('disc-002', { phase: 'discussing', currentRound: 1 });
    const updated = getDiscussion('disc-002');
    expect(updated!.phase).toBe('discussing');
    expect(updated!.currentRound).toBe(1);
  });

  it('adds and retrieves discussion messages', () => {
    createDiscussion({
      id: 'disc-003',
      taskId: 'tt-003',
      qqGroupId: '999666',
      phase: 'discussing',
      currentRound: 1,
      maxRounds: 5,
      turnOrder: ['a1', 'a2'],
      currentTurnIndex: 0,
      participants: [
        { qqAccount: 'a1', roleName: '开发' },
        { qqAccount: 'a2', roleName: '设计' },
      ],
      createdAt: '2026-03-07T00:00:00Z',
      updatedAt: '2026-03-07T00:00:00Z',
    });

    addDiscussionMessage({
      discussionId: 'disc-003',
      round: 1,
      senderAccount: 'a1',
      senderRole: '开发',
      content: '我认为应该用微服务架构',
      messageType: 'contribution',
      timestamp: '2026-03-07T00:01:00Z',
    });

    addDiscussionMessage({
      discussionId: 'disc-003',
      round: 1,
      senderAccount: 'a2',
      senderRole: '设计',
      content: '同意，UI层用React',
      messageType: 'contribution',
      timestamp: '2026-03-07T00:02:00Z',
    });

    addDiscussionMessage({
      discussionId: 'disc-003',
      round: 2,
      senderAccount: 'a1',
      senderRole: '开发',
      content: '第二轮补充',
      messageType: 'contribution',
      timestamp: '2026-03-07T00:03:00Z',
    });

    // Get all messages
    const all = getDiscussionMessages('disc-003');
    expect(all.length).toBe(3);

    // Get messages for round 1 only
    const round1 = getDiscussionMessages('disc-003', 1);
    expect(round1.length).toBe(2);
    expect(round1[0].senderRole).toBe('开发');
    expect(round1[1].senderRole).toBe('设计');
  });

  it('finds active discussion by group', () => {
    createDiscussion({
      id: 'disc-active',
      taskId: 'tt-x',
      qqGroupId: '888777',
      phase: 'discussing',
      currentRound: 1,
      maxRounds: 5,
      turnOrder: ['a'],
      currentTurnIndex: 0,
      participants: [{ qqAccount: 'a', roleName: 'r' }],
      createdAt: '2026-03-07T00:00:00Z',
      updatedAt: '2026-03-07T00:00:00Z',
    });

    createDiscussion({
      id: 'disc-done',
      taskId: 'tt-y',
      qqGroupId: '888777',
      phase: 'completed',
      currentRound: 3,
      maxRounds: 5,
      turnOrder: ['b'],
      currentTurnIndex: 0,
      participants: [{ qqAccount: 'b', roleName: 'r2' }],
      createdAt: '2026-03-06T00:00:00Z',
      updatedAt: '2026-03-07T00:00:00Z',
    });

    const active = getDiscussionByGroup('888777');
    expect(active).toBeDefined();
    expect(active!.id).toBe('disc-active');
    expect(active!.phase).toBe('discussing');
  });

  it('returns undefined when no active discussion for group', () => {
    const result = getDiscussionByGroup('nonexistent');
    expect(result).toBeUndefined();
  });
});

describe('group pool DB operations', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('upserts and retrieves group pool entries', () => {
    upsertGroupPool({
      qqGroupId: '111222',
      status: 'available',
      currentTaskId: null,
      memberAccounts: ['acc1', 'acc2'],
      createdAt: '2026-03-07T00:00:00Z',
      updatedAt: '2026-03-07T00:00:00Z',
    });

    const entry = getGroupPool('111222');
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('available');
    expect(entry!.memberAccounts).toEqual(['acc1', 'acc2']);
  });

  it('updates group pool status', () => {
    upsertGroupPool({
      qqGroupId: '333444',
      status: 'available',
      currentTaskId: null,
      memberAccounts: [],
      createdAt: '2026-03-07T00:00:00Z',
      updatedAt: '2026-03-07T00:00:00Z',
    });

    updateGroupPoolStatus('333444', 'in_use', 'tt-001');
    const updated = getGroupPool('333444');
    expect(updated!.status).toBe('in_use');
    expect(updated!.currentTaskId).toBe('tt-001');
  });

  it('lists all pool entries', () => {
    upsertGroupPool({
      qqGroupId: 'g1', status: 'available', currentTaskId: null,
      memberAccounts: [], createdAt: '2026-03-07T00:00:00Z', updatedAt: '2026-03-07T00:00:00Z',
    });
    upsertGroupPool({
      qqGroupId: 'g2', status: 'in_use', currentTaskId: 'tt-x',
      memberAccounts: [], createdAt: '2026-03-07T00:00:00Z', updatedAt: '2026-03-07T00:00:00Z',
    });

    const all = getAllGroupPool();
    expect(all.length).toBe(2);
  });
});

describe('GroupPoolManager', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('allocates and releases groups', async () => {
    const manager = new GroupPoolManager(
      {
        getGroupPool,
        getAllGroupPool,
        upsertGroupPool,
        updateGroupPoolStatus,
      },
      null,
    );

    // Manually add groups to pool
    upsertGroupPool({
      qqGroupId: 'pool-1', status: 'available', currentTaskId: null,
      memberAccounts: [], createdAt: '2026-03-07T00:00:00Z', updatedAt: '2026-03-07T00:00:00Z',
    });
    upsertGroupPool({
      qqGroupId: 'pool-2', status: 'available', currentTaskId: null,
      memberAccounts: [], createdAt: '2026-03-07T00:00:00Z', updatedAt: '2026-03-07T00:00:00Z',
    });

    await manager.syncGroupPool();
    expect(manager.getAvailableCount()).toBe(2);

    // Allocate
    const group = manager.allocateGroup('task-1');
    expect(group).not.toBeNull();
    expect(group!.qqGroupId).toBe('pool-1');
    expect(manager.getAvailableCount()).toBe(1);

    // Release
    manager.releaseGroup('pool-1');
    expect(manager.getAvailableCount()).toBe(2);
  });

  it('returns null when no groups available', async () => {
    const manager = new GroupPoolManager(
      {
        getGroupPool,
        getAllGroupPool,
        upsertGroupPool,
        updateGroupPoolStatus,
      },
      null,
    );

    await manager.syncGroupPool();
    const result = manager.allocateGroup('task-x');
    expect(result).toBeNull();
  });
});
