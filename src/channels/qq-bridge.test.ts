import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, getRegisteredGroup } from '../db.js';
import {
  createGroupFolder,
  normalizeInboundMessage,
  OutboundDispatcher,
  QQBridgeChannel,
  QQBridgeConfig,
  toQqJid,
} from './qq-bridge.js';

function createConfig(overrides: Partial<QQBridgeConfig> = {}): QQBridgeConfig {
  return {
    enabled: true,
    host: '127.0.0.1',
    port: 0,
    outboundUrl: 'http://127.0.0.1:39999/outbound',
    sharedSecret: 'test-secret',
    commandPrefixes: ['/ai', '#ai'],
    autoRegisterPrivate: true,
    autoRegisterGroups: false,
    storeUnregisteredGroupMessages: false,
    minSendDelayMs: 0,
    sendJitterMs: 0,
    maxRetries: 2,
    baseBackoffMs: 1,
    ...overrides,
  };
}

function createOpts() {
  const groups: Record<string, any> = {};
  return {
    opts: {
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => groups,
    },
    groups,
  };
}

describe('qq-bridge helpers', () => {
  it('normalizes group mention to NanoClaw trigger', () => {
    const normalized = normalizeInboundMessage(
      {
        chat: { id: '10001', type: 'group', name: 'Test Group' },
        sender: { id: '20001', name: 'Alice' },
        message: { text: '帮我总结一下', mentionsSelf: true },
      },
      createConfig(),
    );

    expect(normalized.chatJid).toBe('qq:group:10001');
    expect(normalized.content).toBe('@Andy 帮我总结一下');
  });

  it('normalizes explicit command prefix to NanoClaw trigger', () => {
    const normalized = normalizeInboundMessage(
      {
        chat: { id: '10001', type: 'group', name: 'Test Group' },
        sender: { id: '20001', name: 'Alice' },
        message: { text: '/ai 帮我看下日志' },
      },
      createConfig(),
    );

    expect(normalized.content).toBe('@Andy 帮我看下日志');
  });

  it('appends attachments to inbound content', () => {
    const normalized = normalizeInboundMessage(
      {
        chat: { id: '3', type: 'private', name: 'DM' },
        sender: { id: '9', name: 'Bob' },
        message: {
          text: '看这个',
          attachments: [
            { type: 'image', name: 'foo.png', url: 'https://a.test/foo.png' },
          ],
        },
      },
      createConfig(),
    );

    expect(normalized.content).toContain('看这个');
    expect(normalized.content).toContain(
      '[Attachment:image] foo.png: https://a.test/foo.png',
    );
  });

  it('creates deterministic QQ folders', () => {
    expect(createGroupFolder('private', '123456')).toBe('qq_private_123456');
    expect(createGroupFolder('group', 'abcdef')).toBe('qq_group_abcdef');
  });
});

describe('OutboundDispatcher', () => {
  it('retries retryable responses before succeeding', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 429 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const dispatcher = new OutboundDispatcher(
      createConfig(),
      fetchMock as typeof fetch,
    );

    await dispatcher.enqueue({
      kind: 'message',
      jid: 'qq:group:123',
      text: 'hello',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails immediately on non-retryable response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('bad request', { status: 400 }));
    const dispatcher = new OutboundDispatcher(
      createConfig(),
      fetchMock as typeof fetch,
    );

    await expect(
      dispatcher.enqueue({
        kind: 'message',
        jid: 'qq:group:123',
        text: 'hello',
      }),
    ).rejects.toThrow('400');
  });
});

