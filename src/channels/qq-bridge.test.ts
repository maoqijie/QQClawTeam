import fs from 'fs';
import http from 'http';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
    modelOwnsPrivateCommands: false,
    ...overrides,
  };
}

function createOpts() {
  const groups: Record<string, any> = {};
  const messages: Array<{ chatJid: string; message: any }> = [];
  const llmUpdates: Array<{ chatJid: string; containerConfig: any }> = [];
  const metadata: Array<{
    chatJid: string;
    timestamp: string;
    name?: string;
    channel?: string;
    isGroup?: boolean;
  }> = [];
  return {
    opts: {
      onMessage: (chatJid: string, message: any) => {
        messages.push({ chatJid, message });
      },
      onChatMetadata: (
        chatJid: string,
        timestamp: string,
        name?: string,
        channel?: string,
        isGroup?: boolean,
      ) => {
        metadata.push({ chatJid, timestamp, name, channel, isGroup });
      },
      registeredGroups: () => groups,
      onPrivateLlmConfigUpdated: (chatJid: string, containerConfig: any) => {
        llmUpdates.push({ chatJid, containerConfig });
      },
    },
    groups,
    messages,
    metadata,
    llmUpdates,
  };
}

async function startOutboundServer(statuses: number[]): Promise<{
  url: string;
  close: () => Promise<void>;
  getRequestCount: () => number;
}> {
  let requestCount = 0;
  const server = http.createServer((_, response) => {
    const status = statuses[Math.min(requestCount, statuses.length - 1)] ?? 200;
    requestCount += 1;
    response.statusCode = status;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(status >= 400 ? 'error' : '{}');
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind outbound test server');
  }

  return {
    url: `http://127.0.0.1:${address.port}/outbound`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
    getRequestCount: () => requestCount,
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
    const server = await startOutboundServer([429, 200]);
    try {
      const dispatcher = new OutboundDispatcher(
        createConfig({ outboundUrl: server.url }),
        fetch,
      );

      await dispatcher.enqueue({
        kind: 'message',
        jid: 'qq:group:123',
        text: 'hello',
      });

      expect(server.getRequestCount()).toBe(2);
    } finally {
      await server.close();
    }
  });

  it('fails immediately on non-retryable response', async () => {
    const server = await startOutboundServer([400]);
    try {
      const dispatcher = new OutboundDispatcher(
        createConfig({ outboundUrl: server.url }),
        fetch,
      );

      await expect(
        dispatcher.enqueue({
          kind: 'message',
          jid: 'qq:group:123',
          text: 'hello',
        }),
      ).rejects.toThrow('400');
      expect(server.getRequestCount()).toBe(1);
    } finally {
      await server.close();
    }
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
  });

  it('auto-registers private chats and stores inbound messages', async () => {
    const { opts, groups, messages } = createOpts();
    const channel = new QQBridgeChannel(
      createConfig(),
      opts,
      fetch,
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
    expect(messages).toHaveLength(1);
    expect(
      getRegisteredGroup(toQqJid('private', '1000'))?.requiresTrigger,
    ).toBe(false);

    await channel.disconnect();
  });

  it('drops unregistered group messages by default', async () => {
    const { opts, groups, messages } = createOpts();
    const channel = new QQBridgeChannel(
      createConfig(),
      opts,
      fetch,
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
    expect(messages).toHaveLength(0);

    await channel.disconnect();
  });

  it('registers groups via management endpoint', async () => {
    const { opts } = createOpts();
    const channel = new QQBridgeChannel(
      createConfig(),
      opts,
      fetch,
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

  it('handles private llm switch command and persists chat override', async () => {
    const { opts, messages, llmUpdates } = createOpts();
    const channel = new QQBridgeChannel(createConfig(), opts, fetch);

    const privateTexts: Array<{ userId: string; text: string }> = [];
    channel.setFleetManager({
      getMainConnector: () => ({
        sendPrivateMsg: async (userId: string, text: string) => {
          privateTexts.push({ userId, text });
          return { retcode: 0, status: 'ok' };
        },
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
        message: { text: '切换模型 openai gpt-5.4-pro' },
      }),
    });

    const body = (await response.json()) as {
      accepted: boolean;
      registered: boolean;
    };
    expect(response.status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(body.registered).toBe(true);
    expect(messages).toHaveLength(0);
    expect(privateTexts).toHaveLength(1);
    expect(privateTexts[0]?.text).toContain('已切换当前私聊会话的模型配置');
    expect(privateTexts[0]?.text).toContain('gpt-5.4-pro');
    expect(llmUpdates).toEqual([
      {
        chatJid: 'qq:private:1000',
        containerConfig: {
          llmBackend: 'openai',
          llmModel: 'gpt-5.4-pro',
        },
      },
    ]);

    expect(getRegisteredGroup('qq:private:1000')?.containerConfig).toEqual({
      llmBackend: 'openai',
      llmModel: 'gpt-5.4-pro',
    });

    await channel.disconnect();
  });

  it('handles private llm status and reset commands', async () => {
    const { opts, messages, llmUpdates } = createOpts();
    const channel = new QQBridgeChannel(createConfig(), opts, fetch);

    const privateTexts: Array<{ userId: string; text: string }> = [];
    channel.setFleetManager({
      getMainConnector: () => ({
        sendPrivateMsg: async (userId: string, text: string) => {
          privateTexts.push({ userId, text });
          return { retcode: 0, status: 'ok' };
        },
      }),
    } as any);

    await channel.connect();
    const port = channel.getPort();

    await fetch(`http://127.0.0.1:${port}/qq-bridge/inbound`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-qq-bridge-secret': 'test-secret',
      },
      body: JSON.stringify({
        chat: { id: '1000', type: 'private', name: 'Alice' },
        sender: { id: '2000', name: 'Alice' },
        message: { text: '切换模型 openai gpt-5.4-pro' },
      }),
    });

    await fetch(`http://127.0.0.1:${port}/qq-bridge/inbound`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-qq-bridge-secret': 'test-secret',
      },
      body: JSON.stringify({
        chat: { id: '1000', type: 'private', name: 'Alice' },
        sender: { id: '2000', name: 'Alice' },
        message: { text: '查看模型' },
      }),
    });

    await fetch(`http://127.0.0.1:${port}/qq-bridge/inbound`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-qq-bridge-secret': 'test-secret',
      },
      body: JSON.stringify({
        chat: { id: '1000', type: 'private', name: 'Alice' },
        sender: { id: '2000', name: 'Alice' },
        message: { text: '恢复默认模型' },
      }),
    });

    expect(messages).toHaveLength(0);
    expect(privateTexts).toHaveLength(3);
    expect(privateTexts[1]?.text).toContain('当前私聊会话模型配置');
    expect(privateTexts[1]?.text).toContain('gpt-5.4-pro');
    expect(privateTexts[2]?.text).toContain('已恢复当前私聊会话的默认模型配置');
    expect(getRegisteredGroup('qq:private:1000')?.containerConfig).toBeUndefined();
    expect(llmUpdates.at(-1)).toEqual({
      chatJid: 'qq:private:1000',
      containerConfig: undefined,
    });

    await channel.disconnect();
  });

  it('handles natural language llm switch requests in private chat', async () => {
    const { opts, messages, llmUpdates } = createOpts();
    const channel = new QQBridgeChannel(createConfig(), opts, fetch);

    const privateTexts: Array<{ userId: string; text: string }> = [];
    channel.setFleetManager({
      getMainConnector: () => ({
        sendPrivateMsg: async (userId: string, text: string) => {
          privateTexts.push({ userId, text });
          return { retcode: 0, status: 'ok' };
        },
      }),
    } as any);

    await channel.connect();
    const port = channel.getPort();

    await fetch(`http://127.0.0.1:${port}/qq-bridge/inbound`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-qq-bridge-secret': 'test-secret',
      },
      body: JSON.stringify({
        chat: { id: '1000', type: 'private', name: 'Alice' },
        sender: { id: '2000', name: 'Alice' },
        message: { text: '以后这个私聊改用 openai 的 gpt-5.4-pro 来回复我' },
      }),
    });

    expect(messages).toHaveLength(0);
    expect(privateTexts).toHaveLength(1);
    expect(privateTexts[0]?.text).toContain('已切换当前私聊会话的模型配置');
    expect(getRegisteredGroup('qq:private:1000')?.containerConfig).toEqual({
      llmBackend: 'openai',
      llmModel: 'gpt-5.4-pro',
    });
    expect(llmUpdates.at(-1)).toEqual({
      chatJid: 'qq:private:1000',
      containerConfig: {
        llmBackend: 'openai',
        llmModel: 'gpt-5.4-pro',
      },
    });

    await channel.disconnect();
  });

  it('handles natural language provider fallback to claude in private chat', async () => {
    const { opts, messages, llmUpdates } = createOpts();
    const channel = new QQBridgeChannel(createConfig(), opts, fetch);

    const privateTexts: Array<{ userId: string; text: string }> = [];
    channel.setFleetManager({
      getMainConnector: () => ({
        sendPrivateMsg: async (userId: string, text: string) => {
          privateTexts.push({ userId, text });
          return { retcode: 0, status: 'ok' };
        },
      }),
    } as any);

    await channel.connect();
    const port = channel.getPort();

    await fetch(`http://127.0.0.1:${port}/qq-bridge/inbound`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-qq-bridge-secret': 'test-secret',
      },
      body: JSON.stringify({
        chat: { id: '1000', type: 'private', name: 'Alice' },
        sender: { id: '2000', name: 'Alice' },
        message: { text: '从现在开始这个会话切回 claude 吧' },
      }),
    });

    expect(messages).toHaveLength(0);
    expect(privateTexts).toHaveLength(1);
    expect(privateTexts[0]?.text).toContain('claude');
    expect(getRegisteredGroup('qq:private:1000')?.containerConfig).toEqual({
      llmBackend: 'claude',
    });
    expect(llmUpdates.at(-1)).toEqual({
      chatJid: 'qq:private:1000',
      containerConfig: {
        llmBackend: 'claude',
      },
    });

    await channel.disconnect();
  });

  it('handles natural language llm status and reset requests in private chat', async () => {
    const { opts, messages, llmUpdates } = createOpts();
    const channel = new QQBridgeChannel(createConfig(), opts, fetch);

    const privateTexts: Array<{ userId: string; text: string }> = [];
    channel.setFleetManager({
      getMainConnector: () => ({
        sendPrivateMsg: async (userId: string, text: string) => {
          privateTexts.push({ userId, text });
          return { retcode: 0, status: 'ok' };
        },
      }),
    } as any);

    await channel.connect();
    const port = channel.getPort();

    await fetch(`http://127.0.0.1:${port}/qq-bridge/inbound`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-qq-bridge-secret': 'test-secret',
      },
      body: JSON.stringify({
        chat: { id: '1000', type: 'private', name: 'Alice' },
        sender: { id: '2000', name: 'Alice' },
        message: { text: '切换模型 openai gpt-5.4-pro' },
      }),
    });

    await fetch(`http://127.0.0.1:${port}/qq-bridge/inbound`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-qq-bridge-secret': 'test-secret',
      },
      body: JSON.stringify({
        chat: { id: '1000', type: 'private', name: 'Alice' },
        sender: { id: '2000', name: 'Alice' },
        message: { text: '你现在这个私聊用的是什么模型' },
      }),
    });

    await fetch(`http://127.0.0.1:${port}/qq-bridge/inbound`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-qq-bridge-secret': 'test-secret',
      },
      body: JSON.stringify({
        chat: { id: '1000', type: 'private', name: 'Alice' },
        sender: { id: '2000', name: 'Alice' },
        message: { text: '把这个私聊的模型配置恢复成默认吧' },
      }),
    });

    expect(messages).toHaveLength(0);
    expect(privateTexts).toHaveLength(3);
    expect(privateTexts[1]?.text).toContain('当前私聊会话模型配置');
    expect(privateTexts[1]?.text).toContain('gpt-5.4-pro');
    expect(privateTexts[2]?.text).toContain('已恢复当前私聊会话的默认模型配置');
    expect(getRegisteredGroup('qq:private:1000')?.containerConfig).toBeUndefined();
    expect(llmUpdates.at(-1)).toEqual({
      chatJid: 'qq:private:1000',
      containerConfig: undefined,
    });

    await channel.disconnect();
  });

  it('does not hijack normal comparison questions as llm switch commands', async () => {
    const { opts, messages, llmUpdates } = createOpts();
    const channel = new QQBridgeChannel(createConfig(), opts, fetch);

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
        message: { text: '帮我比较一下 openai 和 claude 哪个更适合写代码' },
      }),
    });

    const body = (await response.json()) as {
      accepted: boolean;
      registered: boolean;
    };
    expect(response.status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(body.registered).toBe(true);
    expect(messages).toHaveLength(1);
    expect(llmUpdates).toHaveLength(0);

    await channel.disconnect();
  });

  it('handles private add-bot-account command and returns qr ticket', async () => {
    const { opts, messages } = createOpts();
    const channel = new QQBridgeChannel(
      createConfig({ publicBaseUrl: 'https://bot.example.com' }),
      opts,
      fetch,
    );
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const occurredAt = new Date(Date.now() + 1000).toISOString();

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
        occurredAt,
        createdAt,
        expiresAt,
      });
      return {
        id: 'ticket-1',
        role: 'agent',
        qrCodeText: 'https://example.com/login?token=abc',
        createdAt,
        expiresAt,
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
    expect(messages).toHaveLength(0);
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

  it('handles natural language add-bot-account and refresh requests in private chat', async () => {
    const { opts, messages } = createOpts();
    const channel = new QQBridgeChannel(
      createConfig({ publicBaseUrl: 'https://bot.example.com' }),
      opts,
      fetch,
    );
    const privateTexts: Array<{ userId: string; text: string }> = [];
    const privateImages: Array<{ userId: string; base64: string }> = [];
    let ticketNumber = 0;

    channel.setFleetManager({
      createAgentLoginTicket: async (options?: any) => {
        ticketNumber += 1;
        const createdAt = new Date().toISOString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
        await options?.onEvent?.({
          ticketId: `ticket-${ticketNumber}`,
          state: 'qr_ready',
          role: 'agent',
          occurredAt: new Date(Date.now() + 1000).toISOString(),
          createdAt,
          expiresAt,
        });
        return {
          id: `ticket-${ticketNumber}`,
          role: 'agent',
          qrCodeText: `https://example.com/login?token=${ticketNumber}`,
          createdAt,
          expiresAt,
        };
      },
      getMainConnector: () => ({
        sendPrivateMsg: async (userId: string, text: string) => {
          privateTexts.push({ userId, text });
          return { retcode: 0, status: 'ok' };
        },
        sendPrivateImageBase64: async (userId: string, base64: string) => {
          privateImages.push({ userId, base64 });
          return { retcode: 0, status: 'ok' };
        },
      }),
    } as any);

    await channel.connect();
    const port = channel.getPort();

    const createResponse = await fetch(`http://127.0.0.1:${port}/qq-bridge/inbound`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-qq-bridge-secret': 'test-secret',
      },
      body: JSON.stringify({
        chat: { id: '1000', type: 'private', name: 'Alice' },
        sender: { id: '2000', name: 'Alice' },
        message: { text: '我想要增加一个QQ账号用于调度' },
      }),
    });

    const refreshResponse = await fetch(`http://127.0.0.1:${port}/qq-bridge/inbound`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-qq-bridge-secret': 'test-secret',
      },
      body: JSON.stringify({
        chat: { id: '1000', type: 'private', name: 'Alice' },
        sender: { id: '2000', name: 'Alice' },
        message: { text: '二维码过期了，给我重新发一个新的机器人登录二维码' },
      }),
    });

    expect(createResponse.status).toBe(200);
    expect(refreshResponse.status).toBe(200);
    expect(messages).toHaveLength(0);
    expect(privateTexts).toHaveLength(2);
    expect(privateImages).toHaveLength(2);
    expect(privateTexts[0]?.text).toContain('已生成新的机器人登录二维码');
    expect(privateTexts[0]?.text).toContain(
      '备用预览地址：https://bot.example.com/qq-bridge/bot-login/ticket-1',
    );
    expect(privateTexts[1]?.text).toContain('已生成新的机器人登录二维码');
    expect(privateTexts[1]?.text).toContain(
      '备用预览地址：https://bot.example.com/qq-bridge/bot-login/ticket-2',
    );

    await channel.disconnect();
  });

  it('uses recent login ticket context for short refresh follow-ups', async () => {
    const { opts, messages } = createOpts();
    const channel = new QQBridgeChannel(createConfig(), opts, fetch);
    const privateTexts: Array<{ userId: string; text: string }> = [];
    const privateImages: Array<{ userId: string; base64: string }> = [];
    let ticketNumber = 0;

    channel.setFleetManager({
      createAgentLoginTicket: async (options?: any) => {
        ticketNumber += 1;
        const createdAt = new Date().toISOString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
        await options?.onEvent?.({
          ticketId: `ticket-${ticketNumber}`,
          state: 'qr_ready',
          role: 'agent',
          occurredAt: new Date(Date.now() + 1000).toISOString(),
          createdAt,
          expiresAt,
        });
        return {
          id: `ticket-${ticketNumber}`,
          role: 'agent',
          qrCodeText: `https://example.com/login?token=${ticketNumber}`,
          createdAt,
          expiresAt,
        };
      },
      getMainConnector: () => ({
        sendPrivateMsg: async (userId: string, text: string) => {
          privateTexts.push({ userId, text });
          return { retcode: 0, status: 'ok' };
        },
        sendPrivateImageBase64: async (userId: string, base64: string) => {
          privateImages.push({ userId, base64 });
          return { retcode: 0, status: 'ok' };
        },
      }),
    } as any);

    await channel.connect();
    const port = channel.getPort();

    await fetch(`http://127.0.0.1:${port}/qq-bridge/inbound`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-qq-bridge-secret': 'test-secret',
      },
      body: JSON.stringify({
        chat: { id: '1000', type: 'private', name: 'Alice' },
        sender: { id: '2000', name: 'Alice' },
        message: { text: '我想要增加一个QQ账号用于调度' },
      }),
    });

    await fetch(`http://127.0.0.1:${port}/qq-bridge/inbound`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-qq-bridge-secret': 'test-secret',
      },
      body: JSON.stringify({
        chat: { id: '1000', type: 'private', name: 'Alice' },
        sender: { id: '2000', name: 'Alice' },
        message: { text: '失效了' },
      }),
    });

    expect(messages).toHaveLength(0);
    expect(privateTexts).toHaveLength(2);
    expect(privateImages).toHaveLength(2);
    expect(privateTexts[0]?.text).toContain('已生成新的机器人登录二维码');
    expect(privateTexts[1]?.text).toContain('已生成新的机器人登录二维码');

    await channel.disconnect();
  });

  it('does not intercept private commands when model-owned mode is enabled', async () => {
    const { opts, messages } = createOpts();
    const channel = new QQBridgeChannel(
      createConfig({ modelOwnsPrivateCommands: true }),
      opts,
      fetch,
    );

    const privateTexts: Array<{ userId: string; text: string }> = [];
    channel.setFleetManager({
      getMainConnector: () => ({
        sendPrivateMsg: async (userId: string, text: string) => {
          privateTexts.push({ userId, text });
          return { retcode: 0, status: 'ok' };
        },
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
        message: { text: '查看模型' },
      }),
    });

    const body = (await response.json()) as {
      accepted: boolean;
      registered: boolean;
    };
    expect(response.status).toBe(200);
    expect(body.accepted).toBe(true);
    expect(body.registered).toBe(true);
    expect(messages).toHaveLength(1);
    expect(privateTexts).toHaveLength(0);

    await channel.disconnect();
  });

  it('only notifies the requesting private chat once per lifecycle state', async () => {
    const { opts, messages } = createOpts();
    const channel = new QQBridgeChannel(
      createConfig({ publicBaseUrl: 'https://bot.example.com' }),
      opts,
      fetch,
    );
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const scannedAt = new Date(Date.now() + 60 * 1000).toISOString();
    const scannedAgainAt = new Date(Date.now() + 65 * 1000).toISOString();
    const successAt = new Date(Date.now() + 90 * 1000).toISOString();

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
          createdAt,
          expiresAt,
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
    expect(messages).toHaveLength(0);
    expect(privateTexts).toHaveLength(1);
    expect(privateImages).toHaveLength(1);

    await onEvent?.({
      ticketId: 'ticket-1',
      state: 'scanned',
      role: 'agent',
      occurredAt: scannedAt,
      createdAt,
      expiresAt,
    });
    await onEvent?.({
      ticketId: 'ticket-1',
      state: 'scanned',
      role: 'agent',
      occurredAt: scannedAgainAt,
      createdAt,
      expiresAt,
    });
    await onEvent?.({
      ticketId: 'ticket-1',
      state: 'success',
      role: 'agent',
      occurredAt: successAt,
      createdAt,
      expiresAt,
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
