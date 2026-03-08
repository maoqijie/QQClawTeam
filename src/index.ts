import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  IDLE_TIMEOUT,
  LLM_BACKEND,
  OPENAI_AUTO_COMPACT_TOKEN_LIMIT,
  OPENAI_CONTEXT_WINDOW,
  OPENAI_MODEL,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  AvailableBotAccount,
  ContainerOutput,
  runContainerAgent,
  writeBotAccountsSnapshot,
  writeChatHistorySnapshot,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getStoredMessagesForChat,
  getNewMessages,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  deleteSession,
  deleteChatMetadata,
  deleteMessagesForChat,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  // Team collaboration DB functions
  createTeamTask as dbCreateTeamTask,
  getTeamTask as dbGetTeamTask,
  updateTeamTask as dbUpdateTeamTask,
  getActiveTaskForUser as dbGetActiveTaskForUser,
  getAllActiveTasks as dbGetAllActiveTasks,
  createAgentAssignment as dbCreateAgentAssignment,
  getAssignmentsForTask as dbGetAssignmentsForTask,
  updateAgentAssignment as dbUpdateAgentAssignment,
  getGroupPool as dbGetGroupPool,
  getAllGroupPool as dbGetAllGroupPool,
  upsertGroupPool as dbUpsertGroupPool,
  updateGroupPoolStatus as dbUpdateGroupPoolStatus,
  createDiscussion as dbCreateDiscussion,
  getDiscussion as dbGetDiscussion,
  updateDiscussion as dbUpdateDiscussion,
  addDiscussionMessage as dbAddDiscussionMessage,
  getDiscussionMessages as dbGetDiscussionMessages,
  getDiscussionByGroup as dbGetDiscussionByGroup,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { NapCatFleetManager, loadFleetConfig } from './napcat-fleet.js';
import { GroupPoolManager } from './group-pool.js';
import { TeamTaskManager } from './team-task.js';
import { DiscussionEngine } from './discussion-engine.js';
import { QQBridgeChannel } from './channels/qq-bridge.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
const latePendingMessages = new Map<string, NewMessage[]>();
let activeFleetManager: NapCatFleetManager | null = null;
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function pushLatePendingMessage(chatJid: string, msg: NewMessage): void {
  const existing = latePendingMessages.get(chatJid) || [];
  existing.push(msg);
  existing.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  latePendingMessages.set(chatJid, existing);
}

function drainLatePendingMessages(chatJid: string): NewMessage[] {
  const pending = latePendingMessages.get(chatJid) || [];
  latePendingMessages.delete(chatJid);
  return pending;
}

function clearChatContext(chatJid: string): void {
  const group = registeredGroups[chatJid];
  if (!group) {
    throw new Error(`Chat ${chatJid} is not registered`);
  }

  delete sessions[group.folder];
  deleteSession(group.folder);
  delete lastAgentTimestamp[chatJid];
  latePendingMessages.delete(chatJid);
  queue.closeStdin(chatJid);
  saveState();

  logger.info({ chatJid, folder: group.folder }, 'Cleared chat context');
}

function wipeChatMemory(chatJid: string): void {
  const group = registeredGroups[chatJid];
  if (!group) {
    throw new Error(`Chat ${chatJid} is not registered`);
  }

  clearChatContext(chatJid);
  deleteMessagesForChat(chatJid);
  deleteChatMetadata(chatJid);

  const sessionDir = path.join(DATA_DIR, 'sessions', group.folder);
  fs.rmSync(sessionDir, { recursive: true, force: true });

  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
    fs.rmSync(path.join(groupDir, 'logs'), { recursive: true, force: true });
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  } catch {
    // ignore invalid/missing group folder during wipe
  }

  logger.info({ chatJid, folder: group.folder }, 'Wiped chat memory');
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

