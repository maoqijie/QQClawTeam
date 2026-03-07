import { beforeEach, describe, expect, it } from 'vitest';

import {
  CONTAINER_RUNTIME_BIN,
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';

interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  args: unknown[];
}

function createLoggerRecorder() {
  const entries: LogEntry[] = [];
  return {
    entries,
    logger: {
      debug: (...args: unknown[]) => entries.push({ level: 'debug', args }),
      info: (...args: unknown[]) => entries.push({ level: 'info', args }),
      warn: (...args: unknown[]) => entries.push({ level: 'warn', args }),
      error: (...args: unknown[]) => entries.push({ level: 'error', args }),
    },
  };
}

describe('container-runtime', () => {
  let commands: string[];

  beforeEach(() => {
    commands = [];
  });

  it('returns readonly mount args', () => {
    expect(readonlyMountArgs('/host/path', '/container/path')).toEqual([
      '-v',
      '/host/path:/container/path:ro',
    ]);
  });

  it('returns stop command using runtime binary', () => {
    expect(stopContainer('nanoclaw-test-123')).toBe(
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-test-123`,
    );
  });

  it('does nothing when runtime is already running', () => {
    const logs = createLoggerRecorder();

    ensureContainerRuntimeRunning({
      execSyncFn: ((command: string) => {
        commands.push(command);
        return '';
      }) as typeof import('child_process').execSync,
      loggerLike: logs.logger,
      consoleErrorFn: () => undefined,
    });

    expect(commands).toEqual([`${CONTAINER_RUNTIME_BIN} info`]);
    expect(logs.entries).toContainEqual({
      level: 'debug',
      args: ['Container runtime already running'],
    });
  });

  it('throws when runtime info fails', () => {
    const logs = createLoggerRecorder();
    const stderr: string[] = [];

    expect(() =>
      ensureContainerRuntimeRunning({
        execSyncFn: ((command: string) => {
          commands.push(command);
          throw new Error('Cannot connect to the Docker daemon');
        }) as typeof import('child_process').execSync,
        loggerLike: logs.logger,
        consoleErrorFn: (...args: unknown[]) => {
          stderr.push(args.join(' '));
        },
      }),
    ).toThrow('Container runtime is required but failed to start');

    expect(commands).toEqual([`${CONTAINER_RUNTIME_BIN} info`]);
    expect(logs.entries.some((entry) => entry.level === 'error')).toBe(true);
    expect(stderr.length).toBeGreaterThan(0);
  });

  it('stops orphaned containers', () => {
    const logs = createLoggerRecorder();

    cleanupOrphans({
      execSyncFn: ((command: string) => {
        commands.push(command);
        if (command.includes(' ps ')) {
          return 'nanoclaw-group1-111\nnanoclaw-group2-222\n';
        }
        return '';
      }) as typeof import('child_process').execSync,
      loggerLike: logs.logger,
    });

    expect(commands).toEqual([
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-group1-111`,
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-group2-222`,
    ]);
    expect(logs.entries).toContainEqual({
      level: 'info',
      args: [
        { count: 2, names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'] },
        'Stopped orphaned containers',
      ],
    });
  });

  it('warns and continues when ps fails', () => {
    const logs = createLoggerRecorder();

    cleanupOrphans({
      execSyncFn: ((command: string) => {
        commands.push(command);
        throw new Error('docker not available');
      }) as typeof import('child_process').execSync,
      loggerLike: logs.logger,
    });

    expect(commands).toEqual([
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
    ]);
    expect(logs.entries.some((entry) => entry.level === 'warn')).toBe(true);
  });
});
