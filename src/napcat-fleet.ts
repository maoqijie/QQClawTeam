/**
 * NapCat Fleet Manager
 * Manages multiple NapCat Docker instances, each bound to a QQ account.
 */

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
}

export interface NapCatInstance {
  qqAccount: string;
  role: AccountRole;
  containerName: string;
  httpPort: number;
  wsPort: number;
  reportUrl: string;
  connector: NapCatConnector;
  status: 'starting' | 'running' | 'stopped' | 'error';
  lastHealthCheck?: string;
}

export interface NapCatFleetConfig {
  accounts: NapCatAccountConfig[];
  image: string;
  baseHttpPort: number;
  reportHost: string;
  reportPort: number;
}

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

export function loadFleetConfig(): NapCatFleetConfig {
  const env = readEnvFile([
    'NAPCAT_ACCOUNTS',
    'NAPCAT_IMAGE',
    'NAPCAT_BASE_HTTP_PORT',
    'NAPCAT_REPORT_HOST',
    'NAPCAT_REPORT_PORT',
  ]);

  const accounts = parseAccounts(
    process.env.NAPCAT_ACCOUNTS || env.NAPCAT_ACCOUNTS || '',
  );
  const image = process.env.NAPCAT_IMAGE || env.NAPCAT_IMAGE || 'mlikiowa/napcat-docker:latest';
  const baseHttpPort = parseInt(process.env.NAPCAT_BASE_HTTP_PORT || env.NAPCAT_BASE_HTTP_PORT || '3001', 10);
  const reportHost = process.env.NAPCAT_REPORT_HOST || env.NAPCAT_REPORT_HOST || 'host.docker.internal';
  const reportPort = parseInt(process.env.NAPCAT_REPORT_PORT || env.NAPCAT_REPORT_PORT || '8787', 10);

  return { accounts, image, baseHttpPort, reportHost, reportPort };
}

export class NapCatFleetManager {
  private instances = new Map<string, NapCatInstance>();
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private readonly config: NapCatFleetConfig;

  constructor(config: NapCatFleetConfig) {
    this.config = config;
  }

  /**
   * Start all configured NapCat instances.
   */
  async startAll(): Promise<void> {
    if (this.config.accounts.length === 0) {
      logger.warn('No NAPCAT_ACCOUNTS configured, fleet manager idle');
      return;
    }

    logger.info({ count: this.config.accounts.length }, 'Starting NapCat fleet');

    for (let i = 0; i < this.config.accounts.length; i++) {
      const account = this.config.accounts[i];
      const httpPort = this.config.baseHttpPort + i * 2;
      const wsPort = httpPort + 1;

      try {
        await this.startInstance(account, httpPort, wsPort);
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
   * Start a single NapCat Docker instance.
   */
  private async startInstance(
    account: NapCatAccountConfig,
    httpPort: number,
    wsPort: number,
  ): Promise<void> {
    const containerName = `napcat-${account.qqAccount}`;

    // Stop existing container if any
    try {
      await execAsync(`docker stop ${containerName}`);
      await execAsync(`docker rm ${containerName}`);
    } catch {
      // Container doesn't exist, that's fine
    }

    // Create data directory for this instance
    const dataDir = path.join(DATA_DIR, 'napcat', account.qqAccount);
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
      '-e', `ACCOUNT=${account.qqAccount}`,
      '-e', 'NAPCAT_GID=0',
      '-e', 'NAPCAT_UID=0',
      '-p', `${httpPort}:3000`,
      '-v', `${dataDir}/config:/app/napcat/config`,
      '-v', `${dataDir}/data:/app/.config/QQ`,
      this.config.image,
    ];

    logger.info({ containerName, httpPort, qqAccount: account.qqAccount }, 'Starting NapCat container');
    await execAsync(`docker ${args.join(' ')}`);

    const connector = new NapCatConnector(account.qqAccount, httpPort);

    const instance: NapCatInstance = {
      qqAccount: account.qqAccount,
      role: account.role,
      containerName,
      httpPort,
      wsPort,
      reportUrl,
      connector,
      status: 'starting',
    };

    this.instances.set(account.qqAccount, instance);
    logger.info({ qqAccount: account.qqAccount, httpPort }, 'NapCat instance started');
  }

  /**
   * Health check all instances, restart failed ones.
   */
  private async healthCheck(): Promise<void> {
    for (const [qqAccount, instance] of this.instances) {
      try {
        const alive = await instance.connector.isAlive();
        const prevStatus = instance.status;
        instance.status = alive ? 'running' : 'error';
        instance.lastHealthCheck = new Date().toISOString();

        if (alive && prevStatus !== 'running') {
          logger.info({ qqAccount }, 'NapCat instance is now running');
        }

        if (!alive && prevStatus === 'running') {
          logger.warn({ qqAccount }, 'NapCat instance became unhealthy, restarting');
          try {
            await execAsync(`docker restart ${instance.containerName}`);
            instance.status = 'starting';
          } catch (err) {
            logger.error({ qqAccount, err }, 'Failed to restart NapCat instance');
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

  /**
   * Get connector for a specific QQ account.
   */
  getConnector(qqAccount: string): NapCatConnector | undefined {
    return this.instances.get(qqAccount)?.connector;
  }

  /**
   * Get the main account's connector.
   */
  getMainConnector(): NapCatConnector | undefined {
    for (const instance of this.instances.values()) {
      if (instance.role === 'main') return instance.connector;
    }
    return undefined;
  }

  /**
   * Get the main account's QQ number.
   */
  getMainAccount(): string | undefined {
    for (const instance of this.instances.values()) {
      if (instance.role === 'main') return instance.qqAccount;
    }
    return undefined;
  }

  /**
   * Get all agent account QQ numbers (non-main).
   */
  getAgentAccounts(): string[] {
    const agents: string[] = [];
    for (const instance of this.instances.values()) {
      if (instance.role === 'agent') agents.push(instance.qqAccount);
    }
    return agents;
  }

  /**
   * Get available (not currently assigned to a task) agent accounts.
   */
  getAvailableAgentAccounts(assignedAccounts: Set<string>): string[] {
    return this.getAgentAccounts().filter((a) => !assignedAccounts.has(a));
  }

  /**
   * Get all instances.
   */
  getAllInstances(): NapCatInstance[] {
    return Array.from(this.instances.values());
  }

  /**
   * Get all QQ accounts managed by the fleet (both main and agent).
   */
  getAllBotAccounts(): Set<string> {
    return new Set(this.instances.keys());
  }

  /**
   * Check if a QQ user ID belongs to one of our bot accounts.
   */
  isBotAccount(userId: string): boolean {
    return this.instances.has(userId);
  }
}
