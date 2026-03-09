import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DATA_DIR } from './config.js';
import {
  NapCatFleetManager,
  type NapCatLoginLifecycleEvent,
} from './napcat-fleet.js';

const dynamicAccountsPath = path.join(
  DATA_DIR,
  'napcat',
  'dynamic-accounts.json',
);

function createManager(): NapCatFleetManager {
  return new NapCatFleetManager({
    accounts: [],
    image: 'napcat:test',
    baseHttpPort: 3001,
    reportHost: '127.0.0.1',
    reportPort: 8787,
    mode: 'external',
  });
}

function createPendingInstance(options?: {
  qqAccount?: string;
  storageKey?: string;
  dataDir?: string;
  expiresAt?: string;
  loginInfo?: { user_id: number; nickname: string };
  onEvent?: (event: NapCatLoginLifecycleEvent) => Promise<void> | void;
}) {
  const qqAccount = options?.qqAccount || 'pending-ticket-1';
  const storageKey = options?.storageKey || qqAccount;
  const dataDir =
    options?.dataDir || path.join(DATA_DIR, 'napcat', storageKey);
  const now = Date.now();

  return {
    qqAccount,
    role: 'agent',
    storageKey,
    dataDir,
    containerName: `napcat-login-${storageKey}`,
    httpPort: 3001,
    wsPort: 4001,
    webUiPort: 6099,
    webUiToken: 'token-1',
    reportUrl: 'http://127.0.0.1:8787/qq-bridge/inbound',
    connector: {
      async getLoginInfo() {
        return options?.loginInfo || { user_id: 0, nickname: '' };
      },
      async isAlive() {
        return false;
      },
    },
    status: 'starting',
    pendingLogin: {
      id: 'ticket-1',
      role: 'agent',
      createdAt: new Date(now).toISOString(),
      expiresAt:
        options?.expiresAt || new Date(now + 10 * 60 * 1000).toISOString(),
      onEvent: options?.onEvent,
      emittedStates: new Set(),
      webUiCredential: 'credential-1',
      lastQrCodeText: undefined,
    },
  };
}

