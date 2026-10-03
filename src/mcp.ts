import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { z } from "zod";
import { ChatGPTSession } from "./auth.js";
import { createGatewayServer, listenOnLoopback } from "./gateway.js";
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  PolicyError,
  loadMcpPolicy,
  permissionArgs,
  pruneTasks,
  resolveProjectDir,
  type McpPolicy,
  type PermissionMode,
} from "./mcp-policy.js";
import { killAllProcesses, runProcess } from "./runner.js";

const FALLBACK_MODEL = "gpt-6-sol";
const MCP_MAX_BODY_BYTES = 64 * 1024 * 1024;
const TIMEOUT_TAIL_CHARS = 2_000;

const TaskArgs = z.object({
  prompt: z.string().min(1),
  model: z.string().min(1).optional(),
  project_dir: z.string().min(1).optional(),
  permission_mode: z.enum(PERMISSION_MODES).optional(),
});
const CheckArgs = z.object({ task_id: z.string().min(1) });

type PreparedTask = {
  readonly prompt: string;
  readonly model: string;
  readonly cwd: string;
  readonly permissionMode: PermissionMode;
  readonly permissionFlags: string[];
};

class TaskTimeoutError extends Error {
  constructor(timeoutMs: number, tail: string) {
    super(`Task exceeded the ${timeoutMs} ms limit and was terminated.${tail ? `\nLast output:\n${tail}` : ""}`);
    this.name = "TaskTimeoutError";
  }
}

async function executeAgentTask(
  session: ChatGPTSession,
  policy: McpPolicy,
  task: PreparedTask,
  onProgress?: (message: string, count: number) => void,
): Promise<string> {
  const { model } = task;
  const secret = randomBytes(32).toString("base64url");
  const server = createGatewayServer({
    session,
    defaultModel: model,
    availableModels: [{ slug: model, displayName: model }],
    policy: { mode: "token", token: secret },
    maxBodyBytes: MCP_MAX_BODY_BYTES,
  });
  let port: number;
  try {
    port = await listenOnLoopback(server, 0);
  } catch (error) {
    server.close();
    throw error;
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: secret,
    ANTHROPIC_API_KEY: secret,
    ANTHROPIC_MODEL: "claude-3-7-sonnet-20250219",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-3-7-sonnet-20250219",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-3-7-sonnet-20250219",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-3-7-sonnet-20250219",
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
  };

  let elapsed = 0;
  const timer = setInterval(() => {
    elapsed += 5;
    onProgress?.(`Agent reasoning with ${model}... (${elapsed}s elapsed)`, elapsed);
  }, 5000);

  try {
    const result = await runProcess({
      command: policy.claudeBinary,
      args: [...task.permissionFlags, "-p", "--", task.prompt],
      cwd: task.cwd,
      env,
      timeoutMs: policy.taskTimeoutMs,
      maxOutputChars: policy.maxOutputChars,
      onStdout: (chunk) => {
        const lastLine = chunk.trim().split("\n").pop() || "";
        if (lastLine) onProgress?.(`[${model}] ${lastLine.slice(0, 160)}`, elapsed);
      },
    });
    if (result.timedOut) throw new TaskTimeoutError(policy.taskTimeoutMs, result.stdout.slice(-TIMEOUT_TAIL_CHARS).trim());
    const truncation = result.outputTruncated ? `\n\n[output truncated to the last ${policy.maxOutputChars} characters]` : "";
    if (result.exitCode === 0) {
      return `${result.stdout.trim() || "Task completed successfully with no terminal output."}${truncation}`;
    }
    const status = result.exitCode === null ? `signal ${result.signal}` : `exit code ${result.exitCode}`;
    return `Task executed (${status}):\n${result.stdout}\n${result.stderr}`.trim() + truncation;
  } finally {
    clearInterval(timer);
    server.close();
  }
}

interface BackgroundTask {
  id: string;
  status: "running" | "completed" | "failed";
  model: string;
  prompt: string;
  projectDir?: string | undefined;
  startedAt: number;
  completedAt?: number | undefined;
  output?: string | undefined;
  error?: string | undefined;
  recentLogs: string[];
}

const backgroundTasks = new Map<string, BackgroundTask>();

