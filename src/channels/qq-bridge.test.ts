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
});
