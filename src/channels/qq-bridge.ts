import crypto from 'crypto';
import fs from 'fs';
import http, { IncomingMessage, ServerResponse } from 'http';
import path from 'path';

import { z } from 'zod';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { setRegisteredGroup } from '../db.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import {
  NapCatFleetManager,
  type NapCatLoginLifecycleEvent,
  type NapCatLoginLifecycleState,
} from '../napcat-fleet.js';
import {
  generateQrCodePngBase64,
  generateQrCodeSvg,
} from '../qr-code.js';
import {
  isMessageEvent,
  isMetaEvent,
  parseMessageEvent,
  isBotMessage,
  mentionsBot,
  type OneBotMessageEvent,
} from '../onebot-parser.js';
import { Channel, RegisteredGroup } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

const inboundAttachmentSchema = z.object({
  type: z.string().min(1),
  name: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
});

const inboundPayloadSchema = z.object({
  eventId: z.string().min(1).optional(),
  chat: z.object({
    id: z.union([z.string().min(1), z.number()]).transform(String),
    type: z.enum(['private', 'group']),
    name: z.string().min(1).optional(),
  }),
  sender: z.object({
    id: z.union([z.string().min(1), z.number()]).transform(String),
    name: z.string().min(1).optional(),
  }),
  message: z.object({
    id: z
      .union([z.string().min(1), z.number()])
      .transform(String)
      .optional(),
    text: z.string().optional(),
    mentionsSelf: z.boolean().optional(),
    prefixMatched: z.boolean().optional(),
    isFromMe: z.boolean().optional(),
    attachments: z.array(inboundAttachmentSchema).optional(),
  }),
  timestamp: z.string().datetime().optional(),
});

const registerPayloadSchema = z.object({
  chat: z.object({
    id: z.union([z.string().min(1), z.number()]).transform(String),
    type: z.enum(['private', 'group']),
    name: z.string().min(1).optional(),
  }),
  folder: z.string().min(1).optional(),
  requiresTrigger: z.boolean().optional(),
  trigger: z.string().min(1).optional(),
  isMain: z.boolean().optional(),
});

export interface QQBridgeConfig {
  enabled: boolean;
  host: string;
  port: number;
  outboundUrl: string;
  publicBaseUrl?: string;
  sharedSecret?: string;
  commandPrefixes: string[];
  autoRegisterPrivate: boolean;
  autoRegisterGroups: boolean;
  storeUnregisteredGroupMessages: boolean;
  minSendDelayMs: number;
  sendJitterMs: number;
  maxRetries: number;
  baseBackoffMs: number;
}

export interface QQBridgeInboundMessage {
  id: string;
  chatJid: string;
  chatId: string;
  chatType: 'private' | 'group';
  chatName?: string;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: string;
  isFromMe: boolean;
  mentionsSelf: boolean;
  prefixMatched: boolean;
}

export interface QQBridgeRegistration {
  jid: string;
  group: RegisteredGroup;
}

type FetchFn = typeof fetch;

type PrivateBridgeCommand = 'create-bot-account' | 'refresh-bot-account';

interface LoginTicketView {
  id: string;
  svg: string;
  createdAt: string;
  expiresAt: string;
  chatId: string;
  chatJid: string;
  notifiedStates: Set<NapCatLoginLifecycleState>;
}

interface OutboundJob {
  kind: 'message' | 'typing';
  jid: string;
  text?: string;
  isTyping?: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
}

function parseBoolean(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value === undefined) return defaultValue;
  return value === 'true';
}

function parseInteger(
  value: string | undefined,
  defaultValue: number,
  minimum: number,
): number {
  const parsed = Number.parseInt(value || '', 10);
  if (Number.isNaN(parsed)) return defaultValue;
  return Math.max(minimum, parsed);
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function defaultTriggerText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return `@${ASSISTANT_NAME}`;
  }
  if (TRIGGER_PATTERN.test(trimmed)) {
    return trimmed;
  }
  return `@${ASSISTANT_NAME} ${trimmed}`;
}

function formatAttachments(
  attachments: Array<z.infer<typeof inboundAttachmentSchema>> | undefined,
): string {
  if (!attachments || attachments.length === 0) return '';
  return attachments
    .map((attachment) => {
      const label = attachment.name || attachment.type;
      if (attachment.url) {
        return `[Attachment:${attachment.type}] ${label}: ${attachment.url}`;
      }
      return `[Attachment:${attachment.type}] ${label}`;
    })
    .join('\n');
}

function findMatchedPrefix(
  text: string,
  prefixes: string[],
): string | undefined {
  const trimmed = text.trimStart();
  return prefixes.find((prefix) => trimmed.startsWith(prefix));
}