export async function runMcpServer(): Promise<void> {
  const policy = loadMcpPolicy(process.env, process.cwd());
  const session = await ChatGPTSession.open();
  const models = await session.listModels();
  const catalogSlugs = models.map((m) => m.slug);
  const modelSlugs = catalogSlugs.length > 0 ? catalogSlugs : ["gpt-6-sol", "gpt-6.1-sol", "gpt-6-luna"];
  const defaultModel = modelSlugs.includes(FALLBACK_MODEL) ? FALLBACK_MODEL : modelSlugs[0] ?? FALLBACK_MODEL;

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.once("close", killAllProcesses);
  process.once("exit", killAllProcesses);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
    process.once(signal, () => {
      killAllProcesses();
      process.exit(0);
    });
  }

  let inFlight = 0;
  function acquireSlot(): () => void {
    if (inFlight >= policy.maxConcurrent) {
      throw new PolicyError("too_many_tasks", `At most ${policy.maxConcurrent} tasks may run at once. Wait for one to finish.`);
    }
    inFlight++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      inFlight--;
    };
  }

  async function prepareTask(rawArgs: unknown): Promise<PreparedTask> {
    const args = TaskArgs.parse(rawArgs);
    const model = args.model ?? defaultModel;
    if (!modelSlugs.includes(model)) {
      throw new PolicyError("model_unavailable", `Model "${model}" is not in the ChatGPT account model catalog.`);
    }
    const permissionMode = args.permission_mode ?? DEFAULT_PERMISSION_MODE;
    const permissionFlags = permissionArgs(permissionMode, policy);
    const cwd = await resolveProjectDir(args.project_dir, policy);
    return { prompt: args.prompt, model, cwd, permissionMode, permissionFlags };
  }

  function sendJson(response: object): void {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }

  function toolText(id: string | number | undefined, text: string, isError: boolean): void {
    sendJson({ jsonrpc: "2.0", id, result: { ...(isError ? { isError: true } : {}), content: [{ type: "text", text }] } });
  }

  function describeFailure(error: unknown): string {
    if (error instanceof z.ZodError) {
      const issue = error.issues[0];
      return `Invalid arguments: ${issue?.path.join(".") || "arguments"}: ${issue?.message ?? "invalid"}.`;
    }
    return error instanceof Error ? error.message : String(error);
  }

  const taskProperties = {
    prompt: {
      type: "string",
      description: "Detailed instruction for the coding agent (e.g., 'Review C# code in Heroll', 'Refactor auth module').",
    },
    model: {
      type: "string",
      enum: modelSlugs,
      description: `Select the ChatGPT brain model to power this task (default: ${defaultModel}).`,
    },
    project_dir: {
      type: "string",
      description: "Absolute path to the project directory to work in. Must be inside CODEX2CC_ALLOWED_ROOTS (defaults to the first allowed root).",
    },
    permission_mode: {
      type: "string",
      enum: [...PERMISSION_MODES],
      description: `Claude Code permission mode (default: ${DEFAULT_PERMISSION_MODE}). bypassPermissions only works when the operator sets CODEX2CC_ALLOW_BYPASS=1.`,
    },
  };

  async function handleLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let message: { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown> };
    try {
      message = JSON.parse(line);
    } catch {
      sendJson({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: request was not valid JSON." } });
      return;
    }

    const { id, method, params } = message;

    if (method === "initialize") {
      sendJson({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: "codex2cc-mcp",
            version: "0.1.0",
          },
        },
      });
      return;
    }

    if (method === "notifications/initialized") {
      return;
    }

    if (method === "tools/list") {
      sendJson({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "run_claude_code_with_chatgpt",
              description: "Execute a software engineering task using Claude Code powered by ChatGPT Plus Codex model. Emits real-time progress notifications to prevent client timeouts.",
              inputSchema: { type: "object", properties: taskProperties, required: ["prompt"] },
            },
            {
              name: "start_claude_code_task",
              description: "Start a long-running software engineering task asynchronously with Claude Code and ChatGPT Codex in the background. Returns immediately with a task_id so Claude Desktop NEVER times out. Call check_claude_code_task to poll progress and get output.",
              inputSchema: { type: "object", properties: taskProperties, required: ["prompt"] },
            },
            {
              name: "check_claude_code_task",
              description: "Check the status and retrieve results or recent logs of a background Claude Code task started with start_claude_code_task.",
              inputSchema: {
                type: "object",
                properties: {
                  task_id: {
                    type: "string",
                    description: "The task_id returned from start_claude_code_task.",
                  },
                },
                required: ["task_id"],
              },
            },
            {
              name: "list_available_chatgpt_models",
              description: "List all ChatGPT models available in your ChatGPT Plus account via Codex.",
              inputSchema: {
                type: "object",
                properties: {},
              },
            },
          ],
        },
      });
      return;
    }

    if (method === "tools/call") {
      const toolName = (params as { name?: string })?.name;
      const progressToken = (params as { _meta?: { progressToken?: string | number } })?._meta?.progressToken;
      const rawArgs = (params as { arguments?: unknown })?.arguments ?? {};

      const sendProgress = (text: string, count?: number): void => {
        if (progressToken !== undefined) {
          sendJson({
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: {
              progressToken,
              progress: count ?? 0,
              message: text,
            },
          });
        }
      };

      if (toolName === "list_available_chatgpt_models") {
        const text = models.map((m) => `• **${m.displayName}** (\`${m.slug}\`)`).join("\n");
        toolText(id, `### Available ChatGPT Plus Models:\n\n${text}`, false);
        return;
      }

      if (toolName === "start_claude_code_task") {
        let prepared: PreparedTask;
        let release: () => void;
        try {
          prepared = await prepareTask(rawArgs);
          release = acquireSlot();
        } catch (error) {
          toolText(id, `Error: ${describeFailure(error)}`, true);
          return;
        }

        pruneTasks(backgroundTasks, Date.now(), policy.taskTtlMs, policy.maxStoredTasks);
        const taskId = `task_${Date.now()}_${randomBytes(6).toString("hex")}`;
        const task: BackgroundTask = {
          id: taskId,
          status: "running",
          model: prepared.model,
          prompt: prepared.prompt,
          projectDir: prepared.cwd,
          startedAt: Date.now(),
          recentLogs: [],
        };
        backgroundTasks.set(taskId, task);

        executeAgentTask(session, policy, prepared, (msg) => {
          task.recentLogs.push(msg);
          if (task.recentLogs.length > 25) task.recentLogs.shift();
        }).then((resultText) => {
          task.status = "completed";
          task.completedAt = Date.now();
          task.output = resultText;
        }).catch((err: unknown) => {
          task.status = "failed";
          task.completedAt = Date.now();
          task.error = err instanceof Error ? err.message : String(err);
        }).finally(release);

        toolText(
          id,
          `### Background Task Started\n- **Task ID:** \`${taskId}\`\n- **Model:** \`${prepared.model}\`\n- **Project Dir:** \`${prepared.cwd}\`\n- **Permission Mode:** \`${prepared.permissionMode}\`\n- **Status:** Running\n\nCall \`check_claude_code_task\` with \`task_id: "${taskId}"\` in 15-30 seconds to read the output.`,
          false,
        );
        return;
      }

      if (toolName === "check_claude_code_task") {
        const parsed = CheckArgs.safeParse(rawArgs);
        if (!parsed.success) {
          toolText(id, `Error: ${describeFailure(parsed.error)}`, true);
          return;
        }
        pruneTasks(backgroundTasks, Date.now(), policy.taskTtlMs, policy.maxStoredTasks);
        const task = backgroundTasks.get(parsed.data.task_id);
        if (!task) {
          toolText(id, `Error: Task '${parsed.data.task_id}' not found or expired.`, true);
          return;
        }

        const duration = Math.round(((task.completedAt ?? Date.now()) - task.startedAt) / 1000);
        let text = `### Task Status: ${task.status.toUpperCase()} (${duration}s elapsed)\n`;
        text += `- **Task ID:** \`${task.id}\`\n`;
        text += `- **Model:** \`${task.model}\`\n\n`;

        if (task.status === "completed") {
          text += `### Result:\n\n${task.output}`;
        } else if (task.status === "failed") {
          text += `### Failure Error:\n\n${task.error}`;
        } else {
          text += `### Recent Activity:\n${task.recentLogs.slice(-5).map((l) => `- ${l}`).join("\n") || "- Working..."}\n\n*Task is still executing. Call check_claude_code_task again shortly.*`;
        }
        toolText(id, text, false);
        return;
      }

      if (toolName === "run_claude_code_with_chatgpt") {
        let prepared: PreparedTask;
        let release: () => void;
        try {
          prepared = await prepareTask(rawArgs);
          release = acquireSlot();
        } catch (error) {
          toolText(id, `Error: ${describeFailure(error)}`, true);
          return;
        }

        try {
          const resultText = await executeAgentTask(session, policy, prepared, sendProgress);
          toolText(id, `### Task Output (Model: ${prepared.model})\n\n${resultText}`, false);
        } catch (err) {
          toolText(id, `Error executing Claude Code task: ${describeFailure(err)}`, true);
        } finally {
          release();
        }
        return;
      }

      sendJson({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Tool '${toolName}' not found.` },
      });
      return;
    }

    if (id !== undefined) {
      sendJson({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method '${method}' not supported.` },
      });
    }
  }

  rl.on("line", (line) => {
    handleLine(line).catch((error: unknown) => {
      process.stderr.write(`${JSON.stringify({ level: "error", operation: "mcp_request", message: describeFailure(error) })}\n`);
      let requestId: string | number | null = null;
      try {
        const parsed = JSON.parse(line) as { id?: string | number };
        requestId = parsed.id ?? null;
      } catch {
        requestId = null;
      }
      sendJson({ jsonrpc: "2.0", id: requestId, error: { code: -32603, message: "Internal error while handling the request." } });
    });
  });
}
