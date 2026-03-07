import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExec } = vi.hoisted(() => ({
  mockExec: vi.fn(
    (
      _command: string,
      optionsOrCallback?: unknown,
      maybeCallback?: unknown,
    ) => {
      const callback =
        typeof optionsOrCallback === 'function'
          ? optionsOrCallback
          : maybeCallback;
      if (typeof callback === 'function') {
        callback(null, '', '');
      }
      return { pid: 1234 } as never;
    },
  ),
}));

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>(
    'child_process',
  );
  return {
    ...actual,
    exec: mockExec,
  };
});

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { DATA_DIR } from './config.js';
import { NapCatFleetManager, type NapCatLoginLifecycleEvent } from './napcat-fleet.js';

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
    mode: 'docker',
  });
}

function createPendingInstance(
  onEvent: (event: NapCatLoginLifecycleEvent) => Promise<void> | void = vi.fn(),
  overrides: Record<string, unknown> = {},
) {
  const dataDir = path.join(DATA_DIR, 'napcat', 'pending-ticket-1');
  const connector = {
    getLoginInfo: vi.fn().mockResolvedValue({ user_id: 0, nickname: '' }),
    isAlive: vi.fn().mockResolvedValue(false),
  };

  return {
    qqAccount: 'pending-ticket-1',
    role: 'agent',
    storageKey: 'pending-ticket-1',
    dataDir,
    containerName: 'napcat-login-ticket-1',
    httpPort: 3001,
    wsPort: 4001,
    webUiPort: 6099,
    webUiToken: 'token-1',
    reportUrl: 'http://127.0.0.1:8787/qq-bridge/inbound',
    connector,
    status: 'starting',
    pendingLogin: {
      id: 'ticket-1',
      role: 'agent',
      createdAt: '2026-03-08T00:00:00.000Z',
      expiresAt: '2026-03-08T00:10:00.000Z',
      onEvent,
      emittedStates: new Set(),
      webUiCredential: 'credential-1',
    },
    ...overrides,
  };
}

describe('NapCatFleetManager login lifecycle', () => {
  let dynamicAccountsBackup: string | null;

  beforeEach(() => {
    vi.clearAllMocks();
    dynamicAccountsBackup = fs.existsSync(dynamicAccountsPath)
      ? fs.readFileSync(dynamicAccountsPath, 'utf-8')
      : null;
    fs.rmSync(dynamicAccountsPath, { force: true });
    fs.rmSync(path.join(DATA_DIR, 'napcat', 'pending-ticket-1'), {
      recursive: true,
      force: true,
    });
    fs.rmSync(path.join(DATA_DIR, 'napcat', 'pending-cleanup'), {
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
    fs.rmSync(path.join(DATA_DIR, 'napcat', 'pending-cleanup'), {
      recursive: true,
      force: true,
    });
  });

  it('每种生命周期状态只触发一次事件', async () => {
    const manager = createManager();
    const onEvent = vi.fn();
    const instance = createPendingInstance(onEvent);

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

    expect(onEvent).toHaveBeenCalledTimes(5);
    expect(onEvent.mock.calls.map(([event]) => event.state)).toEqual([
      'qr_ready',
      'scanned',
      'success',
      'expired',
      'failed',
    ]);
  });

  it('重复轮询相同状态时不会重复通知', async () => {
    const manager = createManager();
    const onEvent = vi.fn();
    const instance = createPendingInstance(onEvent);

    (manager as any).instances.set('pending-ticket-1', instance);
    vi.spyOn(manager as any, 'getPendingLoginStatus').mockResolvedValue({
      isLogin: false,
      loginStage: 'scanned',
    });
    vi.spyOn(manager as any, 'cleanupPendingLogin').mockResolvedValue(undefined);

    await (manager as any).pollPendingLoginStatus('pending-ticket-1', instance);
    await (manager as any).pollPendingLoginStatus('pending-ticket-1', instance);

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'scanned', ticketId: 'ticket-1' }),
    );
  });

  it('成功接入后会写入动态账号并发出成功事件', async () => {
    const manager = createManager();
    const onEvent = vi.fn();
    const instance = createPendingInstance(onEvent);
    instance.connector.getLoginInfo = vi
      .fn()
      .mockResolvedValue({ user_id: 20001, nickname: 'Agent One' });

    (manager as any).instances.set('pending-ticket-1', instance);

    await (manager as any).promotePendingLogin('pending-ticket-1', instance);

    expect(onEvent).toHaveBeenCalledWith(
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

  it('已存在账号会被视为失败并触发清理', async () => {
    const manager = createManager();
    const onEvent = vi.fn();
    const instance = createPendingInstance(onEvent);
    instance.connector.getLoginInfo = vi
      .fn()
      .mockResolvedValue({ user_id: 20001, nickname: '重复账号' });

    (manager as any).instances.set('pending-ticket-1', instance);
    (manager as any).instances.set('20001', {
      ...createPendingInstance(),
      qqAccount: '20001',
      storageKey: '20001',
      pendingLogin: undefined,
    });
    const cleanupSpy = vi
      .spyOn(manager as any, 'cleanupPendingLogin')
      .mockResolvedValue(undefined);

    await (manager as any).promotePendingLogin('pending-ticket-1', instance);

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'failed',
        qqAccount: '20001',
        reason: '该账号已接入',
      }),
    );
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(dynamicAccountsPath)).toBe(false);
  });

  it('失败或过期后会回收临时容器与目录', async () => {
    const manager = createManager();
    const instance = createPendingInstance(vi.fn(), {
      qqAccount: 'pending-cleanup',
      storageKey: 'pending-cleanup',
      dataDir: path.join(DATA_DIR, 'napcat', 'pending-cleanup'),
      containerName: 'napcat-login-cleanup',
    });

    fs.mkdirSync(instance.dataDir, { recursive: true });
    (manager as any).instances.set('pending-cleanup', instance);

    await (manager as any).cleanupPendingLogin('pending-cleanup', instance);

    expect(mockExec).toHaveBeenCalledWith(
      'docker stop napcat-login-cleanup',
      expect.any(Function),
    );
    expect(mockExec).toHaveBeenCalledWith(
      'docker rm napcat-login-cleanup',
      expect.any(Function),
    );
    expect((manager as any).instances.has('pending-cleanup')).toBe(false);
    expect(fs.existsSync(instance.dataDir)).toBe(false);
  });
});
