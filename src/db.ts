import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';
import type { GroupPoolEntry } from './group-pool.js';
import type { TeamTask, AgentAssignment } from './team-task.js';
import type { DiscussionState, DiscussionMessage, DiscussionParticipant } from './discussion-engine.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }

  // --- Team collaboration tables ---
  database.exec(`
    CREATE TABLE IF NOT EXISTS team_tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_chat_jid TEXT NOT NULL,
      title TEXT,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      qq_group_id TEXT,
      discussion_id TEXT,
      agent_roles TEXT,
      result TEXT,
      priority INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_team_tasks_user ON team_tasks(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_team_tasks_status ON team_tasks(status);

    CREATE TABLE IF NOT EXISTS agent_assignments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      qq_account TEXT NOT NULL,
      role_name TEXT NOT NULL,
      status TEXT DEFAULT 'assigned',
      FOREIGN KEY (task_id) REFERENCES team_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_assignments_task ON agent_assignments(task_id);

    CREATE TABLE IF NOT EXISTS group_pool (
      qq_group_id TEXT PRIMARY KEY,
      status TEXT DEFAULT 'available',
      current_task_id TEXT,
      member_accounts TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS discussions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      qq_group_id TEXT NOT NULL,
      phase TEXT DEFAULT 'idle',
      current_round INTEGER DEFAULT 0,
      max_rounds INTEGER DEFAULT 5,
      turn_order TEXT,
      current_turn_index INTEGER DEFAULT 0,
      participants TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_discussions_task ON discussions(task_id);
    CREATE INDEX IF NOT EXISTS idx_discussions_group ON discussions(qq_group_id);

    CREATE TABLE IF NOT EXISTS discussion_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discussion_id TEXT NOT NULL,
      round INTEGER NOT NULL,
      sender_account TEXT NOT NULL,
      sender_role TEXT NOT NULL,
      content TEXT NOT NULL,
      message_type TEXT DEFAULT 'contribution',
      timestamp TEXT NOT NULL,
      FOREIGN KEY (discussion_id) REFERENCES discussions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_disc_msgs ON discussion_messages(discussion_id, round);
  `);
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
    };
  }
  return result;
}

// --- Team Task accessors ---