describe('QQBridgeChannel', () => {
  const originalCwd = process.cwd();
  const cleanupFolders = ['qq_private_1000', 'qq_group_3000'];

  beforeEach(() => {
    _initTestDatabase();
    for (const folder of cleanupFolders) {
      fs.rmSync(path.join(originalCwd, 'groups', folder), {
        recursive: true,
        force: true,
      });
    }
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    for (const folder of cleanupFolders) {
      fs.rmSync(path.join(originalCwd, 'groups', folder), {
        recursive: true,
        force: true,
      });
    }
    vi.restoreAllMocks();
  });

  it('auto-registers private chats and stores inbound messages', async () => {
    const { opts, groups } = createOpts();
    const channel = new QQBridgeChannel(
      createConfig(),
      opts,
      vi
        .fn()
        .mockResolvedValue(new Response('{}', { status: 200 })) as typeof fetch,
    );

    await channel.connect();
    const port = channel.getPort();
    expect(port).not.toBeNull();

    const response = await fetch(`http://127.0.0.1:${port}/qq-bridge/inbound`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-qq-bridge-secret': 'test-secret',
      },
      body: JSON.stringify({
        chat: { id: '1000', type: 'private', name: 'Alice' },
        sender: { id: '2000', name: 'Alice' },
        message: { text: '你好' },
      }),
    });

    const body = (await response.json()) as {
      accepted: boolean;
      registered: boolean;
    };
    expect(response.status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(body.registered).toBe(true);
    expect(groups[toQqJid('private', '1000')]).toBeTruthy();
    expect(opts.onMessage).toHaveBeenCalledTimes(1);
    expect(
      getRegisteredGroup(toQqJid('private', '1000'))?.requiresTrigger,
    ).toBe(false);

    await channel.disconnect();
  });

  it('drops unregistered group messages by default', async () => {
    const { opts, groups } = createOpts();
    const channel = new QQBridgeChannel(
      createConfig(),
      opts,
      vi
        .fn()
        .mockResolvedValue(new Response('{}', { status: 200 })) as typeof fetch,
    );

    await channel.connect();
    const port = channel.getPort();

    const response = await fetch(`http://127.0.0.1:${port}/qq-bridge/inbound`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-qq-bridge-secret': 'test-secret',
      },
      body: JSON.stringify({
        chat: { id: '1001', type: 'group', name: 'Test Group' },
        sender: { id: '2001', name: 'Alice' },
        message: { text: 'hello all' },
      }),
    });

    const body = (await response.json()) as {
      accepted: boolean;
      registered: boolean;
    };
    expect(body.accepted).toBe(false);
    expect(body.registered).toBe(false);
    expect(groups[toQqJid('group', '1001')]).toBeUndefined();
    expect(opts.onMessage).not.toHaveBeenCalled();

    await channel.disconnect();
  });

  it('registers groups via management endpoint', async () => {
    const { opts } = createOpts();
    const channel = new QQBridgeChannel(
      createConfig(),
      opts,
      vi
        .fn()
        .mockResolvedValue(new Response('{}', { status: 200 })) as typeof fetch,
    );

    await channel.connect();
    const port = channel.getPort();

    const response = await fetch(
      `http://127.0.0.1:${port}/qq-bridge/chats/register`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-qq-bridge-secret': 'test-secret',
        },
        body: JSON.stringify({
          chat: { id: '3000', type: 'group', name: 'Ops' },
          requiresTrigger: true,
        }),
      },
    );

    const body = (await response.json()) as { ok: boolean; folder: string };
    expect(body.ok).toBe(true);
    expect(body.folder).toBe('qq_group_3000');
    expect(getRegisteredGroup('qq:group:3000')?.folder).toBe('qq_group_3000');

    await channel.disconnect();
  });

  it('handles private add-bot-account command and returns qr ticket', async () => {
    const { opts } = createOpts();
    const channel = new QQBridgeChannel(
      createConfig({ publicBaseUrl: 'https://bot.example.com' }),
      opts,
      fetch,
    );

    const privateTexts: Array<{ userId: string; text: string }> = [];
    const privateImages: Array<{ userId: string; base64: string }> = [];
    const sendPrivateMsg = async (userId: string, text: string) => {
      privateTexts.push({ userId, text });
      return { retcode: 0, status: 'ok' };
    };
    const sendPrivateImageBase64 = async (userId: string, base64: string) => {
      privateImages.push({ userId, base64 });
      return { retcode: 0, status: 'ok' };
    };
    const createAgentLoginTicket = async (options?: any) => {
      await options?.onEvent?.({
        ticketId: 'ticket-1',
        state: 'qr_ready',
        role: 'agent',
        occurredAt: '2026-03-07T23:50:01.000Z',
        createdAt: '2026-03-07T23:50:00.000Z',
        expiresAt: '2026-03-08T00:10:00.000Z',
      });
      return {
        id: 'ticket-1',
        role: 'agent',
        qrCodeText: 'https://example.com/login?token=abc',
        createdAt: '2026-03-07T23:50:00.000Z',
        expiresAt: '2026-03-08T00:10:00.000Z',
      };
    };

    channel.setFleetManager({
      createAgentLoginTicket,
      getMainConnector: () => ({
        sendPrivateMsg,
        sendPrivateImageBase64,
      }),
    } as any);

    await channel.connect();
    const port = channel.getPort();

    const response = await fetch(`http://127.0.0.1:${port}/qq-bridge/inbound`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-qq-bridge-secret': 'test-secret',
      },
      body: JSON.stringify({
        chat: { id: '1000', type: 'private', name: 'Alice' },
        sender: { id: '2000', name: 'Alice' },
        message: { text: '加机器人账号' },
      }),
    });

    const body = (await response.json()) as {
      accepted: boolean;
      registered: boolean;
    };
    expect(response.status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(body.registered).toBe(true);
    expect(opts.onMessage).not.toHaveBeenCalled();
    expect(privateTexts).toHaveLength(1);
    expect(privateTexts[0]?.userId).toBe('1000');
    expect(privateTexts[0]?.text).toContain('已生成新的机器人登录二维码');
    expect(privateTexts[0]?.text).toContain(
      '备用预览地址：https://bot.example.com/qq-bridge/bot-login/ticket-1',
    );
    expect(privateImages).toHaveLength(1);
    expect(privateImages[0]?.userId).toBe('1000');

    const qrResponse = await fetch(
      `http://127.0.0.1:${port}/qq-bridge/bot-login/ticket-1.svg`,
    );
    const qrBody = await qrResponse.text();
    expect(qrResponse.status).toBe(200);
    expect(qrBody).toContain('<svg');

    await channel.disconnect();
  });

  it('only notifies the requesting private chat once per lifecycle state', async () => {
    const { opts } = createOpts();
    const channel = new QQBridgeChannel(
      createConfig({ publicBaseUrl: 'https://bot.example.com' }),
      opts,
      fetch,
    );

    const privateTexts: Array<{ userId: string; text: string }> = [];
    const privateImages: Array<{ userId: string; base64: string }> = [];
    const sendPrivateMsg = async (userId: string, text: string) => {
      privateTexts.push({ userId, text });
      return { retcode: 0, status: 'ok' };
    };
    const sendPrivateImageBase64 = async (userId: string, base64: string) => {
      privateImages.push({ userId, base64 });
      return { retcode: 0, status: 'ok' };
    };
    let onEvent:
      | ((event: {
          ticketId: string;
          state: string;
          role: string;
          occurredAt: string;
          createdAt: string;
          expiresAt: string;
          qqAccount?: string;
          nickname?: string;
          reason?: string;
        }) => Promise<void>)
      | undefined;

    channel.setFleetManager({
      createAgentLoginTicket: async (options?: any) => {
        onEvent = options?.onEvent;
        return {
          id: 'ticket-1',
          role: 'agent',
          qrCodeText: 'https://example.com/login?token=abc',
          createdAt: '2026-03-07T23:50:00.000Z',
          expiresAt: '2026-03-08T00:10:00.000Z',
        };
      },
      getMainConnector: () => ({
        sendPrivateMsg,
        sendPrivateImageBase64,
      }),
    } as any);

    await channel.connect();
    const port = channel.getPort();

    const response = await fetch(`http://127.0.0.1:${port}/qq-bridge/inbound`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-qq-bridge-secret': 'test-secret',
      },
      body: JSON.stringify({
        chat: { id: '1000', type: 'private', name: 'Alice' },
        sender: { id: '2000', name: 'Alice' },
        message: { text: '加机器人账号' },
      }),
    });

    expect(response.status).toBe(200);
    expect(privateTexts).toHaveLength(1);
    expect(privateImages).toHaveLength(1);

    await onEvent?.({
      ticketId: 'ticket-1',
      state: 'scanned',
      role: 'agent',
      occurredAt: '2026-03-07T23:51:00.000Z',
      createdAt: '2026-03-07T23:50:00.000Z',
      expiresAt: '2026-03-08T00:10:00.000Z',
    });
    await onEvent?.({
      ticketId: 'ticket-1',
      state: 'scanned',
      role: 'agent',
      occurredAt: '2026-03-07T23:51:05.000Z',
      createdAt: '2026-03-07T23:50:00.000Z',
      expiresAt: '2026-03-08T00:10:00.000Z',
    });
    await onEvent?.({
      ticketId: 'ticket-1',
      state: 'success',
      role: 'agent',
      occurredAt: '2026-03-07T23:51:30.000Z',
      createdAt: '2026-03-07T23:50:00.000Z',
      expiresAt: '2026-03-08T00:10:00.000Z',
      qqAccount: '30001',
      nickname: 'Agent One',
    });

    expect(privateTexts).toHaveLength(3);
    expect(privateTexts.map((item) => item.userId)).toEqual([
      '1000',
      '1000',
      '1000',
    ]);
    expect(privateTexts[1]?.text).toContain('二维码已扫码');
    expect(privateTexts[2]?.text).toContain('新账号已接入机器人账号池');
    expect(privateTexts[2]?.text).toContain('QQ号：30001');
    expect(privateTexts[2]?.text).toContain('昵称：Agent One');

    await channel.disconnect();
  });
});
