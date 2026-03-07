/**
 * NapCat Fleet Manager
 * Manages multiple NapCat instances, each bound to a QQ account.
 * Supports two modes:
 *   - 'external': Connect to already-running NapCat instances (default)
 *   - 'docker': Start NapCat instances as Docker containers
 */

import crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';

import { DATA_DIR } from './config.js';
import { NapCatConnector } from './napcat-connector.js';
import { logger } from './logger.js';
import { readEnvFile } from './env.js';

const execAsync = promisify(exec);

export type AccountRole = 'main' | 'agent';

export interface NapCatAccountConfig {
  qqAccount: string;
  role: AccountRole;
  storageKey?: string;
}

export interface NapCatInstance {
  qqAccount: string;
  role: AccountRole;
  storageKey: string;
  dataDir: string;
  containerName: string;
  httpPort: number;
  wsPort: number;
  webUiPort?: number;
  webUiToken?: string;
  reportUrl: string;
  connector: NapCatConnector;
  status: 'starting' | 'running' | 'stopped' | 'error';
  lastHealthCheck?: string;
  pendingLogin?: PendingLoginSession;
}

export interface NapCatLoginTicket {
  id: string;
  role: AccountRole;
  qrCodeText: string;
  createdAt: string;
  expiresAt: string;
}

export interface NapCatFleetConfig {
  accounts: NapCatAccountConfig[];
  image: string;
  baseHttpPort: number;
  reportHost: string;
  reportPort: number;
  mode: 'external' | 'docker';
}

interface PendingLoginSession {
  id: string;
  role: AccountRole;
  createdAt: string;
  expiresAt: string;
}

interface WebUiResponse<T> {
  code: number;
  message: string;
  data?: T;
}

const DYNAMIC_ACCOUNTS_PATH = path.join(
  DATA_DIR,
  'napcat',
  'dynamic-accounts.json',
);
const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000;

function parseAccounts(raw: string): NapCatAccountConfig[] {
  if (!raw) return [];
  return raw.split(',').map((entry) => {
    const [qqAccount, role] = entry.trim().split(':');
    if (!qqAccount) throw new Error(`Invalid NAPCAT_ACCOUNTS entry: "${entry}"`);
    return {
      qqAccount: qqAccount.trim(),
      role: (role?.trim() as AccountRole) || 'agent',
    };
  });
}

function readDynamicAccounts(): NapCatAccountConfig[] {
  if (!fs.existsSync(DYNAMIC_ACCOUNTS_PATH)) return [];
  try {
    const raw = fs.readFileSync(DYNAMIC_ACCOUNTS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({
        qqAccount:
          typeof item?.qqAccount === 'string' ? item.qqAccount.trim() : '',
        role: (item?.role === 'main' ? 'main' : 'agent') as AccountRole,
        storageKey:
          typeof item?.storageKey === 'string' && item.storageKey.trim()
            ? item.storageKey.trim()
            : undefined,
      }))
      .filter((item) => item.qqAccount);
  } catch (err) {
    logger.warn({ err, path: DYNAMIC_ACCOUNTS_PATH }, 'Failed to read dynamic NapCat accounts');
    return [];
  }
}

function writeDynamicAccounts(accounts: NapCatAccountConfig[]): void {
  fs.mkdirSync(path.dirname(DYNAMIC_ACCOUNTS_PATH), { recursive: true });
  fs.writeFileSync(
    DYNAMIC_ACCOUNTS_PATH,
    JSON.stringify(accounts, null, 2),
    'utf-8',
  );
}

function mergeAccounts(
  configured: NapCatAccountConfig[],
  dynamic: NapCatAccountConfig[],
): NapCatAccountConfig[] {
  const merged = [...configured];
  const seen = new Set(configured.map((item) => item.qqAccount));
  for (const account of dynamic) {
    if (seen.has(account.qqAccount)) continue;
    merged.push(account);
    seen.add(account.qqAccount);
  }
  return merged;
}