export function createTeamTask(task: TeamTask): void {
  db.prepare(
    `INSERT INTO team_tasks (id, user_id, user_chat_jid, title, description, status, qq_group_id, discussion_id, agent_roles, result, priority, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.userId,
    task.userChatJid,
    task.title,
    task.description,
    task.status,
    task.qqGroupId,
    task.discussionId,
    JSON.stringify(task.agentRoles),
    task.result,
    task.priority,
    task.createdAt,
    task.updatedAt,
    task.completedAt,
  );
}

export function getTeamTask(id: string): TeamTask | undefined {
  const row = db.prepare('SELECT * FROM team_tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: row.id as string,
    userId: row.user_id as string,
    userChatJid: row.user_chat_jid as string,
    title: row.title as string | null,
    description: row.description as string,
    status: row.status as TeamTask['status'],
    qqGroupId: row.qq_group_id as string | null,
    discussionId: row.discussion_id as string | null,
    agentRoles: row.agent_roles ? JSON.parse(row.agent_roles as string) : [],
    result: row.result as string | null,
    priority: row.priority as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    completedAt: row.completed_at as string | null,
  };
}

export function updateTeamTask(id: string, updates: Partial<TeamTask>): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  const fieldMap: Record<string, string> = {
    title: 'title',
    description: 'description',
    status: 'status',
    qqGroupId: 'qq_group_id',
    discussionId: 'discussion_id',
    result: 'result',
    priority: 'priority',
    updatedAt: 'updated_at',
    completedAt: 'completed_at',
  };

  for (const [key, col] of Object.entries(fieldMap)) {
    const val = (updates as Record<string, unknown>)[key];
    if (val !== undefined) {
      fields.push(`${col} = ?`);
      values.push(val);
    }
  }

  if (updates.agentRoles !== undefined) {
    fields.push('agent_roles = ?');
    values.push(JSON.stringify(updates.agentRoles));
  }

  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE team_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function getActiveTaskForUser(userId: string): TeamTask | undefined {
  const row = db.prepare(
    `SELECT * FROM team_tasks WHERE user_id = ? AND status IN ('pending', 'planning', 'in_progress') ORDER BY created_at DESC LIMIT 1`,
  ).get(userId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return getTeamTask(row.id as string);
}

export function getAllActiveTasks(): TeamTask[] {
  const rows = db.prepare(
    `SELECT id FROM team_tasks WHERE status IN ('pending', 'planning', 'in_progress') ORDER BY created_at`,
  ).all() as Array<{ id: string }>;
  return rows.map((r) => getTeamTask(r.id)!).filter(Boolean);
}

export function createAgentAssignment(assignment: AgentAssignment): void {
  db.prepare(
    `INSERT INTO agent_assignments (id, task_id, qq_account, role_name, status) VALUES (?, ?, ?, ?, ?)`,
  ).run(assignment.id, assignment.taskId, assignment.qqAccount, assignment.roleName, assignment.status);
}

export function getAssignmentsForTask(taskId: string): AgentAssignment[] {
  const rows = db.prepare('SELECT * FROM agent_assignments WHERE task_id = ?').all(taskId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row.id as string,
    taskId: row.task_id as string,
    qqAccount: row.qq_account as string,
    roleName: row.role_name as string,
    status: row.status as AgentAssignment['status'],
  }));
}

export function updateAgentAssignment(id: string, updates: Partial<AgentAssignment>): void {
  if (updates.status !== undefined) {
    db.prepare('UPDATE agent_assignments SET status = ? WHERE id = ?').run(updates.status, id);
  }
}

// --- Group Pool accessors ---

export function getGroupPool(groupId: string): GroupPoolEntry | undefined {
  const row = db.prepare('SELECT * FROM group_pool WHERE qq_group_id = ?').get(groupId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    qqGroupId: row.qq_group_id as string,
    status: row.status as GroupPoolEntry['status'],
    currentTaskId: row.current_task_id as string | null,
    memberAccounts: row.member_accounts ? JSON.parse(row.member_accounts as string) : [],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function getAllGroupPool(): GroupPoolEntry[] {
  const rows = db.prepare('SELECT * FROM group_pool').all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    qqGroupId: row.qq_group_id as string,
    status: row.status as GroupPoolEntry['status'],
    currentTaskId: row.current_task_id as string | null,
    memberAccounts: row.member_accounts ? JSON.parse(row.member_accounts as string) : [],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }));
}

export function upsertGroupPool(entry: GroupPoolEntry): void {
  db.prepare(
    `INSERT OR REPLACE INTO group_pool (qq_group_id, status, current_task_id, member_accounts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.qqGroupId,
    entry.status,
    entry.currentTaskId,
    JSON.stringify(entry.memberAccounts),
    entry.createdAt,
    entry.updatedAt,
  );
}

export function updateGroupPoolStatus(groupId: string, status: GroupPoolEntry['status'], taskId: string | null): void {
  db.prepare(
    `UPDATE group_pool SET status = ?, current_task_id = ?, updated_at = ? WHERE qq_group_id = ?`,
  ).run(status, taskId, new Date().toISOString(), groupId);
}

// --- Discussion accessors ---

export function createDiscussion(state: DiscussionState): void {
  db.prepare(
    `INSERT INTO discussions (id, task_id, qq_group_id, phase, current_round, max_rounds, turn_order, current_turn_index, participants, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    state.id,
    state.taskId,
    state.qqGroupId,
    state.phase,
    state.currentRound,
    state.maxRounds,
    JSON.stringify(state.turnOrder),
    state.currentTurnIndex,
    JSON.stringify(state.participants),
    state.createdAt,
    state.updatedAt,
  );
}

export function getDiscussion(id: string): DiscussionState | undefined {
  const row = db.prepare('SELECT * FROM discussions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    qqGroupId: row.qq_group_id as string,
    phase: row.phase as DiscussionState['phase'],
    currentRound: row.current_round as number,
    maxRounds: row.max_rounds as number,
    turnOrder: JSON.parse(row.turn_order as string),
    currentTurnIndex: row.current_turn_index as number,
    participants: JSON.parse(row.participants as string) as DiscussionParticipant[],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function updateDiscussion(id: string, updates: Partial<DiscussionState>): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.phase !== undefined) { fields.push('phase = ?'); values.push(updates.phase); }
  if (updates.currentRound !== undefined) { fields.push('current_round = ?'); values.push(updates.currentRound); }
  if (updates.currentTurnIndex !== undefined) { fields.push('current_turn_index = ?'); values.push(updates.currentTurnIndex); }
  if (updates.updatedAt !== undefined) { fields.push('updated_at = ?'); values.push(updates.updatedAt); }

  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE discussions SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function addDiscussionMessage(msg: DiscussionMessage): void {
  db.prepare(
    `INSERT INTO discussion_messages (discussion_id, round, sender_account, sender_role, content, message_type, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(msg.discussionId, msg.round, msg.senderAccount, msg.senderRole, msg.content, msg.messageType, msg.timestamp);
}

function mapDiscussionMessageRow(row: Record<string, unknown>): DiscussionMessage {
  return {
    id: row.id as number,
    discussionId: row.discussion_id as string,
    round: row.round as number,
    senderAccount: row.sender_account as string,
    senderRole: row.sender_role as string,
    content: row.content as string,
    messageType: row.message_type as DiscussionMessage['messageType'],
    timestamp: row.timestamp as string,
  };
}

export function getDiscussionMessages(discussionId: string, round?: number): DiscussionMessage[] {
  if (round !== undefined) {
    const rows = db.prepare(
      'SELECT * FROM discussion_messages WHERE discussion_id = ? AND round = ? ORDER BY id',
    ).all(discussionId, round) as Array<Record<string, unknown>>;
    return rows.map(mapDiscussionMessageRow);
  }
  const rows = db.prepare(
    'SELECT * FROM discussion_messages WHERE discussion_id = ? ORDER BY id',
  ).all(discussionId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row.id as number,
    discussionId: row.discussion_id as string,
    round: row.round as number,
    senderAccount: row.sender_account as string,
    senderRole: row.sender_role as string,
    content: row.content as string,
    messageType: row.message_type as DiscussionMessage['messageType'],
    timestamp: row.timestamp as string,
  }));
}

export function getDiscussionByGroup(qqGroupId: string): DiscussionState | undefined {
  const row = db.prepare(
    `SELECT id FROM discussions WHERE qq_group_id = ? AND phase != 'completed' ORDER BY created_at DESC LIMIT 1`,
  ).get(qqGroupId) as { id: string } | undefined;
  if (!row) return undefined;
  return getDiscussion(row.id);
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