function trimCommandPrefix(text: string, prefix: string): string {
  const trimmed = text.trimStart();
  return trimmed.slice(prefix.length).trimStart();
}

function parsePrivateBridgeCommand(text: string): PrivateBridgeCommand | null {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, '');
  if (!normalized) return null;

  const createPatterns = [
    /^\/?(?:加|添加|新增)(?:机器人|bot)(?:账号)?$/i,
    /^\/?addbot(?:account)?$/i,
  ];
  const refreshPatterns = [
    /^\/?(?:刷新|重发)(?:机器人|bot)(?:二维码|登录码|账号)?$/i,
    /^\/?refreshbot(?:qr|qrcode|account)?$/i,
  ];

  if (createPatterns.some((pattern) => pattern.test(normalized))) {
    return 'create-bot-account';
  }
  if (refreshPatterns.some((pattern) => pattern.test(normalized))) {
    return 'refresh-bot-account';
  }
  return null;
}

export function toQqJid(chatType: 'private' | 'group', chatId: string): string {
  return `qq:${chatType}:${chatId}`;
}

export function parseQqJid(jid: string): {
  platform: 'qq';
  chatType: 'private' | 'group';
  chatId: string;
} {
  const parts = jid.split(':');
  if (parts.length !== 3 || parts[0] !== 'qq') {
    throw new Error(`Invalid QQ JID: ${jid}`);
  }
  const chatType = parts[1];
  if (chatType !== 'private' && chatType !== 'group') {
    throw new Error(`Unsupported QQ chat type: ${jid}`);
  }
  return { platform: 'qq', chatType, chatId: parts[2] };
}

export function createGroupFolder(
  chatType: 'private' | 'group',
  chatId: string,
): string {
  const normalizedChatId = chatId.replace(/[^A-Za-z0-9_-]/g, '_');
  const prefix = chatType === 'private' ? 'qq_private_' : 'qq_group_';
  const base = `${prefix}${normalizedChatId}`;
  if (base.length <= 64) return base;
  const digest = crypto
    .createHash('sha1')
    .update(chatId)
    .digest('hex')
    .slice(0, 12);
  return `${prefix}${digest}`;
}

function createMessageId(payload: {
  eventId?: string;
  messageId?: string;
  chatId: string;
  senderId: string;
  content: string;
  timestamp: string;
}): string {
  if (payload.messageId) return payload.messageId;
  if (payload.eventId) return payload.eventId;
  return crypto
    .createHash('sha1')
    .update(
      [
        payload.chatId,
        payload.senderId,
        payload.timestamp,
        payload.content,
      ].join('|'),
    )
    .digest('hex');
}

export function normalizeInboundMessage(
  payload: z.infer<typeof inboundPayloadSchema>,
  config: QQBridgeConfig,
): QQBridgeInboundMessage {
  const timestamp = payload.timestamp || new Date().toISOString();
  const chatJid = toQqJid(payload.chat.type, payload.chat.id);
  const rawText = payload.message.text?.trim() || '';
  const attachmentsText = formatAttachments(payload.message.attachments);
  const matchedPrefix = findMatchedPrefix(rawText, config.commandPrefixes);
  const prefixMatched = payload.message.prefixMatched || Boolean(matchedPrefix);
  let content = rawText;

  if (payload.chat.type === 'group') {
    if (payload.message.mentionsSelf) {
      content = defaultTriggerText(rawText);
    } else if (matchedPrefix) {
      content = defaultTriggerText(trimCommandPrefix(rawText, matchedPrefix));
    }
  }

  const finalContent = [content.trim(), attachmentsText]
    .filter(Boolean)
    .join('\n\n');

  return {
    id: createMessageId({
      eventId: payload.eventId,
      messageId: payload.message.id,
      chatId: payload.chat.id,
      senderId: payload.sender.id,
      content: finalContent,
      timestamp,
    }),
    chatJid,
    chatId: payload.chat.id,
    chatType: payload.chat.type,
    chatName: payload.chat.name,
    senderId: payload.sender.id,
    senderName: payload.sender.name || payload.sender.id,
    content: finalContent,
    timestamp,
    isFromMe: payload.message.isFromMe || false,
    mentionsSelf: payload.message.mentionsSelf || false,
    prefixMatched,
  };
}

