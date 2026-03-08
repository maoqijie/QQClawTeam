/**
 * OpenAI-compatible API backend for NanoClaw Agent Runner
 *
 * Implements a full agent loop with tool calling (function calling)
 * using the OpenAI SDK. Supports any OpenAI-compatible API via baseURL
 * (OpenAI, DeepSeek, Ollama, etc.).
 *
 * Reuses the same ContainerInput/Output protocol and IPC mechanism
 * as the Claude SDK backend.
 */

import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import { execSync, ExecSyncOptionsWithStringEncoding } from 'child_process';
import { CronExpressionParser } from 'cron-parser';

// --- Shared types (mirrored from index.ts) ---

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
  llmBackend?: string;
  llmModel?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

// --- IPC constants (same as index.ts) ---

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

const MAX_TOOL_LOOPS = 50;
const MAX_HISTORY_MESSAGES = 100;

interface ResponseApiOutputTextItem {
  type: 'output_text';
  text?: string;
}

interface ResponseApiMessageItem {
  type: 'message';
  role?: string;
  content?: ResponseApiOutputTextItem[];
}

interface ResponseApiFunctionCallItem {
  type: 'function_call';
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface ResponseApiLikeResult {
  output?: Array<ResponseApiMessageItem | ResponseApiFunctionCallItem>;
}

interface NormalizedAssistantTurn {
  message: ChatCompletionAssistantMessageParam;
  text: string | null;
  transport: 'chat' | 'responses';
}

interface ExecutedToolResult {
  name: string;
  arguments: Record<string, unknown> | null;
  result: string;
}

interface ManualToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

interface ManualToolCallsDirective {
  type: 'tool_calls';
  calls: ManualToolCall[];
}

interface ManualFinalDirective {
  type: 'final';
  message: string;
}

type ManualDirective = ManualToolCallsDirective | ManualFinalDirective;

// --- Utility functions ---

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[openai-runner] ${message}`);
}

function isStandardChatCompletionResponse(response: unknown): response is {
  choices: Array<{
    message: ChatCompletionAssistantMessageParam;
  }>;
} {
  return (
    typeof response === 'object' &&
    response !== null &&
    'choices' in response &&
    Array.isArray((response as { choices?: unknown }).choices)
  );
}

function isResponseApiLikeResult(
  response: unknown,
): response is ResponseApiLikeResult {
  return (
    typeof response === 'object' &&
    response !== null &&
    'output' in response &&
    Array.isArray((response as { output?: unknown }).output)
  );
}

function extractTextFromResponseMessage(
  item: ResponseApiMessageItem,
): string | null {
  const texts = (item.content || [])
    .filter(
      (contentItem): contentItem is ResponseApiOutputTextItem =>
        contentItem.type === 'output_text',
    )
    .map((contentItem) => contentItem.text || '')
    .filter(Boolean);

  return texts.length > 0 ? texts.join('\n') : null;
}

function normalizeAssistantTurn(
  response: unknown,
): NormalizedAssistantTurn | null {
  if (isStandardChatCompletionResponse(response)) {
    const choice = response.choices[0];
    if (!choice) {
      return null;
    }

    const message = choice.message;
    return {
      message,
      text: typeof message.content === 'string' ? message.content : null,
      transport: 'chat',
    };
  }

  if (!isResponseApiLikeResult(response)) {
    return null;
  }

  const outputItems = response.output || [];
  const toolCalls: ChatCompletionMessageToolCall[] = [];
  const textParts: string[] = [];

  for (const item of outputItems) {
    if (item.type === 'function_call') {
      if (!item.name) {
        continue;
      }

      const toolCallId = item.call_id || item.id;
      if (!toolCallId) {
        continue;
      }

      toolCalls.push({
        id: toolCallId,
        type: 'function',
        function: {
          name: item.name,
          arguments: item.arguments || '{}',
        },
      });
      continue;
    }

    if (item.type === 'message' && item.role === 'assistant') {
      const text = extractTextFromResponseMessage(item);
      if (text) {
        textParts.push(text);
      }
    }
  }

  if (toolCalls.length === 0 && textParts.length === 0) {
    return null;
  }

  const text = textParts.length > 0 ? textParts.join('\n') : null;
  return {
    message: {
      role: 'assistant',
      content: text,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
    text,
    transport: 'responses',
  };
}

function buildResponseRelayAssistantMessage(
  toolCalls: ChatCompletionMessageToolCall[],
  assistantText: string | null,
): ChatCompletionAssistantMessageParam {
  const summary = toolCalls.map((toolCall) => ({
    name: toolCall.function.name,
    arguments: toolCall.function.arguments,
  }));

  const parts = [
    assistantText ? `已有回复片段：\n${assistantText}` : null,
    `我请求执行以下工具调用：\n${JSON.stringify(summary, null, 2)}`,
  ].filter(Boolean);

  return {
    role: 'assistant',
    content: parts.join('\n\n'),
  };
}

function buildResponseRelayUserMessage(
  toolResults: ExecutedToolResult[],
): ChatCompletionMessageParam {
  return {
    role: 'user',
    content: [
      '以下是你刚才请求的工具执行结果（JSON）：',
      JSON.stringify(toolResults, null, 2),
      '请继续完成任务。',
      '如果还需要更多工具，请继续调用；如果已经足够，请直接给出最终答复。',
    ].join('\n\n'),
  };
}

function buildManualToolProtocol(tools: ChatCompletionTool[]): string {
  const toolDescriptions = tools.map((tool) => {
    const parameters = JSON.stringify(tool.function.parameters || {}, null, 2);
    return [
      `Tool: ${tool.function.name}`,
      `Description: ${tool.function.description || '(none)'}`,
      `Parameters JSON Schema:\n${parameters}`,
    ].join('\n');
  });

  return [
    'You must use a manual JSON tool protocol.',
    'Always reply with JSON only. Do not wrap JSON in markdown fences. Do not add prose before or after the JSON.',
    'When you need one or more tools, reply with exactly one JSON object in this shape:',
    '{"type":"tool_calls","calls":[{"name":"tool_name","arguments":{}}]}',
    'When you are completely finished, reply with exactly one JSON object in this shape:',
    '{"type":"final","message":"your final answer"}',
    'Never invent tools. Never omit required arguments. Never repeat an identical completed tool call unless you truly need to rerun it.',
    'Available tools:',
    toolDescriptions.join('\n\n'),
  ].join('\n\n');
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }

  return trimmed
    .replace(/^```[a-zA-Z0-9_-]*\s*/, '')
    .replace(/\s*```$/, '')
    .trim();
}

function extractJsonObjects(text: string): unknown[] {
  const normalized = stripCodeFences(text);

  try {
    return [JSON.parse(normalized)];
  } catch {
    // Fall through to multi-object extraction.
  }

  const results: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) {
        start = i;
      }
      depth++;
      continue;
    }

    if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        const candidate = normalized.slice(start, i + 1);
        try {
          results.push(JSON.parse(candidate));
        } catch {
          // Ignore malformed segments.
        }
        start = -1;
      }
    }
  }

  return results;
}

function isManualToolCall(value: unknown): value is ManualToolCall {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string' &&
    typeof (value as { arguments?: unknown }).arguments === 'object' &&
    (value as { arguments?: unknown }).arguments !== null &&
    !Array.isArray((value as { arguments?: unknown }).arguments)
  );
}

function parseManualDirectives(text: string): ManualDirective[] {
  const directives: ManualDirective[] = [];

  for (const candidate of extractJsonObjects(text)) {
    if (
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as { type?: unknown }).type === 'tool_calls' &&
      Array.isArray((candidate as { calls?: unknown }).calls)
    ) {
      const calls = (candidate as { calls: unknown[] }).calls.filter(isManualToolCall);
      if (calls.length > 0) {
        directives.push({ type: 'tool_calls', calls });
      }
      continue;
    }

    if (
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as { type?: unknown }).type === 'final' &&
      typeof (candidate as { message?: unknown }).message === 'string'
    ) {
      directives.push({
        type: 'final',
        message: (candidate as { message: string }).message,
      });
    }
  }

  return directives;
}

function buildManualToolResultMessage(
  toolResults: ExecutedToolResult[],
): ChatCompletionMessageParam {
  return {
    role: 'user',
    content: [
      'The requested tool calls have been executed successfully.',
      'Do not repeat any identical completed call unless rerun is necessary.',
      'Tool results (JSON):',
      JSON.stringify(toolResults, null, 2),
      'Continue. Return JSON only.',
    ].join('\n\n'),
  };
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

// --- IPC file writing (inline from ipc-mcp-stdio.ts) ---

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

// --- Tool definitions ---

function buildToolDefinitions(isMain: boolean): ChatCompletionTool[] {
  const tools: ChatCompletionTool[] = [];

  // send_message
  tools.push({
    type: 'function',
    function: {
      name: 'send_message',
      description:
        "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages.",
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The message text to send' },
          sender: {
            type: 'string',
            description: 'Your role/identity name (e.g. "Researcher").',
          },
        },
        required: ['text'],
      },
    },
  });

  // schedule_task
  tools.push({
    type: 'function',
    function: {
      name: 'schedule_task',
      description:
        'Schedule a recurring or one-time task. Returns the task ID.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'What the agent should do when the task runs.',
          },
          schedule_type: {
            type: 'string',
            enum: ['cron', 'interval', 'once'],
            description: 'cron=recurring, interval=every N ms, once=run once',
          },
          schedule_value: {
            type: 'string',
            description: 'cron expression, milliseconds, or local timestamp',
          },
          context_mode: {
            type: 'string',
            enum: ['group', 'isolated'],
            description: 'group=with chat history, isolated=fresh session',
          },
          target_group_jid: {
            type: 'string',
            description: '(Main only) JID of target group',
          },
        },
        required: ['prompt', 'schedule_type', 'schedule_value'],
      },
    },
  });

  // list_tasks
  tools.push({
    type: 'function',
    function: {
      name: 'list_tasks',
      description:
        "List all scheduled tasks. Main sees all; others see only their group's tasks.",
      parameters: { type: 'object', properties: {} },
    },
  });

  // pause_task
  tools.push({
    type: 'function',
    function: {
      name: 'pause_task',
      description: 'Pause a scheduled task.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The task ID to pause' },
        },
        required: ['task_id'],
      },
    },
  });

  // resume_task
  tools.push({
    type: 'function',
    function: {
      name: 'resume_task',
      description: 'Resume a paused task.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The task ID to resume' },
        },
        required: ['task_id'],
      },
    },
  });

  // cancel_task
  tools.push({
    type: 'function',
    function: {
      name: 'cancel_task',
      description: 'Cancel and delete a scheduled task.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The task ID to cancel' },
        },
        required: ['task_id'],
      },
    },
  });

  // update_task
  tools.push({
    type: 'function',
    function: {
      name: 'update_task',
      description:
        'Update an existing scheduled task. Only provided fields are changed.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The task ID to update' },
          prompt: { type: 'string', description: 'New prompt' },
          schedule_type: { type: 'string', enum: ['cron', 'interval', 'once'] },
          schedule_value: { type: 'string', description: 'New schedule value' },
        },
        required: ['task_id'],
      },
    },
  });

  // register_group (main only)
  if (isMain) {
    tools.push({
      type: 'function',
      function: {
        name: 'register_group',
        description:
          'Register a new chat/group so the agent can respond to messages there. Main group only.',
        parameters: {
          type: 'object',
          properties: {
            jid: { type: 'string', description: 'The chat JID' },
            name: { type: 'string', description: 'Display name for the group' },
            folder: {
              type: 'string',
              description:
                'Channel-prefixed folder name (e.g., "whatsapp_family-chat")',
            },
            trigger: {
              type: 'string',
              description: 'Trigger word (e.g., "@Andy")',
            },
          },
          required: ['jid', 'name', 'folder', 'trigger'],
        },
      },
    });
  }

  // bash
  tools.push({
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Execute a bash command in the container. Working directory is /workspace/group.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The bash command to execute',
          },
          timeout: {
            type: 'number',
            description: 'Timeout in milliseconds (default: 120000)',
          },
        },
        required: ['command'],
      },
    },
  });

  // read_file
  tools.push({
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from the filesystem.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute or relative path to the file',
          },
          offset: {
            type: 'number',
            description: 'Line number to start from (1-based)',
          },
          limit: { type: 'number', description: 'Number of lines to read' },
        },
        required: ['path'],
      },
    },
  });

  // write_file
  tools.push({
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file, creating directories if needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path' },
          content: { type: 'string', description: 'The content to write' },
        },
        required: ['path', 'content'],
      },
    },
  });

  // search_files (glob)
  tools.push({
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for files matching a glob pattern.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob pattern (e.g., "**/*.ts")',
          },
          path: {
            type: 'string',
            description: 'Directory to search in (default: /workspace/group)',
          },
        },
        required: ['pattern'],
      },
    },
  });

  // search_content (grep)
  tools.push({
    type: 'function',
    function: {
      name: 'search_content',
      description: 'Search file contents using a regex pattern (like grep).',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Regex pattern to search for',
          },
          path: {
            type: 'string',
            description:
              'File or directory to search in (default: /workspace/group)',
          },
          include: {
            type: 'string',
            description: 'Glob pattern to filter files (e.g., "*.ts")',
          },
        },
        required: ['pattern'],
      },
    },
  });

  return tools;
}

// --- Tool execution ---

// Secrets to strip from Bash tool subprocess environments
const SECRET_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
];

function executeTool(
  name: string,
  args: Record<string, unknown>,
  containerInput: ContainerInput,
): string {
  const { chatJid, groupFolder, isMain } = containerInput;

  try {
    switch (name) {
      case 'send_message': {
        const data: Record<string, string | undefined> = {
          type: 'message',
          chatJid,
          text: args.text as string,
          sender: (args.sender as string) || undefined,
          groupFolder,
          timestamp: new Date().toISOString(),
        };
        writeIpcFile(MESSAGES_DIR, data);
        return 'Message sent.';
      }

      case 'schedule_task': {
        const scheduleType = args.schedule_type as string;
        const scheduleValue = args.schedule_value as string;

        // Validate
        if (scheduleType === 'cron') {
          try {
            CronExpressionParser.parse(scheduleValue);
          } catch {
            return `Invalid cron: "${scheduleValue}". Use format like "0 9 * * *".`;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(scheduleValue, 10);
          if (isNaN(ms) || ms <= 0)
            return `Invalid interval: "${scheduleValue}".`;
        } else if (scheduleType === 'once') {
          if (
            /[Zz]$/.test(scheduleValue) ||
            /[+-]\d{2}:\d{2}$/.test(scheduleValue)
          ) {
            return `Timestamp must be local time without timezone suffix. Got "${scheduleValue}".`;
          }
          if (isNaN(new Date(scheduleValue).getTime())) {
            return `Invalid timestamp: "${scheduleValue}".`;
          }
        }

        const targetJid =
          isMain && args.target_group_jid
            ? (args.target_group_jid as string)
            : chatJid;
        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        writeIpcFile(TASKS_DIR, {
          type: 'schedule_task',
          taskId,
          prompt: args.prompt,
          schedule_type: scheduleType,
          schedule_value: scheduleValue,
          context_mode: (args.context_mode as string) || 'group',
          targetJid,
          createdBy: groupFolder,
          timestamp: new Date().toISOString(),
        });

        return `Task ${taskId} scheduled: ${scheduleType} - ${scheduleValue}`;
      }

      case 'list_tasks': {
        const tasksFile = path.join(IPC_DIR, 'current_tasks.json');
        if (!fs.existsSync(tasksFile)) return 'No scheduled tasks found.';

        const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
        const tasks = isMain
          ? allTasks
          : allTasks.filter(
              (t: { groupFolder: string }) => t.groupFolder === groupFolder,
            );

        if (tasks.length === 0) return 'No scheduled tasks found.';

        return (
          'Scheduled tasks:\n' +
          tasks
            .map(
              (t: {
                id: string;
                prompt: string;
                schedule_type: string;
                schedule_value: string;
                status: string;
                next_run: string;
              }) =>
                `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
            )
            .join('\n')
        );
      }

      case 'pause_task': {
        writeIpcFile(TASKS_DIR, {
          type: 'pause_task',
          taskId: args.task_id,
          groupFolder,
          isMain,
          timestamp: new Date().toISOString(),
        });
        return `Task ${args.task_id} pause requested.`;
      }

      case 'resume_task': {
        writeIpcFile(TASKS_DIR, {
          type: 'resume_task',
          taskId: args.task_id,
          groupFolder,
          isMain,
          timestamp: new Date().toISOString(),
        });
        return `Task ${args.task_id} resume requested.`;
      }

      case 'cancel_task': {
        writeIpcFile(TASKS_DIR, {
          type: 'cancel_task',
          taskId: args.task_id,
          groupFolder,
          isMain,
          timestamp: new Date().toISOString(),
        });
        return `Task ${args.task_id} cancellation requested.`;
      }

      case 'update_task': {
        const data: Record<string, string | undefined> = {
          type: 'update_task',
          taskId: args.task_id as string,
          groupFolder,
          isMain: String(isMain),
          timestamp: new Date().toISOString(),
        };
        if (args.prompt !== undefined) data.prompt = args.prompt as string;
        if (args.schedule_type !== undefined)
          data.schedule_type = args.schedule_type as string;
        if (args.schedule_value !== undefined)
          data.schedule_value = args.schedule_value as string;

        writeIpcFile(TASKS_DIR, data);
        return `Task ${args.task_id} update requested.`;
      }

      case 'register_group': {
        if (!isMain) return 'Only the main group can register new groups.';
        writeIpcFile(TASKS_DIR, {
          type: 'register_group',
          jid: args.jid,
          name: args.name,
          folder: args.folder,
          trigger: args.trigger,
          timestamp: new Date().toISOString(),
        });
        return `Group "${args.name}" registered.`;
      }

      case 'bash': {
        const command = args.command as string;
        const timeout = (args.timeout as number) || 120000;
        const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;

        try {
          const opts: ExecSyncOptionsWithStringEncoding = {
            cwd: '/workspace/group',
            timeout,
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024,
            stdio: ['pipe', 'pipe', 'pipe'],
          };
          const result = execSync(unsetPrefix + command, opts);
          return result || '(no output)';
        } catch (err: unknown) {
          const execErr = err as {
            status?: number;
            stdout?: string;
            stderr?: string;
            message?: string;
          };
          const stdout = execErr.stdout || '';
          const stderr = execErr.stderr || '';
          return `Exit code: ${execErr.status || 'unknown'}\nStdout: ${stdout}\nStderr: ${stderr}`;
        }
      }

      case 'read_file': {
        const filePath = args.path as string;
        const absPath = path.isAbsolute(filePath)
          ? filePath
          : path.join('/workspace/group', filePath);

        if (!fs.existsSync(absPath)) return `File not found: ${absPath}`;

        const content = fs.readFileSync(absPath, 'utf-8');
        const lines = content.split('\n');

        const offset = ((args.offset as number) || 1) - 1; // Convert to 0-based
        const limit = (args.limit as number) || lines.length;
        const selected = lines.slice(offset, offset + limit);

        return selected
          .map(
            (line, i) => `${(offset + i + 1).toString().padStart(6)}\t${line}`,
          )
          .join('\n');
      }

      case 'write_file': {
        const filePath = args.path as string;
        const absPath = path.isAbsolute(filePath)
          ? filePath
          : path.join('/workspace/group', filePath);

        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, args.content as string);
        return `File written: ${absPath}`;
      }

      case 'search_files': {
        const searchPath = (args.path as string) || '/workspace/group';
        const pattern = args.pattern as string;
        try {
          const result = execSync(
            `find ${JSON.stringify(searchPath)} -type f -name ${JSON.stringify(pattern)} 2>/dev/null | head -100`,
            { encoding: 'utf-8', timeout: 30000 },
          );
          return result.trim() || 'No files found.';
        } catch {
          return 'No files found.';
        }
      }

      case 'search_content': {
        const searchPath = (args.path as string) || '/workspace/group';
        const pattern = args.pattern as string;
        const include = args.include as string | undefined;

        const grepArgs = ['-rn', '--color=never'];
        if (include) grepArgs.push(`--include=${include}`);
        grepArgs.push(JSON.stringify(pattern), JSON.stringify(searchPath));

        try {
          const result = execSync(
            `grep ${grepArgs.join(' ')} 2>/dev/null | head -200`,
            { encoding: 'utf-8', timeout: 30000 },
          );
          return result.trim() || 'No matches found.';
        } catch {
          return 'No matches found.';
        }
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Tool execution error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// --- System prompt builder ---

function buildSystemPrompt(
  containerInput: ContainerInput,
  tools: ChatCompletionTool[],
): string {
  const parts: string[] = [];

  // Load group-level CLAUDE.md
  const groupClaudeMd = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(groupClaudeMd)) {
    parts.push(fs.readFileSync(groupClaudeMd, 'utf-8'));
  }

  // Load global CLAUDE.md (for non-main groups)
  const globalClaudeMd = '/workspace/global/CLAUDE.md';
  if (!containerInput.isMain && fs.existsSync(globalClaudeMd)) {
    parts.push(fs.readFileSync(globalClaudeMd, 'utf-8'));
  }

  // Base instructions
  const assistantName = containerInput.assistantName || 'Assistant';
  parts.push(`You are ${assistantName}, an AI assistant.`);
  parts.push(
    'You have access to tools for executing bash commands, reading/writing files, searching files and content, sending messages, and managing scheduled tasks.',
  );
  parts.push('Your working directory is /workspace/group.');
  parts.push(`Current time: ${new Date().toISOString()}`);
  parts.push(buildManualToolProtocol(tools));

  return parts.join('\n\n');
}