describe('NapCatFleetManager login lifecycle', () => {
  let dynamicAccountsBackup: string | null;

  beforeEach(() => {
    dynamicAccountsBackup = fs.existsSync(dynamicAccountsPath)
      ? fs.readFileSync(dynamicAccountsPath, 'utf-8')
      : null;
    fs.rmSync(dynamicAccountsPath, { force: true });
    fs.rmSync(path.join(DATA_DIR, 'napcat', 'pending-ticket-1'), {
      recursive: true,
      force: true,
    });
    fs.rmSync(path.join(DATA_DIR, 'napcat', 'pending-expired'), {
      recursive: true,
      force: true,
    });
  });

  afterEach(() => {
    fs.rmSync(dynamicAccountsPath, { force: true });
    if (dynamicAccountsBackup !== null) {
      fs.mkdirSync(path.dirname(dynamicAccountsPath), { recursive: true });
      fs.writeFileSync(dynamicAccountsPath, dynamicAccountsBackup, 'utf-8');
    }
    fs.rmSync(path.join(DATA_DIR, 'napcat', 'pending-ticket-1'), {
      recursive: true,
      force: true,
    });
    fs.rmSync(path.join(DATA_DIR, 'napcat', 'pending-expired'), {
      recursive: true,
      force: true,
    });
  });

  it('每种生命周期状态只触发一次事件', async () => {
    const manager = createManager();
    const events: NapCatLoginLifecycleEvent[] = [];
    const instance = createPendingInstance({
      onEvent: async (event) => {
        events.push(event);
      },
    });

    await (manager as any).emitPendingLoginEvent(instance, 'qr_ready');
    await (manager as any).emitPendingLoginEvent(instance, 'scanned');
    await (manager as any).emitPendingLoginEvent(instance, 'success', {
      qqAccount: '20001',
      nickname: '测试账号',
    });
    await (manager as any).emitPendingLoginEvent(instance, 'expired');
    await (manager as any).emitPendingLoginEvent(instance, 'failed', {
      reason: '未知错误',
    });
    await (manager as any).emitPendingLoginEvent(instance, 'qr_ready');
    await (manager as any).emitPendingLoginEvent(instance, 'failed', {
      reason: '不会重复',
    });

    expect(events.map((event) => event.state)).toEqual([
      'qr_ready',
      'scanned',
      'success',
      'expired',
      'failed',
    ]);
  });

  it('成功接入后会写入动态账号并发出成功事件', async () => {
    const manager = createManager();
    const events: NapCatLoginLifecycleEvent[] = [];
    const instance = createPendingInstance({
      loginInfo: { user_id: 20001, nickname: 'Agent One' },
      onEvent: async (event) => {
        events.push(event);
      },
    });

    (manager as any).instances.set('pending-ticket-1', instance);

    await (manager as any).promotePendingLogin('pending-ticket-1', instance);

    expect(events).toContainEqual(
      expect.objectContaining({
        state: 'success',
        qqAccount: '20001',
        nickname: 'Agent One',
      }),
    );
    expect((manager as any).instances.has('pending-ticket-1')).toBe(false);
    expect((manager as any).instances.has('20001')).toBe(true);

    const saved = JSON.parse(fs.readFileSync(dynamicAccountsPath, 'utf-8'));
    expect(saved).toEqual([
      expect.objectContaining({
        qqAccount: '20001',
        role: 'agent',
        storageKey: 'pending-ticket-1',
      }),
    ]);
  });

  it('已在线的账号会被视为失败并立即清理', async () => {
    const manager = createManager();
    const events: NapCatLoginLifecycleEvent[] = [];
    const instance = createPendingInstance({
      loginInfo: { user_id: 20001, nickname: '重复账号' },
      onEvent: async (event) => {
        events.push(event);
      },
    });

    fs.mkdirSync(instance.dataDir, { recursive: true });
    (manager as any).instances.set('pending-ticket-1', instance);
    (manager as any).instances.set('20001', {
      ...createPendingInstance({ qqAccount: '20001', storageKey: '20001' }),
      qqAccount: '20001',
      storageKey: '20001',
      status: 'running',
      pendingLogin: undefined,
    });

    await (manager as any).promotePendingLogin('pending-ticket-1', instance);

    expect(events).toContainEqual(
      expect.objectContaining({
        state: 'failed',
        qqAccount: '20001',
        reason: '该账号已接入',
      }),
    );
    expect((manager as any).instances.has('pending-ticket-1')).toBe(false);
    expect(fs.existsSync(instance.dataDir)).toBe(false);
    expect(fs.existsSync(dynamicAccountsPath)).toBe(false);
  });

  it('离线的已接入账号允许重新登录恢复，不视为重复接入', async () => {
    const manager = createManager();
    const events: NapCatLoginLifecycleEvent[] = [];
    const instance = createPendingInstance({
      loginInfo: { user_id: 20001, nickname: '恢复账号' },
      onEvent: async (event) => {
        events.push(event);
      },
    });

    (manager as any).instances.set('pending-ticket-1', instance);
    (manager as any).instances.set('20001', {
      ...createPendingInstance({ qqAccount: '20001', storageKey: '20001' }),
      qqAccount: '20001',
      storageKey: '20001',
      status: 'error',
      pendingLogin: undefined,
    });

    await (manager as any).promotePendingLogin('pending-ticket-1', instance);

    expect(events).toContainEqual(
      expect.objectContaining({
        state: 'success',
        qqAccount: '20001',
        nickname: '恢复账号',
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        state: 'failed',
        reason: '该账号已接入',
      }),
    );
    expect((manager as any).instances.has('20001')).toBe(true);
  });

  it('过期轮询会通知 expired 并回收目录', async () => {
    const manager = createManager();
    const events: NapCatLoginLifecycleEvent[] = [];
    const instance = createPendingInstance({
      qqAccount: 'pending-expired',
      storageKey: 'pending-expired',
      dataDir: path.join(DATA_DIR, 'napcat', 'pending-expired'),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      onEvent: async (event) => {
        events.push(event);
      },
    });

    fs.mkdirSync(instance.dataDir, { recursive: true });
    (manager as any).instances.set('pending-expired', instance);

    await (manager as any).pollPendingLoginStatus('pending-expired', instance);

    expect(events).toContainEqual(
      expect.objectContaining({
        state: 'expired',
        ticketId: 'ticket-1',
      }),
    );
    expect((manager as any).instances.has('pending-expired')).toBe(false);
    expect(fs.existsSync(instance.dataDir)).toBe(false);
  });

  it('优先使用登录状态里的 qrcodeurl 作为首次二维码，并修正 HTML 转义', async () => {
    const manager = createManager();
    const events: NapCatLoginLifecycleEvent[] = [];
    const instance = createPendingInstance({
      onEvent: async (event) => {
        events.push(event);
      },
    });

    (manager as any).getPendingLoginCredential = async () => 'credential-1';
    (manager as any).callWebUi = async (_port: number, _credential: string, pathname: string) => {
      if (pathname === '/api/QQLogin/RefreshQRcode') {
        return { code: 0, message: 'ok' };
      }
      if (pathname === '/api/QQLogin/GetQQLoginQrcode') {
        throw new Error('should not need GetQQLoginQrcode when qrcodeurl is present');
      }
      throw new Error(`unexpected pathname: ${pathname}`);
    };
    (manager as any).getPendingLoginStatus = async () => ({
      isLogin: false,
      loginStage: 'qr_ready',
      qrcodeurl: 'https://txz.qq.com/p?k=test&amp;f=1600001615',
    });

    const qrCodeText = await (manager as any).fetchLoginQrCode(instance);

    expect(qrCodeText).toBe('https://txz.qq.com/p?k=test&f=1600001615');
    expect(instance.pendingLogin?.lastQrCodeText).toBe(
      'https://txz.qq.com/p?k=test&f=1600001615',
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        state: 'qr_ready',
      }),
    );
  });

  it('在账号掉线和恢复时发出健康状态事件', async () => {
    const manager = createManager();
    const events: Array<{ qqAccount: string; status: string; role: string }> = [];
    manager.setHealthEventHandler(async (event) => {
      events.push({
        qqAccount: event.qqAccount,
        status: event.status,
        role: event.role,
      });
    });

    let alive = false;
    (manager as any).instances.set('20001', {
      qqAccount: '20001',
      role: 'agent',
      storageKey: '20001',
      dataDir: '',
      containerName: 'napcat-20001',
      httpPort: 3002,
      wsPort: 4002,
      reportUrl: 'http://127.0.0.1:8787/qq-bridge/inbound',
      connector: {
        async isAlive() {
          return alive;
        },
      },
      status: 'running',
    });

    await (manager as any).healthCheck();
    alive = true;
    await (manager as any).healthCheck();

    expect(events).toEqual([
      { qqAccount: '20001', status: 'error', role: 'agent' },
      { qqAccount: '20001', status: 'running', role: 'agent' },
    ]);
  });

  it('同一次掉线期间不会重复发送离线提醒', async () => {
    const manager = createManager();
    const events: Array<{ qqAccount: string; status: string }> = [];
    manager.setHealthEventHandler(async (event) => {
      events.push({ qqAccount: event.qqAccount, status: event.status });
    });

    let alive = false;
    (manager as any).instances.set('20001', {
      qqAccount: '20001',
      role: 'agent',
      storageKey: '20001',
      dataDir: '',
      containerName: 'napcat-20001',
      httpPort: 3002,
      wsPort: 4002,
      reportUrl: 'http://127.0.0.1:8787/qq-bridge/inbound',
      connector: {
        async isAlive() {
          return alive;
        },
      },
      status: 'running',
    });

    await (manager as any).healthCheck();
    await (manager as any).healthCheck();

    expect(events).toEqual([
      { qqAccount: '20001', status: 'error' },
    ]);
  });
});