function createRegisteredGroup(
  chatType: 'private' | 'group',
  chatId: string,
  name: string | undefined,
  overrides?: {
    folder?: string;
    requiresTrigger?: boolean;
    trigger?: string;
    isMain?: boolean;
  },
): RegisteredGroup {
  const defaultRequiresTrigger = chatType === 'group';
  return {
    name: name || `QQ ${chatType} ${chatId}`,
    folder: overrides?.folder || createGroupFolder(chatType, chatId),
    trigger: overrides?.trigger || `@${ASSISTANT_NAME}`,
    added_at: new Date().toISOString(),
    requiresTrigger:
      overrides?.requiresTrigger === undefined
        ? defaultRequiresTrigger
        : overrides.requiresTrigger,
    isMain: overrides?.isMain,
  };
}

function ensureGroupFiles(group: RegisteredGroup, jid: string): void {
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  const claudePath = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(claudePath)) {
    const content = [
      '# QQ Chat Context',
      '',
      `- Chat JID: ${jid}`,
      `- Trigger: ${group.trigger}`,
      `- Requires trigger: ${group.requiresTrigger === false ? 'no' : 'yes'}`,
    ].join('\n');
    fs.writeFileSync(claudePath, content);
  }
}

function jsonResponse(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

function shouldRetry(status: number): boolean {
  return (
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(maxJitterMs: number): number {
  if (maxJitterMs <= 0) return 0;
  return Math.floor(Math.random() * maxJitterMs);
}

export class OutboundDispatcher {
  private readonly queue: OutboundJob[] = [];
  private draining = false;

  constructor(
    private readonly config: QQBridgeConfig,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  enqueue(job: Omit<OutboundJob, 'resolve' | 'reject'>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ ...job, resolve, reject });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      try {
        await this.dispatch(job);
        job.resolve();
      } catch (error) {
        job.reject(error as Error);
      }
    }

    this.draining = false;
  }

  private async dispatch(job: OutboundJob): Promise<void> {
    const parsed = parseQqJid(job.jid);
    let attempt = 0;

    while (attempt <= this.config.maxRetries) {
      attempt += 1;

      if (attempt === 1) {
        await sleep(
          this.config.minSendDelayMs + jitter(this.config.sendJitterMs),
        );
      } else {
        const backoff =
          this.config.baseBackoffMs * Math.pow(2, attempt - 2) +
          jitter(this.config.sendJitterMs);
        await sleep(backoff);
      }

      const payload =
        job.kind === 'typing'
          ? {
              source: 'nanoclaw',
              deliveryId: crypto.randomUUID(),
              event: 'typing',
              chat: { id: parsed.chatId, type: parsed.chatType },
              typing: { active: job.isTyping || false },
              attempt,
              timestamp: new Date().toISOString(),
            }
          : {
              source: 'nanoclaw',
              deliveryId: crypto.randomUUID(),
              event: 'message',
              chat: { id: parsed.chatId, type: parsed.chatType },
              message: { text: job.text || '' },
              attempt,
              timestamp: new Date().toISOString(),
            };

      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (this.config.sharedSecret) {
        headers['x-qq-bridge-secret'] = this.config.sharedSecret;
      }

      const response = await this.fetchFn(this.config.outboundUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        return;
      }

      if (!shouldRetry(response.status) || attempt > this.config.maxRetries) {
        const body = await response.text();
        throw new Error(
          `QQ bridge outbound request failed with status ${response.status}: ${body}`,
        );
      }
    }
  }
}

export class QQBridgeChannel implements Channel {
  name = 'qq-bridge';

  private server: http.Server | null = null;
  private boundPort: number | null = null;
  private readonly dispatcher: OutboundDispatcher;
  private fleetManager: NapCatFleetManager | null = null;
  private loginTickets = new Map<string, LoginTicketView>();
  /** Sliding window of recently seen message IDs for dedup (OneBot multi-bot scenario). */
  private recentMessageIds = new Set<string>();
  private messageIdOrder: string[] = [];
  private static readonly DEDUP_WINDOW = 1000;
  private static readonly LOGIN_TICKET_TTL_MS = 10 * 60 * 1000;

  constructor(
    private readonly config: QQBridgeConfig,
    private readonly opts: ChannelOpts,
    fetchFn?: FetchFn,
  ) {
    this.dispatcher = new OutboundDispatcher(config, fetchFn);
  }

  /**
   * Attach fleet manager for multi-account sending.
   */
  setFleetManager(manager: NapCatFleetManager): void {
    this.fleetManager = manager;
  }

  private cleanupLoginTickets(): void {
    const now = Date.now();
    for (const [ticketId, ticket] of this.loginTickets.entries()) {
      if (Date.parse(ticket.expiresAt) <= now) {
        this.loginTickets.delete(ticketId);
      }
    }
  }

  private resolvePublicBaseUrl(): string | null {
    if (this.config.publicBaseUrl) {
      return this.config.publicBaseUrl.replace(/\/$/, '');
    }

    const host = this.config.host;
    const port = this.boundPort || this.config.port;
    if (!host || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1') {
      return null;
    }
    return `http://${host}:${port}`;
  }

  private buildTicketPreviewUrl(ticketId: string): string | null {
    const baseUrl = this.resolvePublicBaseUrl();
    if (!baseUrl) return null;
    return `${baseUrl}/qq-bridge/bot-login/${encodeURIComponent(ticketId)}`;
  }

  private formatLoginTicketLifecycleMessage(
    ticket: LoginTicketView,
    event: NapCatLoginLifecycleEvent,
  ): string {
    const expiresAtText = new Date(event.expiresAt).toLocaleString('zh-CN', {
      hour12: false,
    });
    const previewUrl = this.buildTicketPreviewUrl(ticket.id);

    switch (event.state) {
      case 'qr_ready': {
        const lines = [
          '✅ 已生成新的机器人登录二维码。',
          `会话ID：${event.ticketId}`,
          `二维码有效期至：${expiresAtText}`,
          '如果二维码过期，请重新私聊发送“刷新机器人二维码”。',
        ];
        if (previewUrl) {
          lines.push(`备用预览地址：${previewUrl}`);
        }
        return lines.join('\n');
      }
      case 'scanned':
        return [
          '📱 二维码已扫码，等待手机确认。',
          `会话ID：${event.ticketId}`,
        ].join('\n');
      case 'success': {
        const lines = ['✅ 新账号已接入机器人账号池。'];
        if (event.qqAccount) {
          lines.push(`QQ号：${event.qqAccount}`);
        }
        if (event.nickname) {
          lines.push(`昵称：${event.nickname}`);
        }
        return lines.join('\n');
      }
      case 'expired':
        return [
          '⌛ 二维码已过期。',
          '请重新私聊发送“刷新机器人二维码”获取新的登录二维码。',
        ].join('\n');
      case 'failed':
        return `⚠️ 登录失败：${event.reason || '未知错误'}`;
      default:
        return '⚠️ 登录状态已更新。';
    }
  }

  private async handleLoginTicketLifecycleEvent(
    event: NapCatLoginLifecycleEvent,
  ): Promise<void> {
    this.cleanupLoginTickets();
    const ticket = this.loginTickets.get(event.ticketId);
    if (!ticket) {
      return;
    }
    if (ticket.notifiedStates.has(event.state)) {
      return;
    }

    ticket.notifiedStates.add(event.state);
    await this.sendMessage(
      ticket.chatJid,
      this.formatLoginTicketLifecycleMessage(ticket, event),
    );
  }

  private async sendBotLoginTicket(
    chatId: string,
    chatJid: string,
  ): Promise<void> {
    if (!this.fleetManager) {
      await this.sendMessage(
        chatJid,
        '⚠️ 当前没有启用 NapCat 账号池，暂时无法扫码新增机器人账号。',
      );
      return;
    }

    try {
      const bufferedEvents: NapCatLoginLifecycleEvent[] = [];
      const ticket = await this.fleetManager.createAgentLoginTicket({
        onEvent: async (event) => {
          if (!this.loginTickets.has(event.ticketId)) {
            bufferedEvents.push(event);
            return;
          }
          await this.handleLoginTicketLifecycleEvent(event);
        },
      });
      const svg = await generateQrCodeSvg(ticket.qrCodeText);
      const pngBase64 = await generateQrCodePngBase64(ticket.qrCodeText);
      this.loginTickets.set(ticket.id, {
        id: ticket.id,
        svg,
        createdAt: ticket.createdAt,
        expiresAt: ticket.expiresAt,
        chatId,
        chatJid,
        notifiedStates: new Set<NapCatLoginLifecycleState>(),
      });
      this.cleanupLoginTickets();

      if (bufferedEvents.length === 0) {
        bufferedEvents.push({
          ticketId: ticket.id,
          state: 'qr_ready',
          role: ticket.role,
          occurredAt: new Date().toISOString(),
          createdAt: ticket.createdAt,
          expiresAt: ticket.expiresAt,
        });
      }

      for (const event of bufferedEvents) {
        await this.handleLoginTicketLifecycleEvent(event);
      }

      const mainConnector = this.fleetManager.getMainConnector();
      if (mainConnector) {
        try {
          await mainConnector.sendPrivateImageBase64(chatId, pngBase64);
        } catch (error) {
          logger.warn({ err: error, chatId }, 'Failed to send bot login QR image');
        }
      }
    } catch (error) {
      await this.sendMessage(
        chatJid,
        `⚠️ 新建机器人账号登录会话失败：${error instanceof Error ? error.message : '未知错误'}`,
      );
    }
  }

  private async maybeHandlePrivateBridgeCommand(payload: {
    chatId: string;
    chatJid: string;
    chatType: 'private' | 'group';
    content: string;
  }): Promise<boolean> {
    if (payload.chatType !== 'private') return false;

    const command = parsePrivateBridgeCommand(payload.content);
    if (!command) return false;

    if (!this.fleetManager) {
      await this.sendMessage(
        payload.chatJid,
        '⚠️ 当前未接入 NapCat 多账号管理，无法为你创建新的机器人登录二维码。',
      );
      return true;
    }

    if (command === 'create-bot-account' || command === 'refresh-bot-account') {
      await this.sendBotLoginTicket(payload.chatId, payload.chatJid);
      return true;
    }

    return false;
  }

  /**
   * Send a message as a specific QQ account via the fleet manager.
   * Falls back to the default outbound dispatcher if fleet is not available.
   */
  async sendAsAccount(groupId: string, qqAccount: string, text: string): Promise<void> {
    if (!this.fleetManager) {
      // Fallback to default outbound
      const jid = toQqJid('group', groupId);
      return this.sendMessage(jid, text);
    }

    const connector = this.fleetManager.getConnector(qqAccount);
    if (!connector) {
      logger.warn({ qqAccount, groupId }, 'No connector for QQ account, falling back to default');
      const jid = toQqJid('group', groupId);
      return this.sendMessage(jid, text);
    }

    await connector.sendGroupMsg(groupId, text);
  }

  private isDuplicate(messageId: string): boolean {
    if (this.recentMessageIds.has(messageId)) return true;
    this.recentMessageIds.add(messageId);
    this.messageIdOrder.push(messageId);
    while (this.messageIdOrder.length > QQBridgeChannel.DEDUP_WINDOW) {
      const old = this.messageIdOrder.shift()!;
      this.recentMessageIds.delete(old);
    }
    return false;
  }

  async connect(): Promise<void> {
    if (this.server) return;
    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.config.port, this.config.host, () => {
        const address = this.server!.address();
        if (address && typeof address !== 'string') {
          this.boundPort = address.port;
        }
        resolve();
      });
    });

    logger.info(
      { host: this.config.host, port: this.boundPort || this.config.port },
      'QQ bridge channel listening',
    );
  }

  async disconnect(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    this.server = null;
    this.boundPort = null;
  }

  isConnected(): boolean {
    return Boolean(this.server?.listening);
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('qq:');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // If fleet manager is available, send directly via NapCat connector
    if (this.fleetManager) {
      const parsed = parseQqJid(jid);
      const mainConnector = this.fleetManager.getMainConnector();
      if (mainConnector) {
        if (parsed.chatType === 'group') {
          await mainConnector.sendGroupMsg(parsed.chatId, text);
        } else {
          await mainConnector.sendPrivateMsg(parsed.chatId, text);
        }
        return;
      }
    }
    // Fallback to outbound dispatcher
    return this.dispatcher.enqueue({ kind: 'message', jid, text });
  }

  setTyping(jid: string, isTyping: boolean): Promise<void> {
    return this.dispatcher.enqueue({ kind: 'typing', jid, isTyping });
  }

  getPort(): number | null {
    return this.boundPort;
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(
        request.url || '/',
        `http://${request.headers.host || '127.0.0.1'}`,
      );

      if (request.url === '/healthz' && request.method === 'GET') {
        jsonResponse(response, 200, { ok: true, channel: this.name });
        return;
      }

      const ticketMatch = url.pathname.match(/^\/qq-bridge\/bot-login\/([^/]+?)(\.svg)?$/);
      if (ticketMatch && request.method === 'GET') {
        this.cleanupLoginTickets();
        const ticketId = decodeURIComponent(ticketMatch[1]!);
        const ticket = this.loginTickets.get(ticketId);
        if (!ticket) {
          response.statusCode = 404;
          response.setHeader('content-type', 'text/plain; charset=utf-8');
          response.end('QR ticket not found or expired');
          return;
        }

        if (ticketMatch[2] === '.svg') {
          response.statusCode = 200;
          response.setHeader('content-type', 'image/svg+xml; charset=utf-8');
          response.end(ticket.svg);
          return;
        }

        response.statusCode = 200;
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>机器人账号登录二维码</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 24px; color: #111827; background: #f9fafb; }
      main { max-width: 420px; margin: 0 auto; background: #fff; border-radius: 16px; padding: 24px; box-shadow: 0 10px 30px rgba(0,0,0,.08); }
      h1 { font-size: 20px; margin: 0 0 12px; }
      p { line-height: 1.6; }
      .qr { margin: 20px 0; display: flex; justify-content: center; }
      .meta { color: #4b5563; font-size: 14px; }
    </style>
  </head>
  <body>
    <main>
      <h1>机器人账号登录二维码</h1>
      <p>请使用要接入的新 QQ 账号扫码登录。扫码成功后，系统会自动将该账号纳入 Agent 池。</p>
      <div class="qr">${ticket.svg}</div>
      <p class="meta">会话ID：${ticket.id}</p>
      <p class="meta">创建时间：${new Date(ticket.createdAt).toLocaleString('zh-CN', { hour12: false })}</p>
      <p class="meta">失效时间：${new Date(ticket.expiresAt).toLocaleString('zh-CN', { hour12: false })}</p>
    </main>
  </body>
</html>`);
        return;
      }

      if (this.config.sharedSecret) {
        const secret = request.headers['x-qq-bridge-secret'];
        if (secret !== this.config.sharedSecret) {
          jsonResponse(response, 401, { ok: false, error: 'invalid_secret' });
          return;
        }
      }

      if (url.pathname === '/qq-bridge/inbound' && request.method === 'POST') {
        const rawBody = await readJsonBody(request);
        const raw = rawBody as Record<string, unknown>;

        // Detect raw OneBot v11 events (NapCat direct reporting)
        if (raw.post_type) {
          const onebotResult = await this.acceptOneBotEvent(raw);
          jsonResponse(response, 200, onebotResult);
          return;
        }

        // Normalized format (external bridge)
        const payload = inboundPayloadSchema.parse(rawBody);
        const result = await this.acceptInbound(payload);
        jsonResponse(response, 200, {
          ok: true,
          accepted: result.accepted,
          registered: result.registered,
          chatJid: result.chatJid,
        });
        return;
      }

      if (
        url.pathname === '/qq-bridge/chats/register' &&
        request.method === 'POST'
      ) {
        const rawBody = await readJsonBody(request);
        const payload = registerPayloadSchema.parse(rawBody);
        const registration = this.ensureRegisteredGroup(
          payload.chat.type,
          payload.chat.id,
          payload.chat.name,
          {
            folder: payload.folder,
            requiresTrigger: payload.requiresTrigger,
            trigger: payload.trigger,
            isMain: payload.isMain,
          },
        );
        this.opts.onChatMetadata(
          registration.jid,
          new Date().toISOString(),
          registration.group.name,
          'qq',
          payload.chat.type === 'group',
        );
        jsonResponse(response, 200, {
          ok: true,
          jid: registration.jid,
          folder: registration.group.folder,
          requiresTrigger: registration.group.requiresTrigger !== false,
        });
        return;
      }

      if (url.pathname === '/qq-bridge/chats' && request.method === 'GET') {
        const groups = Object.entries(this.opts.registeredGroups())
          .filter(([jid]) => jid.startsWith('qq:'))
          .map(([jid, group]) => ({ jid, ...group }));
        jsonResponse(response, 200, { ok: true, chats: groups });
        return;
      }

      jsonResponse(response, 404, { ok: false, error: 'not_found' });
    } catch (error) {
      logger.warn({ err: error }, 'QQ bridge request failed');
      jsonResponse(response, 400, {
        ok: false,
        error: error instanceof Error ? error.message : 'invalid_request',
      });
    }
  }

  /**
   * Handle raw OneBot v11 events from NapCat HTTP reporting.
   * Bot messages are NOT stored into the main messages table to prevent feedback loops.
   * Only processes messages from the main bot account to avoid duplicates.
   */
  private async acceptOneBotEvent(
    raw: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // Ignore meta events (heartbeat, lifecycle)
    if (isMetaEvent(raw)) {
      return { ok: true, action: 'ignored', reason: 'meta_event' };
    }

    // Only handle message events
    if (!isMessageEvent(raw)) {
      return { ok: true, action: 'ignored', reason: 'not_message' };
    }

    const event = raw as unknown as OneBotMessageEvent;
    const parsed = parseMessageEvent(event);
    const botAccounts = this.fleetManager?.getAllBotAccounts() ?? new Set<string>();
    const mainAccount = this.fleetManager?.getMainAccount();

    // Dedup: Only process from main bot instance to avoid N copies of each message
    if (mainAccount && parsed.selfId !== mainAccount) {
      return { ok: true, action: 'ignored', reason: 'non_main_receiver' };
    }

    // Message dedup by message_id
    if (this.isDuplicate(parsed.messageId)) {
      return { ok: true, action: 'ignored', reason: 'duplicate' };
    }

    // If message is from a bot account, do NOT store in main messages table
    if (isBotMessage(event, botAccounts)) {
      return { ok: true, action: 'ignored', reason: 'bot_message' };
    }

    // Convert to normalized format and process
    const chatType = parsed.messageType;
    const chatId = chatType === 'group' ? parsed.groupId! : parsed.userId;
    const chatJid = toQqJid(chatType, chatId);
    const chatName = chatType === 'group' ? `QQ群 ${chatId}` : parsed.nickname;

    // Check if bot is mentioned (for trigger)
    const botMentioned = mentionsBot(event, botAccounts);

    this.opts.onChatMetadata(
      chatJid,
      parsed.timestamp,
      chatName,
      'qq',
      chatType === 'group',
    );

    const isRegistered = Boolean(this.opts.registeredGroups()[chatJid]);
    const shouldAutoRegister =
      chatType === 'private'
        ? this.config.autoRegisterPrivate
        : this.config.autoRegisterGroups;

    let registered = isRegistered;
    if (!registered && shouldAutoRegister) {
      this.ensureRegisteredGroup(chatType, chatId, chatName);
      registered = true;
    }

    const shouldStoreMessage =
      registered ||
      chatType === 'private' ||
      this.config.storeUnregisteredGroupMessages;

    if (!shouldStoreMessage) {
      return { ok: true, action: 'skipped', reason: 'not_registered' };
    }

    // Build content with trigger if mentioned
    let content = parsed.content;
    if (chatType === 'group' && botMentioned) {
      content = defaultTriggerText(content);
    }

    const handled = await this.maybeHandlePrivateBridgeCommand({
      chatId,
      chatJid,
      chatType,
      content,
    });
    if (handled) {
      return { ok: true, action: 'handled', reason: 'private_command' };
    }

    this.opts.onMessage(chatJid, {
      id: parsed.messageId,
      chat_jid: chatJid,
      sender: parsed.userId,
      sender_name: parsed.nickname,
      content,
      timestamp: parsed.timestamp,
      is_from_me: false,
      is_bot_message: false,
    });

    return { ok: true, action: 'accepted', chatJid };
  }

  private async acceptInbound(
    payload: z.infer<typeof inboundPayloadSchema>,
  ): Promise<{
    accepted: boolean;
    registered: boolean;
    chatJid: string;
  }> {
    const normalized = normalizeInboundMessage(payload, this.config);
    this.opts.onChatMetadata(
      normalized.chatJid,
      normalized.timestamp,
      normalized.chatName,
      'qq',
      normalized.chatType === 'group',
    );

    const isRegistered = Boolean(
      this.opts.registeredGroups()[normalized.chatJid],
    );
    const shouldAutoRegister =
      normalized.chatType === 'private'
        ? this.config.autoRegisterPrivate
        : this.config.autoRegisterGroups;

    let registered = isRegistered;
    if (!registered && shouldAutoRegister) {
      this.ensureRegisteredGroup(
        normalized.chatType,
        normalized.chatId,
        normalized.chatName,
      );
      registered = true;
    }

    const shouldStoreMessage =
      registered ||
      normalized.chatType === 'private' ||
      this.config.storeUnregisteredGroupMessages;

    if (!shouldStoreMessage) {
      return {
        accepted: false,
        registered,
        chatJid: normalized.chatJid,
      };
    }

    const handled = await this.maybeHandlePrivateBridgeCommand({
      chatId: normalized.chatId,
      chatJid: normalized.chatJid,
      chatType: normalized.chatType,
      content: normalized.content,
    });
    if (handled) {
      return {
        accepted: true,
        registered,
        chatJid: normalized.chatJid,
      };
    }

    this.opts.onMessage(normalized.chatJid, {
      id: normalized.id,
      chat_jid: normalized.chatJid,
      sender: normalized.senderId,
      sender_name: normalized.senderName,
      content: normalized.content,
      timestamp: normalized.timestamp,
      is_from_me: normalized.isFromMe,
      is_bot_message: normalized.isFromMe,
    });

    return {
      accepted: true,
      registered,
      chatJid: normalized.chatJid,
    };
  }

  private ensureRegisteredGroup(
    chatType: 'private' | 'group',
    chatId: string,
    chatName?: string,
    overrides?: {
      folder?: string;
      requiresTrigger?: boolean;
      trigger?: string;
      isMain?: boolean;
    },
  ): QQBridgeRegistration {
    const jid = toQqJid(chatType, chatId);
    const existing = this.opts.registeredGroups()[jid];
    if (existing) {
      return { jid, group: existing };
    }

    const group = createRegisteredGroup(chatType, chatId, chatName, overrides);
    this.opts.registeredGroups()[jid] = group;
    setRegisteredGroup(jid, group);
    ensureGroupFiles(group, jid);

    logger.info({ jid, folder: group.folder }, 'Registered QQ bridge chat');
    return { jid, group };
  }
}

export function loadQQBridgeConfig(): QQBridgeConfig {
  const env = readEnvFile([
    'QQ_BRIDGE_ENABLED',
    'QQ_BRIDGE_HOST',
    'QQ_BRIDGE_PORT',
    'QQ_BRIDGE_OUTBOUND_URL',
    'QQ_BRIDGE_PUBLIC_BASE_URL',
    'QQ_BRIDGE_SHARED_SECRET',
    'QQ_BRIDGE_COMMAND_PREFIXES',
    'QQ_BRIDGE_AUTO_REGISTER_PRIVATE',
    'QQ_BRIDGE_AUTO_REGISTER_GROUPS',
    'QQ_BRIDGE_STORE_UNREGISTERED_GROUP_MESSAGES',
    'QQ_BRIDGE_MIN_SEND_DELAY_MS',
    'QQ_BRIDGE_SEND_JITTER_MS',
    'QQ_BRIDGE_MAX_RETRIES',
    'QQ_BRIDGE_BASE_BACKOFF_MS',
  ]);

  return {
    enabled: parseBoolean(
      process.env.QQ_BRIDGE_ENABLED || env.QQ_BRIDGE_ENABLED,
      true,
    ),
    host: process.env.QQ_BRIDGE_HOST || env.QQ_BRIDGE_HOST || '127.0.0.1',
    port: parseInteger(
      process.env.QQ_BRIDGE_PORT || env.QQ_BRIDGE_PORT,
      8787,
      1,
    ),
    outboundUrl:
      process.env.QQ_BRIDGE_OUTBOUND_URL || env.QQ_BRIDGE_OUTBOUND_URL || '',
    publicBaseUrl:
      process.env.QQ_BRIDGE_PUBLIC_BASE_URL ||
      env.QQ_BRIDGE_PUBLIC_BASE_URL ||
      undefined,
    sharedSecret:
      process.env.QQ_BRIDGE_SHARED_SECRET ||
      env.QQ_BRIDGE_SHARED_SECRET ||
      undefined,
    commandPrefixes: parseList(
      process.env.QQ_BRIDGE_COMMAND_PREFIXES || env.QQ_BRIDGE_COMMAND_PREFIXES,
    ),
    autoRegisterPrivate: parseBoolean(
      process.env.QQ_BRIDGE_AUTO_REGISTER_PRIVATE ||
        env.QQ_BRIDGE_AUTO_REGISTER_PRIVATE,
      true,
    ),
    autoRegisterGroups: parseBoolean(
      process.env.QQ_BRIDGE_AUTO_REGISTER_GROUPS ||
        env.QQ_BRIDGE_AUTO_REGISTER_GROUPS,
      false,
    ),
    storeUnregisteredGroupMessages: parseBoolean(
      process.env.QQ_BRIDGE_STORE_UNREGISTERED_GROUP_MESSAGES ||
        env.QQ_BRIDGE_STORE_UNREGISTERED_GROUP_MESSAGES,
      false,
    ),
    minSendDelayMs: parseInteger(
      process.env.QQ_BRIDGE_MIN_SEND_DELAY_MS ||
        env.QQ_BRIDGE_MIN_SEND_DELAY_MS,
      1200,
      0,
    ),
    sendJitterMs: parseInteger(
      process.env.QQ_BRIDGE_SEND_JITTER_MS || env.QQ_BRIDGE_SEND_JITTER_MS,
      400,
      0,
    ),
    maxRetries: parseInteger(
      process.env.QQ_BRIDGE_MAX_RETRIES || env.QQ_BRIDGE_MAX_RETRIES,
      3,
      0,
    ),
    baseBackoffMs: parseInteger(
      process.env.QQ_BRIDGE_BASE_BACKOFF_MS || env.QQ_BRIDGE_BASE_BACKOFF_MS,
      2000,
      0,
    ),
  };
}

registerChannel('qq-bridge', (opts) => {
  const config = loadQQBridgeConfig();
  if (!config.enabled) return null;
  if (!config.outboundUrl) {
    logger.warn('QQ bridge enabled but QQ_BRIDGE_OUTBOUND_URL is missing');
    return null;
  }
  return new QQBridgeChannel(config, opts);
});
