/**
 * QQ Group Pool Manager
 * Manages a pool of pre-created QQ groups for team task discussions.
 */

import { QQ_GROUP_POOL_IDS } from './config.js';
import { logger } from './logger.js';
import { NapCatFleetManager } from './napcat-fleet.js';

export interface GroupPoolEntry {
  qqGroupId: string;
  status: 'available' | 'in_use' | 'reserved';
  currentTaskId: string | null;
  memberAccounts: string[];
  createdAt: string;
  updatedAt: string;
}

// In-memory group pool state (backed by DB)
export interface GroupPoolDb {
  getGroupPool(groupId: string): GroupPoolEntry | undefined;
  getAllGroupPool(): GroupPoolEntry[];
  upsertGroupPool(entry: GroupPoolEntry): void;
  updateGroupPoolStatus(groupId: string, status: GroupPoolEntry['status'], taskId: string | null): void;
}

export class GroupPoolManager {
  private pool = new Map<string, GroupPoolEntry>();

  constructor(
    private readonly db: GroupPoolDb,
    private readonly fleetManager: NapCatFleetManager | null,
  ) {}

  /**
   * Initialize group pool from config and DB.
   */
  async syncGroupPool(): Promise<void> {
    // Load from DB first
    const dbEntries = this.db.getAllGroupPool();
    for (const entry of dbEntries) {
      this.pool.set(entry.qqGroupId, entry);
    }

    // Add configured groups that aren't in DB yet
    const now = new Date().toISOString();
    for (const groupId of QQ_GROUP_POOL_IDS) {
      if (!this.pool.has(groupId)) {
        const entry: GroupPoolEntry = {
          qqGroupId: groupId,
          status: 'available',
          currentTaskId: null,
          memberAccounts: [],
          createdAt: now,
          updatedAt: now,
        };
        this.pool.set(groupId, entry);
        this.db.upsertGroupPool(entry);
      }
    }

    // Verify members if fleet manager is available
    if (this.fleetManager) {
      const mainConnector = this.fleetManager.getMainConnector();
      if (mainConnector) {
        for (const [groupId, entry] of this.pool) {
          try {
            const members = await mainConnector.getGroupMemberList(groupId);
            entry.memberAccounts = members.map((m) => String(m.user_id));
            entry.updatedAt = new Date().toISOString();
            this.db.upsertGroupPool(entry);
          } catch (err) {
            logger.warn({ groupId, err }, 'Failed to get group members');
          }
        }
      }
    }

    logger.info({ poolSize: this.pool.size }, 'Group pool synced');
  }

  /**
   * Allocate an available group for a task.
   */
  allocateGroup(taskId: string): GroupPoolEntry | null {
    for (const [, entry] of this.pool) {
      if (entry.status === 'available') {
        entry.status = 'in_use';
        entry.currentTaskId = taskId;
        entry.updatedAt = new Date().toISOString();
        this.db.updateGroupPoolStatus(entry.qqGroupId, 'in_use', taskId);
        logger.info({ groupId: entry.qqGroupId, taskId }, 'Group allocated');
        return entry;
      }
    }

    logger.warn({ taskId }, 'No available groups in pool');
    return null;
  }

  /**
   * Release a group back to the pool.
   */
  releaseGroup(groupId: string): void {
    const entry = this.pool.get(groupId);
    if (!entry) return;

    entry.status = 'available';
    entry.currentTaskId = null;
    entry.updatedAt = new Date().toISOString();
    this.db.updateGroupPoolStatus(groupId, 'available', null);
    logger.info({ groupId }, 'Group released');
  }

  /**
   * Prepare a group for a task (set group name, send announcement).
   */
  async prepareGroup(groupId: string, title: string): Promise<void> {
    if (!this.fleetManager) return;

    const mainConnector = this.fleetManager.getMainConnector();
    if (!mainConnector) return;

    try {
      await mainConnector.setGroupName(groupId, `🤖 ${title}`);
      await mainConnector.sendGroupMsg(
        groupId,
        `📋 新任务已分配到本群\n任务: ${title}\n\n讨论即将开始...`,
      );
    } catch (err) {
      logger.warn({ groupId, err }, 'Failed to prepare group');
    }
  }

  /**
   * Get all groups in the pool.
   */
  getAll(): GroupPoolEntry[] {
    return Array.from(this.pool.values());
  }

  /**
   * Get a specific group entry.
   */
  getGroup(groupId: string): GroupPoolEntry | undefined {
    return this.pool.get(groupId);
  }

  /**
   * Get count of available groups.
   */
  getAvailableCount(): number {
    let count = 0;
    for (const entry of this.pool.values()) {
      if (entry.status === 'available') count++;
    }
    return count;
  }
}
