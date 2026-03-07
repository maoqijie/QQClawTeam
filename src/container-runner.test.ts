import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { PassThrough } from 'stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import {
  type ContainerOutput,
  runContainerAgent,
} from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

class FakeChildProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  pid = 12345;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(proc: FakeChildProcess, output: ContainerOutput) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('container-runner timeout behavior', () => {
  const pathsToClean = [
    path.join(GROUPS_DIR, 'test-group'),
    path.join(DATA_DIR, 'sessions', 'test-group'),
    path.join(DATA_DIR, 'ipc', 'test-group'),
  ];

  beforeEach(() => {
    for (const target of pathsToClean) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    for (const target of pathsToClean) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('timeout after output resolves as success', async () => {
    const proc = new FakeChildProcess();
    const streamed: ContainerOutput[] = [];

    const resultPromise = runContainerAgent(
      testGroup,
      { ...testInput },
      () => undefined,
      async (output) => {
        streamed.push(output);
      },
      {
        spawnFn: (() => proc) as unknown as typeof import('child_process').spawn,
        execFn: ((
          _command: string,
          _options: unknown,
          callback?: (error: Error | null) => void,
        ) => {
          callback?.(null);
          return new EventEmitter() as never;
        }) as unknown as typeof import('child_process').exec,
        timeoutMs: 50,
      },
    );

    emitOutputMarker(proc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    await sleep(10);
    await sleep(80);
    proc.emit('close', 137);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(streamed).toContainEqual(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const proc = new FakeChildProcess();
    const streamed: ContainerOutput[] = [];

    const resultPromise = runContainerAgent(
      testGroup,
      { ...testInput },
      () => undefined,
      async (output) => {
        streamed.push(output);
      },
      {
        spawnFn: (() => proc) as unknown as typeof import('child_process').spawn,
        execFn: ((
          _command: string,
          _options: unknown,
          callback?: (error: Error | null) => void,
        ) => {
          callback?.(null);
          return new EventEmitter() as never;
        }) as unknown as typeof import('child_process').exec,
        timeoutMs: 50,
      },
    );

    await sleep(80);
    proc.emit('close', 137);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(streamed).toHaveLength(0);
  });

  it('normal exit after output resolves as success', async () => {
    const proc = new FakeChildProcess();
    const streamed: ContainerOutput[] = [];

    const resultPromise = runContainerAgent(
      testGroup,
      { ...testInput },
      () => undefined,
      async (output) => {
        streamed.push(output);
      },
      {
        spawnFn: (() => proc) as unknown as typeof import('child_process').spawn,
        execFn: ((
          _command: string,
          _options: unknown,
          callback?: (error: Error | null) => void,
        ) => {
          callback?.(null);
          return new EventEmitter() as never;
        }) as unknown as typeof import('child_process').exec,
        timeoutMs: 500,
      },
    );

    emitOutputMarker(proc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await sleep(10);
    proc.emit('close', 0);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
    expect(streamed).toContainEqual(
      expect.objectContaining({ result: 'Done' }),
    );
  });
});
