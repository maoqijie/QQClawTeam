import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DATA_DIR } from './config.js';
import { GroupQueue } from './group-queue.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireCallback(
  callback: (() => void) | null,
  label: string,
): () => void {
  if (!callback) {
    throw new Error(`${label} 未准备好`);
  }
  return callback;
}

function createQueue(testName: string): GroupQueue {
  return new GroupQueue({
    dataDir: path.join(DATA_DIR, '__group_queue_tests__', testName),
    maxConcurrentContainers: 2,
    baseRetryMs: 10,
    maxRetries: 3,
  });
}

function getQueueDataDir(testName: string): string {
  return path.join(DATA_DIR, '__group_queue_tests__', testName);
}

describe('GroupQueue', () => {
  beforeEach(() => {
    fs.rmSync(path.join(DATA_DIR, '__group_queue_tests__'), {
      recursive: true,
      force: true,
    });
  });

  afterEach(() => {
    fs.rmSync(path.join(DATA_DIR, '__group_queue_tests__'), {
      recursive: true,
      force: true,
    });
  });

  it('同一群同一时间只运行一个容器', async () => {
    const queue = createQueue('single-group');
    let concurrentCount = 0;
    let maxConcurrent = 0;

    queue.setProcessMessagesFn(async () => {
      concurrentCount += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await sleep(30);
      concurrentCount -= 1;
      return true;
    });

    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');

    await sleep(80);

    expect(maxConcurrent).toBe(1);
  });

  it('遵守全局并发上限', async () => {
    const queue = createQueue('concurrency-limit');
    let activeCount = 0;
    let maxActive = 0;
    const resolvers: Array<() => void> = [];
    let callCount = 0;

    queue.setProcessMessagesFn(async () => {
      callCount += 1;
      activeCount += 1;
      maxActive = Math.max(maxActive, activeCount);
      await new Promise<void>((resolve) => resolvers.push(resolve));
      activeCount -= 1;
      return true;
    });

    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');

    await sleep(10);
    expect(maxActive).toBe(2);
    expect(activeCount).toBe(2);
    expect(callCount).toBe(2);

    resolvers[0]?.();
    await sleep(10);

    expect(callCount).toBe(3);

    resolvers[1]?.();
    resolvers[2]?.();
    await sleep(10);
  });

  it('同群 drain 时任务优先于消息', async () => {
    const queue = createQueue('task-before-message');
    const executionOrder: string[] = [];
    let releaseFirst: (() => void) | null = null;
    let messageCallCount = 0;

    queue.setProcessMessagesFn(async () => {
      messageCallCount += 1;
      if (messageCallCount === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      executionOrder.push('messages');
      return true;
    });

    queue.enqueueMessageCheck('group1@g.us');
    await sleep(10);

    queue.enqueueTask('group1@g.us', 'task-1', async () => {
      executionOrder.push('task');
    });
    queue.enqueueMessageCheck('group1@g.us');

    requireCallback(releaseFirst, 'releaseFirst')();
    await sleep(30);

    expect(executionOrder[0]).toBe('messages');
    expect(executionOrder[1]).toBe('task');
    expect(executionOrder[2]).toBe('messages');
  });

  it('失败后按指数退避重试', async () => {
    const queue = createQueue('retry-backoff');
    let callCount = 0;

    queue.setProcessMessagesFn(async () => {
      callCount += 1;
      return false;
    });

    queue.enqueueMessageCheck('group1@g.us');
    await sleep(5);
    expect(callCount).toBe(1);

    await sleep(15);
    expect(callCount).toBe(2);

    await sleep(25);
    expect(callCount).toBe(3);
  });

  it('shutdown 后不再接受新任务或消息', async () => {
    const queue = createQueue('shutdown');
    let messageCalls = 0;
    let taskCalls = 0;

    queue.setProcessMessagesFn(async () => {
      messageCalls += 1;
      return true;
    });

    await queue.shutdown(0);
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueTask('group1@g.us', 'task-1', async () => {
      taskCalls += 1;
    });

    await sleep(20);

    expect(messageCalls).toBe(0);
    expect(taskCalls).toBe(0);
  });

  it('空闲容器收到任务时会写入 _close 进行抢占', async () => {
    const testName = 'idle-preempt';
    const queue = createQueue(testName);
    let releaseProcess: (() => void) | null = null;

    queue.setProcessMessagesFn(async () => {
      await new Promise<void>((resolve) => {
        releaseProcess = resolve;
      });
      return true;
    });

    queue.enqueueMessageCheck('group1@g.us');
    await sleep(10);
    queue.registerProcess('group1@g.us', {} as any, 'container-1', 'test-group');
    queue.notifyIdle('group1@g.us');

    queue.enqueueTask('group1@g.us', 'task-1', async () => undefined);
    await sleep(10);

    const closePath = path.join(
      getQueueDataDir(testName),
      'ipc',
      'test-group',
      'input',
      '_close',
    );
    expect(fs.existsSync(closePath)).toBe(true);

    requireCallback(releaseProcess, 'releaseProcess')();
    await sleep(10);
  });

  it('sendMessage 会重置 idleWaiting，后续任务不会误抢占', async () => {
    const testName = 'idle-reset';
    const queue = createQueue(testName);
    let releaseProcess: (() => void) | null = null;

    queue.setProcessMessagesFn(async () => {
      await new Promise<void>((resolve) => {
        releaseProcess = resolve;
      });
      return true;
    });

    queue.enqueueMessageCheck('group1@g.us');
    await sleep(10);
    queue.registerProcess('group1@g.us', {} as any, 'container-1', 'test-group');
    queue.notifyIdle('group1@g.us');

    expect(queue.sendMessage('group1@g.us', 'hello')).toBe(true);
    queue.enqueueTask('group1@g.us', 'task-1', async () => undefined);
    await sleep(10);

    const inputDir = path.join(
      getQueueDataDir(testName),
      'ipc',
      'test-group',
      'input',
    );
    const files = fs.existsSync(inputDir) ? fs.readdirSync(inputDir) : [];
    expect(files.some((name) => name === '_close')).toBe(false);
    expect(files.some((name) => name.endsWith('.json'))).toBe(true);

    requireCallback(releaseProcess, 'releaseProcess')();
    await sleep(10);
  });

  it('任务容器不会接收用户消息', async () => {
    const queue = createQueue('task-container');
    let releaseTask: (() => void) | null = null;

    queue.enqueueTask('group1@g.us', 'task-1', async () => {
      await new Promise<void>((resolve) => {
        releaseTask = resolve;
      });
    });

    await sleep(10);
    queue.registerProcess('group1@g.us', {} as any, 'container-1', 'test-group');

    expect(queue.sendMessage('group1@g.us', 'hello')).toBe(false);

    requireCallback(releaseTask, 'releaseTask')();
    await sleep(10);
  });

  it('重复 taskId 不会被重复排队', async () => {
    const queue = createQueue('dedupe-task');
    let releaseTask: (() => void) | null = null;
    let taskCallCount = 0;

    queue.enqueueTask('group1@g.us', 'task-1', async () => {
      taskCallCount += 1;
      await new Promise<void>((resolve) => {
        releaseTask = resolve;
      });
    });

    await sleep(10);
    queue.enqueueTask('group1@g.us', 'task-1', async () => {
      taskCallCount += 100;
    });

    requireCallback(releaseTask, 'releaseTask')();
    await sleep(20);

    expect(taskCallCount).toBe(1);
  });
});