// --- Main agent loop ---

async function runAgentLoop(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[],
  containerInput: ContainerInput,
): Promise<string | null> {
  let loopCount = 0;

  while (loopCount < MAX_TOOL_LOOPS) {
    loopCount++;
    log(`Agent loop iteration ${loopCount}`);

    let response;
    try {
      response = await client.chat.completions.create({
        model,
        messages,
      });
    } catch (err: unknown) {
      const apiErr = err as {
        status?: number;
        message?: string;
        error?: { message?: string };
      };

      // Rate limit: wait and retry
      if (apiErr.status === 429) {
        log('Rate limited, waiting 10s before retry...');
        await new Promise((r) => setTimeout(r, 10000));
        continue;
      }

      // Context overflow: truncate history and retry
      if (apiErr.status === 400 && apiErr.error?.message?.includes('context')) {
        log('Context overflow, truncating history...');
        // Keep system message + last few messages
        if (messages.length > 4) {
          const systemMsg = messages[0];
          const recentMessages = messages.slice(-3);
          messages.length = 0;
          messages.push(systemMsg, ...recentMessages);
          continue;
        }
      }

      throw err;
    }

    const normalizedTurn = normalizeAssistantTurn(response);
    if (!normalizedTurn) {
      log('No assistant message in response');
      return null;
    }

    const assistantText = normalizedTurn.text?.trim();
    if (!assistantText) {
      messages.push({ role: 'assistant', content: '' });
      messages.push({
        role: 'user',
        content:
          'Your last response was empty. Return exactly one JSON object using the required protocol.',
      });
      continue;
    }

    messages.push({ role: 'assistant', content: assistantText });

    const directives = parseManualDirectives(assistantText);
    const toolDirective = directives.find(
      (directive): directive is ManualToolCallsDirective =>
        directive.type === 'tool_calls',
    );

    if (toolDirective) {
      const executedToolResults: ExecutedToolResult[] = [];

      for (const call of toolDirective.calls) {
        log(`Tool call: ${call.name}(${JSON.stringify(call.arguments).slice(0, 200)})`);
        const result = executeTool(call.name, call.arguments, containerInput);
        log(`Tool result: ${result.slice(0, 200)}`);
        executedToolResults.push({
          name: call.name,
          arguments: call.arguments,
          result,
        });
      }

      messages.push(buildManualToolResultMessage(executedToolResults));

      if (shouldClose()) {
        log('Close sentinel detected during tool execution');
        return null;
      }
      continue;
    }

    const finalDirective = directives.find(
      (directive): directive is ManualFinalDirective =>
        directive.type === 'final',
    );
    if (finalDirective) {
      return finalDirective.message;
    }

    messages.push({
      role: 'user',
      content:
        'Your last response did not follow the required JSON protocol. Return exactly one JSON object and nothing else.',
    });

    // Check for close sentinel between tool calls
    if (shouldClose()) {
      log('Close sentinel detected during tool execution');
      return null;
    }
  }

  log(`Max tool loops (${MAX_TOOL_LOOPS}) reached`);
  return 'I reached the maximum number of tool call iterations. Please try again with a simpler request.';
}