function updatePrivateChatLlmConfig(
  chatJid: string,
  containerConfig: RegisteredGroup['containerConfig'],
): void {
  const existing = registeredGroups[chatJid];
  if (!existing) {
    throw new Error(`Chat ${chatJid} is not registered`);
  }

  const nextGroup: RegisteredGroup = {
    ...existing,
    containerConfig,
  };

  registeredGroups[chatJid] = nextGroup;
  setRegisteredGroup(chatJid, nextGroup);
  delete sessions[nextGroup.folder];
  deleteSession(nextGroup.folder);
  queue.closeStdin(chatJid);

  logger.info(
    {
      chatJid,
      folder: nextGroup.folder,
      llmBackend: containerConfig?.llmBackend || null,
      llmModel: containerConfig?.llmModel || null,
    },
    'Updated private chat LLM config',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const lateMessages = drainLatePendingMessages(chatJid);
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  const combinedMessages = [...missedMessages, ...lateMessages]
    .filter(
      (message, index, array) =>
        array.findIndex((candidate) => candidate.id === message.id) === index,
    )
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  if (combinedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = combinedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(combinedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  const latestMessageTimestamp =
    combinedMessages[combinedMessages.length - 1].timestamp;
  lastAgentTimestamp[chatJid] =
    latestMessageTimestamp > previousCursor
      ? latestMessageTimestamp
      : previousCursor;
  saveState();

  logger.info(
    { group: group.name, messageCount: combinedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  const botAccounts: AvailableBotAccount[] = activeFleetManager
    ? activeFleetManager
        .getAllInstances()
        .filter((instance) => !instance.pendingLogin)
        .map((instance) => ({
          qqAccount: instance.qqAccount,
          role: instance.role,
          status: instance.status,
        }))
    : [];
  writeBotAccountsSnapshot(group.folder, isMain, botAccounts);

  const storedHistory = getStoredMessagesForChat(chatJid, ASSISTANT_NAME, 200).map(
    (message) => ({
      senderName: message.sender_name,
      content: message.content,
      timestamp: message.timestamp,
    }),
  );
  writeChatHistorySnapshot(group.folder, storedHistory);

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  const effectiveBackend = group.containerConfig?.llmBackend || LLM_BACKEND;
  const effectiveModel = group.containerConfig?.llmModel || OPENAI_MODEL;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId: effectiveBackend === 'claude' ? sessionId : undefined,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        llmBackend: effectiveBackend,
        llmModel: effectiveModel,
        openaiContextWindow: OPENAI_CONTEXT_WINDOW,
        openaiAutoCompactTokenLimit: OPENAI_AUTO_COMPACT_TOKEN_LIMIT,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Forward reference for discussion engine (assigned after fleet init)
  let discussionEngineRef: DiscussionEngine | null = null;

  // Graceful shutdown handlers (fleetManager captured in closure after init)
  let _fleetManagerRef: NapCatFleetManager | null = null;
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    if (_fleetManagerRef) await _fleetManagerRef.stopAll();
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);

      if (msg.timestamp <= lastTimestamp) {
        const formatted = formatMessages([msg], TIMEZONE);
        if (queue.sendMessage(chatJid, formatted)) {
          logger.info(
            { chatJid, timestamp: msg.timestamp },
            'Delivered late-arriving message directly to active container',
          );
          return;
        }

        pushLatePendingMessage(chatJid, msg);
        queue.enqueueMessageCheck(chatJid);
        logger.info(
          { chatJid, timestamp: msg.timestamp },
          'Queued late-arriving message for out-of-order processing',
        );
      }

      // Forward user messages to active discussions
      if (discussionEngineRef && !msg.is_bot_message) {
        const groupId = chatJid.startsWith('qq:group:') ? chatJid.split(':')[2] : chatJid;
        discussionEngineRef.handleGroupMessage(groupId, msg.sender, msg.content, msg.sender_name);
      }
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
    onPrivateLlmConfigUpdated: (
      chatJid: string,
      containerConfig: RegisteredGroup['containerConfig'],
    ) => {
      updatePrivateChatLlmConfig(chatJid, containerConfig);
    },
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // --- Initialize Team Collaboration Modules ---
  const fleetConfig = loadFleetConfig();
  let fleetManager: NapCatFleetManager | null = null;
  let groupPool: GroupPoolManager | null = null;
  let taskManager: TeamTaskManager | null = null;
  let discussionEngine: DiscussionEngine | null = null;

  if (fleetConfig.accounts.length > 0) {
    fleetManager = new NapCatFleetManager(fleetConfig);
    activeFleetManager = fleetManager;

    // Attach fleet manager to QQ bridge channel if present
    for (const ch of channels) {
      if (ch instanceof QQBridgeChannel) {
        ch.setFleetManager(fleetManager);
      }
    }

    // Start fleet
    await fleetManager.startAll();

    // Initialize group pool
    groupPool = new GroupPoolManager(
      {
        getGroupPool: dbGetGroupPool,
        getAllGroupPool: dbGetAllGroupPool,
        upsertGroupPool: dbUpsertGroupPool,
        updateGroupPoolStatus: dbUpdateGroupPoolStatus,
      },
      fleetManager,
    );
    await groupPool.syncGroupPool();

    // Initialize task manager
    taskManager = new TeamTaskManager(
      {
        createTeamTask: dbCreateTeamTask,
        getTeamTask: dbGetTeamTask,
        updateTeamTask: dbUpdateTeamTask,
        getActiveTaskForUser: dbGetActiveTaskForUser,
        getAllActiveTasks: dbGetAllActiveTasks,
        createAgentAssignment: dbCreateAgentAssignment,
        getAssignmentsForTask: dbGetAssignmentsForTask,
        updateAgentAssignment: dbUpdateAgentAssignment,
      },
      (assigned) => {
        // Use ALL bot accounts (including main) for discussion role assignment.
        // sendAsAccount works for any connected NapCat instance regardless of role.
        const all = Array.from(fleetManager!.getAllBotAccounts());
        return all.filter((a) => !assigned.has(a));
      },
    );

    // Initialize discussion engine
    const qqBridge = channels.find((ch) => ch instanceof QQBridgeChannel) as QQBridgeChannel | undefined;

    discussionEngine = new DiscussionEngine({
      db: {
        createDiscussion: dbCreateDiscussion,
        getDiscussion: dbGetDiscussion,
        updateDiscussion: dbUpdateDiscussion,
        addDiscussionMessage: dbAddDiscussionMessage,
        getDiscussionMessages: dbGetDiscussionMessages,
        getDiscussionByGroup: dbGetDiscussionByGroup,
      },
      sendAsAccount: async (groupId, qqAccount, text) => {
        if (qqBridge) {
          await qqBridge.sendAsAccount(groupId, qqAccount, text);
        }
      },
      setGroupCard: async (groupId, qqAccount, card) => {
        if (fleetManager) {
          const connector = fleetManager.getConnector(qqAccount);
          if (connector) {
            await connector.setGroupCard(groupId, qqAccount, card);
          }
        }
      },
      runAgentTurn: async (participant, taskDescription, history, round, taskId) => {
        // Build a prompt for the agent's turn
        const prompt = [
          `你是一个团队讨论中的 ${participant.roleName}。`,
          participant.systemPrompt ? `角色描述: ${participant.systemPrompt}` : '',
          '',
          `任务: ${taskDescription}`,
          '',
          `当前是第 ${round} 轮讨论。`,
          '',
          '讨论历史:',
          history,
          '',
          '请基于以上讨论，从你的角色视角发表你的观点和建议。保持简洁有力，200字以内。',
          '如果讨论历史中有 ⚠️ [用户反馈]，请务必认真参考用户的意见，调整你的观点和建议方向。',
          '直接输出你的观点，不要加角色名前缀。',
        ].filter(Boolean).join('\n');

        // Create a temporary group folder for this discussion agent
        const discFolder = `disc_${taskId.replace(/[^a-zA-Z0-9-]/g, '_')}`;
        const discGroupDir = resolveGroupFolderPath(discFolder);
        fs.mkdirSync(path.join(discGroupDir, 'logs'), { recursive: true });

        // Write role-specific CLAUDE.md
        const claudeMdPath = path.join(discGroupDir, 'CLAUDE.md');
        fs.writeFileSync(claudeMdPath, [
          `# ${participant.roleName}`,
          '',
          `你是团队讨论中的 ${participant.roleName}。`,
          participant.systemPrompt || '',
          participant.llmBackend === 'openai'
            ? `当前模型：OpenAI-compatible / ${participant.llmModel || OPENAI_MODEL}`
            : '当前模型：Claude（官方 OAuth / 默认运行配置）',
          participant.assignmentReason
            ? `模型分配理由：${participant.assignmentReason}`
            : '',
          '',
          '## 行为规范',
          '',
          '- 直接输出你的观点和建议',
          '- 保持简洁有力，200字以内',
          '- 不要使用工具（不搜索网页、不读写文件），直接基于你的知识回答',
          '- 不要加角色名前缀，直接发表观点',
        ].join('\n'));

        const discGroup: RegisteredGroup = {
          name: `Discussion ${participant.roleName}`,
          folder: discFolder,
          trigger: `@${ASSISTANT_NAME}`,
          added_at: new Date().toISOString(),
          requiresTrigger: false,
          containerConfig: {
            llmBackend: (participant.llmBackend || LLM_BACKEND) as
              | 'claude'
              | 'openai',
            ...(participant.llmBackend === 'openai' || participant.llmModel
              ? { llmModel: participant.llmModel || OPENAI_MODEL }
              : {}),
          },
        };

        // Run container agent and collect response.
        // Discussion turns are one-shot: after the first result, write a _close
        // sentinel so the container exits instead of waiting for more IPC messages.
        let responseText = '';
        const ipcInputDir = path.join(resolveGroupIpcPath(discFolder), 'input');
        fs.mkdirSync(ipcInputDir, { recursive: true });

        await runContainerAgent(
          discGroup,
          {
            prompt,
            groupFolder: discFolder,
            chatJid: 'discussion-internal',
            isMain: false,
            assistantName: participant.roleName,
            teamTaskId: taskId,
          },
          (_proc, _containerName) => {
            // Discussion turn agents are fire-and-forget, no queue registration needed
          },
          async (result) => {
            if (result.result) {
              const text = typeof result.result === 'string'
                ? result.result
                : JSON.stringify(result.result);
              // Strip internal tags
              const cleaned = text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
              if (cleaned) responseText += cleaned;
            }
            // After any output (including null results that signal query completion),
            // close the container so it exits promptly.
            try {
              fs.writeFileSync(path.join(ipcInputDir, '_close'), '');
            } catch {
              // Ignore - container may have already exited
            }
          },
        );

        if (!responseText) {
          throw new Error('Agent produced no output');
        }

        return responseText.trim();
      },
      getTaskDescription: (taskId) => {
        const task = dbGetTeamTask(taskId);
        return task ? task.description : '(任务未找到)';
      },
      sendToUser: async (taskId, text) => {
        const task = dbGetTeamTask(taskId);
        if (task) {
          const channel = findChannel(channels, task.userChatJid);
          if (channel) await channel.sendMessage(task.userChatJid, text);
        }
      },
      getAccountCount: () => fleetManager?.getAllBotAccounts().size ?? 0,
      getMainAccount: () => fleetManager?.getMainAccount(),
      onDiscussionComplete: async (taskId, result) => {
        const task = dbGetTeamTask(taskId);
        if (!task) return;

        taskManager!.completeTask(taskId, result);

        // Release group back to pool
        if (task.qqGroupId && groupPool) {
          groupPool.releaseGroup(task.qqGroupId);
        }

        // Save the full MD document to the group workspace
        const title = task.title || '方案文档';
        const safeTitle = title.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_').slice(0, 40);
        const date = new Date().toISOString().split('T')[0];
        const mdFilename = `${date}-${safeTitle}.md`;
        const outputDir = path.join(resolveGroupFolderPath('qq_private_523528830'), 'plans');
        fs.mkdirSync(outputDir, { recursive: true });
        const mdPath = path.join(outputDir, mdFilename);
        fs.writeFileSync(mdPath, result);
        logger.info({ taskId, mdPath }, 'Discussion plan document saved');

        // Send summary to user (truncate if too long for QQ message)
        const channel = findChannel(channels, task.userChatJid);
        if (channel) {
          const maxLen = 3000;
          if (result.length <= maxLen) {
            await channel.sendMessage(task.userChatJid, `📋 团队讨论完成，以下是方案文档：\n\n${result}`);
          } else {
            // Send in chunks for long documents
            await channel.sendMessage(task.userChatJid, `📋 团队讨论完成，方案文档较长，分段发送：`);
            for (let i = 0; i < result.length; i += maxLen) {
              await channel.sendMessage(task.userChatJid, result.slice(i, i + maxLen));
            }
          }
        }
      },
    });

    _fleetManagerRef = fleetManager;
    discussionEngineRef = discussionEngine;

    logger.info({
      accounts: fleetConfig.accounts.length,
      poolSize: groupPool.getAvailableCount(),
    }, 'Team collaboration modules initialized');
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  const ipcSendMessage = (jid: string, text: string) => {
    const channel = findChannel(channels, jid);
    if (!channel) throw new Error(`No channel for JID: ${jid}`);
    return channel.sendMessage(jid, text);
  };
  const ipcRequestBotLoginTicket = async (jid: string) => {
    const channel = findChannel(channels, jid);
    if (!(channel instanceof QQBridgeChannel)) {
      throw new Error(`No QQ bridge channel for JID: ${jid}`);
    }
    await channel.requestBotLoginTicket(jid);
  };

  startIpcWatcher({
    sendMessage: ipcSendMessage,
    registeredGroups: () => registeredGroups,
    registerGroup,
    requestBotLoginTicket: ipcRequestBotLoginTicket,
    clearChatContext,
    wipeChatMemory,
    updatePrivateLlmConfig: updatePrivateChatLlmConfig,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    teamTaskDeps: taskManager && groupPool && discussionEngine ? {
      taskManager,
      groupPool,
      discussionEngine,
      sendMessage: ipcSendMessage,
    } : undefined,
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
