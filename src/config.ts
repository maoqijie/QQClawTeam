import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER', 'LLM_BACKEND', 'OPENAI_MODEL',
  'OPENAI_CONTEXT_WINDOW', 'OPENAI_AUTO_COMPACT_TOKEN_LIMIT',
  'QQ_GROUP_POOL_IDS', 'DISCUSSION_MAX_ROUNDS', 'DISCUSSION_TURN_TIMEOUT',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// LLM backend: 'claude' (default) or 'openai' (OpenAI-compatible APIs)
export const DEFAULT_OPENAI_BASE_URL = 'https://new.fastaicode.top/v1';
export const DEFAULT_OPENAI_MODEL = 'gpt-5.4-pro';
export const LLM_BACKEND =
  process.env.LLM_BACKEND || envConfig.LLM_BACKEND || 'claude';
export const OPENAI_MODEL =
  process.env.OPENAI_MODEL || envConfig.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
export const OPENAI_CONTEXT_WINDOW = Math.max(
  1,
  parseInt(
    process.env.OPENAI_CONTEXT_WINDOW || envConfig.OPENAI_CONTEXT_WINDOW || '1000000',
    10,
  ) || 1000000,
);
export const OPENAI_AUTO_COMPACT_TOKEN_LIMIT = Math.max(
  1,
  parseInt(
    process.env.OPENAI_AUTO_COMPACT_TOKEN_LIMIT ||
      envConfig.OPENAI_AUTO_COMPACT_TOKEN_LIMIT ||
      String(Math.floor(OPENAI_CONTEXT_WINDOW * 0.9)),
    10,
  ) || Math.floor(OPENAI_CONTEXT_WINDOW * 0.9),
);

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// QQ Group Pool: pre-created groups for team tasks
export const QQ_GROUP_POOL_IDS: string[] = (
  process.env.QQ_GROUP_POOL_IDS || envConfig.QQ_GROUP_POOL_IDS || ''
).split(',').map((s) => s.trim()).filter(Boolean);

// Discussion engine settings
export const DISCUSSION_MAX_ROUNDS = parseInt(
  process.env.DISCUSSION_MAX_ROUNDS || envConfig.DISCUSSION_MAX_ROUNDS || '5',
  10,
);
export const DISCUSSION_TURN_TIMEOUT = parseInt(
  process.env.DISCUSSION_TURN_TIMEOUT || envConfig.DISCUSSION_TURN_TIMEOUT || '120000',
  10,
);
