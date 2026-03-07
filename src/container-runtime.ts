/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

export interface ContainerRuntimeDeps {
  execSyncFn?: typeof execSync;
  loggerLike?: Pick<typeof logger, 'debug' | 'info' | 'warn' | 'error'>;
  consoleErrorFn?: typeof console.error;
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(
  deps: ContainerRuntimeDeps = {},
): void {
  const execSyncFn = deps.execSyncFn || execSync;
  const loggerLike = deps.loggerLike || logger;
  const consoleErrorFn = deps.consoleErrorFn || console.error;
  try {
    execSyncFn(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    loggerLike.debug('Container runtime already running');
  } catch (err) {
    loggerLike.error({ err }, 'Failed to reach container runtime');
    consoleErrorFn(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    consoleErrorFn(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    consoleErrorFn(
      '║                                                                ║',
    );
    consoleErrorFn(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    consoleErrorFn(
      '║  1. Ensure Docker is installed and running                     ║',
    );
    consoleErrorFn(
      '║  2. Run: docker info                                           ║',
    );
    consoleErrorFn(
      '║  3. Restart NanoClaw                                           ║',
    );
    consoleErrorFn(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start');
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(deps: ContainerRuntimeDeps = {}): void {
  const execSyncFn = deps.execSyncFn || execSync;
  const loggerLike = deps.loggerLike || logger;
  try {
    const output = execSyncFn(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        execSyncFn(stopContainer(name), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      loggerLike.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    loggerLike.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