// --- Exported entry point ---

export async function runOpenAIBackend(
  containerInput: ContainerInput,
): Promise<void> {
  const apiKey = containerInput.secrets?.OPENAI_API_KEY;
  const baseURL = containerInput.secrets?.OPENAI_BASE_URL;
  const model = containerInput.llmModel || 'gpt-4o';

  if (!apiKey) {
    writeOutput({
      status: 'error',
      result: null,
      error:
        'OPENAI_API_KEY not set. Add it to .env or set it as an environment variable.',
    });
    process.exit(1);
  }

  const client = new OpenAI({
    apiKey,
    baseURL: baseURL || undefined,
  });

  log(
    `OpenAI backend initialized (model: ${model}, baseURL: ${baseURL || 'default'})`,
  );

  const tools = buildToolDefinitions(containerInput.isMain);
  const systemPrompt = buildSystemPrompt(containerInput, tools);

  // Conversation history (persists across IPC messages within this container session)
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
  ];

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  // Clean up stale _close sentinel
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  // Build initial prompt
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Main conversation loop
  try {
    while (true) {
      log(`Processing message (${prompt.length} chars)...`);

      // Add user message
      messages.push({ role: 'user', content: prompt });

      // Truncate history if too long
      if (messages.length > MAX_HISTORY_MESSAGES) {
        const systemMsg = messages[0];
        const recentMessages = messages.slice(-(MAX_HISTORY_MESSAGES - 1));
        messages.length = 0;
        messages.push(systemMsg, ...recentMessages);
        log(`Truncated history to ${messages.length} messages`);
      }

      // Run agent loop
      const result = await runAgentLoop(
        client,
        model,
        messages,
        tools,
        containerInput,
      );

      writeOutput({
        status: 'success',
        result: result,
      });

      // Check if we should close
      if (shouldClose()) {
        log('Close sentinel received after query, exiting');
        break;
      }

      log('Query ended, waiting for next IPC message...');

      // Wait for next message or close
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars)`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      error: errorMessage,
    });
    process.exit(1);
  }
}