function createWebUiToken(): string {
  return crypto.randomBytes(12).toString('hex');
}

function createWebUiHash(token: string): string {
  return crypto
    .createHash('sha256')
    .update(`${token}.napcat`)
    .digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function loadFleetConfig(): NapCatFleetConfig {
  const env = readEnvFile([
    'NAPCAT_ACCOUNTS',
    'NAPCAT_IMAGE',
    'NAPCAT_BASE_HTTP_PORT',
    'NAPCAT_REPORT_HOST',
    'NAPCAT_REPORT_PORT',
    'NAPCAT_MODE',
  ]);

  const accounts = parseAccounts(
    process.env.NAPCAT_ACCOUNTS || env.NAPCAT_ACCOUNTS || '',
  );
  const image = process.env.NAPCAT_IMAGE || env.NAPCAT_IMAGE || 'mlikiowa/napcat-docker:latest';
  const baseHttpPort = parseInt(process.env.NAPCAT_BASE_HTTP_PORT || env.NAPCAT_BASE_HTTP_PORT || '3001', 10);
  const reportHost = process.env.NAPCAT_REPORT_HOST || env.NAPCAT_REPORT_HOST || 'host.docker.internal';
  const reportPort = parseInt(process.env.NAPCAT_REPORT_PORT || env.NAPCAT_REPORT_PORT || '8787', 10);
  const mode = (process.env.NAPCAT_MODE || env.NAPCAT_MODE || 'external') as 'external' | 'docker';

  return { accounts, image, baseHttpPort, reportHost, reportPort, mode };
}

export class NapCatFleetManager {
  private instances = new Map<string, NapCatInstance>();
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private readonly config: NapCatFleetConfig;

  constructor(config: NapCatFleetConfig) {
    this.config = {
      ...config,
      accounts: mergeAccounts(config.accounts, readDynamicAccounts()),
    };
  }

  /**
   * Start all configured NapCat instances.
   */
  async startAll(): Promise<void> {
    if (this.config.accounts.length === 0) {
      logger.warn('No NAPCAT_ACCOUNTS configured, fleet manager idle');
      return;
    }

    logger.info({ count: this.config.accounts.length, mode: this.config.mode }, 'Starting NapCat fleet');

    for (let i = 0; i < this.config.accounts.length; i++) {
      const account = this.config.accounts[i];
      const httpPort = this.config.baseHttpPort + i;

      try {
        if (this.config.mode === 'external') {
          await this.connectExternalInstance(account, httpPort);
        } else {
          await this.startDockerInstance(account, httpPort, httpPort + 1000);
        }
      } catch (err) {
        logger.error({ qqAccount: account.qqAccount, err }, 'Failed to start NapCat instance');
      }
    }

    // Start health check loop
    this.healthCheckInterval = setInterval(() => {
      void this.healthCheck();
    }, 30000);
  }

  /**
   * Connect to an already-running NapCat instance (external mode).
   */
  private async connectExternalInstance(
    account: NapCatAccountConfig,
    httpPort: number,
  ): Promise<void> {
    const connector = new NapCatConnector(account.qqAccount, httpPort);

    const instance: NapCatInstance = {
      qqAccount: account.qqAccount,
      role: account.role,
      storageKey: account.storageKey || account.qqAccount,
      dataDir: '',
      containerName: `external-${account.qqAccount}`,
      httpPort,
      wsPort: 0,
      reportUrl: '',
      connector,
      status: 'starting',
    };

    this.instances.set(account.qqAccount, instance);

    // Verify connectivity
    try {
      const alive = await connector.isAlive();
      if (alive) {
        instance.status = 'running';
        const info = await connector.getLoginInfo();
        logger.info(
          { qqAccount: account.qqAccount, httpPort, nickname: info?.nickname },
          'Connected to external NapCat instance',
        );
      } else {
        instance.status = 'error';
        logger.warn(
          { qqAccount: account.qqAccount, httpPort },
          'External NapCat instance not responding, will retry on health check',
        );
      }
    } catch (err) {
      instance.status = 'error';
      logger.warn(
        { qqAccount: account.qqAccount, httpPort, err },
        'Cannot reach external NapCat instance',
      );
    }
  }

  /**
   * Start a single NapCat Docker instance.
   */
  private async startDockerInstance(
    account: NapCatAccountConfig,
    httpPort: number,
    wsPort: number,
    options?: {
      containerName?: string;
      includeAccountEnv?: boolean;
      webUiPort?: number;
      webUiToken?: string;
      pendingLogin?: PendingLoginSession;
    },
  ): Promise<void> {
    const storageKey = account.storageKey || account.qqAccount;
    const containerName = options?.containerName || `napcat-${storageKey}`;

    // Stop existing container if any
    try {
      await execAsync(`docker stop ${containerName}`);
      await execAsync(`docker rm ${containerName}`);
    } catch {
      // Container doesn't exist, that's fine
    }

    // Create data directory for this instance
    const dataDir = path.join(DATA_DIR, 'napcat', storageKey);
    fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'data'), { recursive: true });

    // Generate NapCat OneBot config
    const reportUrl = `http://${this.config.reportHost}:${this.config.reportPort}/qq-bridge/inbound`;
    const onebotConfig = {
      network: {
        httpServers: [
          {
            name: 'httpServer',
            enable: true,
            host: '0.0.0.0',
            port: 3000,
          },
        ],
        httpClients: [
          {
            name: 'httpReport',
            enable: true,
            url: reportUrl,
            messagePostFormat: 'array',
            reportSelfMessage: false,
          },
        ],
        websocketServers: [],
        websocketClients: [],
      },
    };
    fs.writeFileSync(
      path.join(dataDir, 'config', 'onebot11.json'),
      JSON.stringify(onebotConfig, null, 2),
    );

    // Build docker run command
    const args = [
      'run', '-d',
      '--name', containerName,
      '--restart', 'unless-stopped',
      '-e', 'NAPCAT_GID=0',
      '-e', 'NAPCAT_UID=0',
      '-p', `${httpPort}:3000`,
      '-v', `${dataDir}/config:/app/napcat/config`,
      '-v', `${dataDir}/data:/app/.config/QQ`,
    ];

    if (options?.includeAccountEnv !== false) {
      args.push('-e', `ACCOUNT=${account.qqAccount}`);
    }

    if (options?.webUiToken) {
      args.push('-e', `NAPCAT_WEBUI_SECRET_KEY=${options.webUiToken}`);
    }

    if (options?.webUiPort) {
      args.push('-p', `${options.webUiPort}:6099`);
    }

    args.push(this.config.image);

    logger.info({ containerName, httpPort, qqAccount: account.qqAccount }, 'Starting NapCat container');
    await execAsync(`docker ${args.join(' ')}`);

    const connector = new NapCatConnector(account.qqAccount, httpPort);

    const instance: NapCatInstance = {
      qqAccount: account.qqAccount,
      role: account.role,
      storageKey,
      dataDir,
      containerName,
      httpPort,
      wsPort,
      webUiPort: options?.webUiPort,
      webUiToken: options?.webUiToken,
      reportUrl,
      connector,
      status: 'starting',
      pendingLogin: options?.pendingLogin,
    };

    this.instances.set(account.qqAccount, instance);
    logger.info({ qqAccount: account.qqAccount, httpPort }, 'NapCat instance started');
  }

  /**
   * Health check all instances.
   */
  private async healthCheck(): Promise<void> {
    for (const [qqAccount, instance] of this.instances) {
      try {
        const alive = await instance.connector.isAlive();
        const prevStatus = instance.status;
        instance.status = alive ? 'running' : 'error';
        instance.lastHealthCheck = new Date().toISOString();

        if (alive && instance.pendingLogin) {
          await this.promotePendingLogin(qqAccount, instance);
          continue;
        }

        if (alive && prevStatus !== 'running') {
          logger.info({ qqAccount }, 'NapCat instance is now running');
        }

        if (!alive && prevStatus === 'running') {
          logger.warn({ qqAccount }, 'NapCat instance became unhealthy');
          if (this.config.mode === 'docker') {
            try {
              await execAsync(`docker restart ${instance.containerName}`);
              instance.status = 'starting';
            } catch (err) {
              logger.error({ qqAccount, err }, 'Failed to restart NapCat instance');
            }
          }
        }
      } catch (err) {
        instance.status = 'error';
        logger.warn({ qqAccount, err }, 'Health check failed');
      }
    }
  }

  /**
   * Stop all instances.
   */
  async stopAll(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (this.config.mode === 'docker') {
      for (const [qqAccount, instance] of this.instances) {
        try {
          await execAsync(`docker stop ${instance.containerName}`);
          instance.status = 'stopped';
          logger.info({ qqAccount }, 'NapCat instance stopped');
        } catch (err) {
          logger.warn({ qqAccount, err }, 'Failed to stop NapCat instance');
        }
      }
    }
    // External mode: don't stop external instances, just disconnect
  }

  getConnector(qqAccount: string): NapCatConnector | undefined {
    return this.instances.get(qqAccount)?.connector;
  }

  getMainConnector(): NapCatConnector | undefined {
    for (const instance of this.instances.values()) {
      if (instance.role === 'main') return instance.connector;
    }
    return undefined;
  }

  getMainAccount(): string | undefined {
    for (const instance of this.instances.values()) {
      if (instance.role === 'main') return instance.qqAccount;
    }
    return undefined;
  }

  getAgentAccounts(): string[] {
    const agents: string[] = [];
    for (const instance of this.instances.values()) {
      if (instance.role === 'agent' && !instance.pendingLogin) {
        agents.push(instance.qqAccount);
      }
    }
    return agents;
  }

  getAvailableAgentAccounts(assignedAccounts: Set<string>): string[] {
    return this.getAgentAccounts().filter((a) => !assignedAccounts.has(a));
  }

  getAllInstances(): NapCatInstance[] {
    return Array.from(this.instances.values());
  }

  getAllBotAccounts(): Set<string> {
    return new Set(
      Array.from(this.instances.entries())
        .filter(([, instance]) => !instance.pendingLogin)
        .map(([qqAccount]) => qqAccount),
    );
  }

  isBotAccount(userId: string): boolean {
    const instance = this.instances.get(userId);
    return Boolean(instance && !instance.pendingLogin);
  }

  async createAgentLoginTicket(): Promise<NapCatLoginTicket> {
    if (this.config.mode !== 'docker') {
      throw new Error('当前仅 Docker 模式支持扫码新增机器人账号');
    }

    const id = crypto.randomUUID();
    const storageKey = `pending-${id.slice(0, 8)}`;
    const now = Date.now();
    const pendingLogin: PendingLoginSession = {
      id,
      role: 'agent',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + PENDING_LOGIN_TTL_MS).toISOString(),
    };

    const httpPort = this.getNextAvailableHttpPort();
    const webUiPort = this.getNextAvailableWebUiPort();
    const webUiToken = createWebUiToken();

    await this.startDockerInstance(
      {
        qqAccount: storageKey,
        role: 'agent',
        storageKey,
      },
      httpPort,
      httpPort + 1000,
      {
        containerName: `napcat-login-${id.slice(0, 8)}`,
        includeAccountEnv: false,
        webUiPort,
        webUiToken,
        pendingLogin,
      },
    );

    try {
      const qrCodeText = await this.fetchLoginQrCode(webUiPort, webUiToken);
      return {
        id,
        role: 'agent',
        qrCodeText,
        createdAt: pendingLogin.createdAt,
        expiresAt: pendingLogin.expiresAt,
      };
    } catch (err) {
      const instance = this.instances.get(storageKey);
      if (instance) {
        instance.status = 'error';
      }
      throw err;
    }
  }

  private getNextAvailableHttpPort(): number {
    const used = new Set(
      Array.from(this.instances.values()).map((instance) => instance.httpPort),
    );
    let candidate = this.config.baseHttpPort;
    while (used.has(candidate)) {
      candidate += 1;
    }
    return candidate;
  }

  private getNextAvailableWebUiPort(): number {
    const used = new Set(
      Array.from(this.instances.values())
        .map((instance) => instance.webUiPort)
        .filter((port): port is number => typeof port === 'number'),
    );
    let candidate = this.config.baseHttpPort + 3000;
    while (used.has(candidate)) {
      candidate += 1;
    }
    return candidate;
  }

  private async fetchLoginQrCode(
    webUiPort: number,
    webUiToken: string,
  ): Promise<string> {
    const credential = await this.loginWebUi(webUiPort, webUiToken);
    await this.callWebUi(webUiPort, credential, '/api/QQLogin/RefreshQRcode', {});

    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await this.callWebUi<{ qrcode: string }>(
        webUiPort,
        credential,
        '/api/QQLogin/GetQQLoginQrcode',
        {},
      );

      if (response.data?.qrcode) {
        return response.data.qrcode;
      }

      await sleep(1000);
    }

    throw new Error('二维码生成超时，请稍后重试');
  }

  private async loginWebUi(
    webUiPort: number,
    webUiToken: string,
  ): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const response = await fetch(
          `http://127.0.0.1:${webUiPort}/api/auth/login`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ hash: createWebUiHash(webUiToken) }),
          },
        );
        const payload = (await response.json()) as WebUiResponse<{
          Credential: string;
        }>;
        if (payload.code === 0 && payload.data?.Credential) {
          return payload.data.Credential;
        }
      } catch {
        // Ignore until WebUI becomes ready.
      }

      await sleep(1000);
    }

    throw new Error('NapCat 登录面板尚未就绪，请稍后重试');
  }

  private async callWebUi<T>(
    webUiPort: number,
    credential: string,
    pathname: string,
    body: Record<string, unknown>,
  ): Promise<WebUiResponse<T>> {
    const response = await fetch(`http://127.0.0.1:${webUiPort}${pathname}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${credential}`,
      },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as WebUiResponse<T>;
    if (payload.code !== 0) {
      throw new Error(payload.message || 'NapCat WebUI 调用失败');
    }
    return payload;
  }

  private async promotePendingLogin(
    placeholderAccount: string,
    instance: NapCatInstance,
  ): Promise<void> {
    const info = await instance.connector.getLoginInfo();
    const realAccount = String(info.user_id || '').trim();
    if (!realAccount) {
      return;
    }

    if (realAccount === placeholderAccount) {
      instance.pendingLogin = undefined;
      return;
    }

    const existing = this.instances.get(realAccount);
    if (existing && existing !== instance) {
      logger.warn(
        { realAccount, placeholderAccount },
        'Pending NapCat login resolved to an already connected account',
      );
      return;
    }

    const persisted = readDynamicAccounts();
    const merged = persisted.filter((item) => item.qqAccount !== realAccount);
    const nextAccount: NapCatAccountConfig = {
      qqAccount: realAccount,
      role: instance.role,
      storageKey: instance.storageKey,
    };
    merged.push(nextAccount);
    writeDynamicAccounts(merged);

    if (!this.config.accounts.some((item) => item.qqAccount === realAccount)) {
      this.config.accounts.push(nextAccount);
    }

    this.instances.delete(placeholderAccount);
    this.instances.set(realAccount, {
      ...instance,
      qqAccount: realAccount,
      connector: new NapCatConnector(realAccount, instance.httpPort),
      pendingLogin: undefined,
      status: 'running',
    });

    logger.info(
      {
        realAccount,
        storageKey: instance.storageKey,
        nickname: info.nickname,
      },
      'Pending NapCat login completed and account was added to fleet',
    );
  }
}
