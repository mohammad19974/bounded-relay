import { spawn } from "node:child_process";
import { win32 } from "node:path";
import { StringDecoder } from "node:string_decoder";

import type { WorkerConfig } from "../config/worker-config.js";
import type {
  JobActivity,
  ResolvedJobRequest,
  RuntimeEvent,
  RuntimeHandle,
  RuntimeResult,
  UsageSummary,
  WorkerFailure,
  WorkerRuntime,
} from "../core/types.js";
import { ERROR_CODES, WorkerError, toWorkerError } from "../core/errors.js";
import { buildChildEnvironment } from "../security/environment-policy.js";
import { publicRuntimeFailure } from "../security/redaction-policy.js";
import { buildWorkerPrompt } from "../security/task-prompt.js";
import { buildCodexInvocation } from "./codex-command.js";
import { JsonlDecoder } from "./jsonl-decoder.js";

type StopReason = "user" | "shutdown" | "timeout" | "output-limit" | "protocol";
type CommandExecutionOutcome = "succeeded" | "failed";

const PUBLIC_EVENT_TYPES = new Set([
  "thread.started",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "error",
  "item.started",
  "item.updated",
  "item.completed",
]);

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class CodexRuntime implements WorkerRuntime {
  readonly #config: WorkerConfig;
  readonly #environment: NodeJS.ProcessEnv;

  public constructor(
    config: WorkerConfig,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.#config = config;
    this.#environment = environment;
  }

  public start(
    request: ResolvedJobRequest,
    onEvent: (event: RuntimeEvent) => void,
  ): RuntimeHandle {
    const invocation = buildCodexInvocation(request, this.#config);
    const environment = {
      ...buildChildEnvironment(this.#environment, this.#config),
      CCW_DELEGATION_DEPTH: "1",
    };
    const child = spawn(invocation.executable, [...invocation.args], {
      cwd: invocation.cwd,
      detached: process.platform !== "win32",
      env: environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let settled = false;
    let stopReason: StopReason | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let outputBytes = 0;
    let finalMessage: string | undefined;
    let sessionId: string | undefined;
    let usage: UsageSummary | undefined;
    let terminalEventSeen = false;
    let observedFailure: WorkerFailure | undefined;
    let successfulCommandCount = 0;
    let failedCommandCount = 0;
    const stdoutDecoder = new StringDecoder("utf8");

    let resolveCompletion: (value: RuntimeResult) => void = () => undefined;
    const completion = new Promise<RuntimeResult>((resolvePromise) => {
      resolveCompletion = resolvePromise;
    });

    const finish = (result: RuntimeResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
      }
      if (drainTimer !== undefined) {
        clearTimeout(drainTimer);
      }
      resolveCompletion(result);
    };

    const requestStop = (reason: StopReason): void => {
      if (settled || stopReason !== undefined) {
        return;
      }
      stopReason = reason;
      terminateProcessTree(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        terminateProcessTree(child, "SIGKILL");
      }, this.#config.cancelGraceMs);
      forceKillTimer.unref();
    };

    const timeoutTimer = setTimeout(() => {
      requestStop("timeout");
    }, request.timeoutMs);
    timeoutTimer.unref();

    const jsonl = new JsonlDecoder((value) => {
      const parsed = parseCodexEvent(value);
      terminalEventSeen ||= parsed.terminal;
      if (parsed.event.sessionId !== undefined) {
        sessionId = parsed.event.sessionId;
      }
      if (parsed.event.agentMessage !== undefined) {
        finalMessage = parsed.event.agentMessage;
      }
      if (parsed.event.usage !== undefined) {
        usage = parsed.event.usage;
      }
      if (parsed.failure !== undefined) {
        observedFailure = parsed.failure;
      }
      if (parsed.commandOutcome === "succeeded") {
        successfulCommandCount += 1;
      } else if (parsed.commandOutcome === "failed") {
        failedCommandCount += 1;
      }
      onEvent(parsed.event);
    });

    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > this.#config.maxOutputBytes) {
        observedFailure = publicRuntimeFailure("output-limit");
        requestStop("output-limit");
        return;
      }
      try {
        jsonl.push(stdoutDecoder.write(chunk));
      } catch (error) {
        const workerError = toWorkerError(error);
        observedFailure = {
          code: workerError.code,
          message: workerError.message,
        };
        requestStop("protocol");
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > this.#config.maxOutputBytes) {
        observedFailure = publicRuntimeFailure("output-limit");
        requestStop("output-limit");
      }
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      const notFound = error.code === "ENOENT";
      finish({
        outcome: "failed",
        resultTruncated: false,
        failure: publicRuntimeFailure(
          notFound ? "executable-not-found" : "process-start",
        ),
      });
    });

    // `close` waits for every inherited stdio pipe. A descendant that escaped
    // the process group keeps those pipes open, so the run would never settle
    // and its concurrency slot would leak. Once the Codex process itself is
    // gone, give the pipes a bounded drain window and then force them shut.
    child.once("exit", () => {
      if (settled || drainTimer !== undefined) {
        return;
      }
      drainTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
      }, this.#config.cancelGraceMs);
      drainTimer.unref();
    });

    child.on("close", (exitCode) => {
      try {
        jsonl.push(stdoutDecoder.end());
        jsonl.finish();
      } catch (error) {
        const workerError = toWorkerError(error);
        observedFailure ??= {
          code: workerError.code,
          message: workerError.message,
        };
      }

      if (stopReason === "user" || stopReason === "shutdown") {
        finish({ outcome: "cancelled", resultTruncated: false });
        return;
      }
      if (stopReason === "timeout") {
        finish({
          outcome: "failed",
          resultTruncated: false,
          failure: publicRuntimeFailure("timeout"),
        });
        return;
      }
      if (
        observedFailure === undefined &&
        ((failedCommandCount > 0 && successfulCommandCount === 0) ||
          (request.sddReview?.seal.mode === "strict" &&
            successfulCommandCount === 0))
      ) {
        observedFailure = publicRuntimeFailure("command-failure");
      }
      if (observedFailure !== undefined) {
        finish({
          outcome: "failed",
          resultTruncated: stopReason === "output-limit",
          failure: observedFailure,
        });
        return;
      }
      if (exitCode !== 0) {
        finish({
          outcome: "failed",
          resultTruncated: false,
          failure: publicRuntimeFailure("nonzero-exit"),
        });
        return;
      }
      if (
        !terminalEventSeen ||
        finalMessage === undefined ||
        finalMessage.trim() === ""
      ) {
        finish({
          outcome: "failed",
          resultTruncated: false,
          failure: {
            code: ERROR_CODES.PROTOCOL_ERROR,
            message:
              "Codex exited successfully without a complete final result",
          },
        });
        return;
      }

      finish({
        outcome: "completed",
        finalMessage,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(usage === undefined ? {} : { usage }),
        resultTruncated: false,
      });
    });

    child.stdin.on("error", () => {
      observedFailure = publicRuntimeFailure("stdin");
      requestStop("protocol");
    });
    child.stdin.end(buildWorkerPrompt(request), "utf8");

    return {
      completion,
      cancel: async (reason) => {
        requestStop(reason);
      },
    };
  }
}

export interface ProcessTreeChild {
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface TaskkillProcess {
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  unref(): void;
}

export type SpawnTaskkill = (
  executable: string,
  args: readonly string[],
  options: {
    readonly shell: false;
    readonly stdio: "ignore";
    readonly windowsHide: true;
  },
) => TaskkillProcess;

export interface TerminateProcessTreeOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly spawnTaskkill?: SpawnTaskkill;
}

export function terminateProcessTree(
  child: ProcessTreeChild,
  signal: NodeJS.Signals,
  options: TerminateProcessTreeOptions = {},
): void {
  if (child.pid === undefined) {
    return;
  }
  const platform = options.platform ?? process.platform;

  if (platform === "win32") {
    const executable = resolveWindowsTaskkillExecutable(
      options.environment ?? process.env,
    );
    if (executable === undefined) {
      killSingleProcess(child, signal);
      return;
    }

    let fallbackAttempted = false;
    const fallback = (): void => {
      if (fallbackAttempted) {
        return;
      }
      fallbackAttempted = true;
      killSingleProcess(child, signal);
    };

    try {
      const spawnTaskkill: SpawnTaskkill =
        options.spawnTaskkill ??
        ((command, args, spawnOptions) =>
          spawn(command, [...args], spawnOptions));
      const killer = spawnTaskkill(
        executable,
        ["/pid", String(child.pid), "/t", "/f"],
        { shell: false, stdio: "ignore", windowsHide: true },
      );
      killer.once("error", fallback);
      killer.once("exit", (code) => {
        if (code !== 0) {
          fallback();
        }
      });
      killer.unref();
    } catch {
      fallback();
    }
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch {
    killSingleProcess(child, signal);
  }
}

export function resolveWindowsTaskkillExecutable(
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const systemRoot =
    readWindowsEnvironmentValue(environment, "SYSTEMROOT") ??
    readWindowsEnvironmentValue(environment, "WINDIR");
  if (systemRoot === undefined || !win32.isAbsolute(systemRoot)) {
    return undefined;
  }
  return win32.join(systemRoot, "System32", "taskkill.exe");
}

function readWindowsEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const normalizedName = name.toUpperCase();
  for (const [candidateName, value] of Object.entries(environment)) {
    if (candidateName.toUpperCase() === normalizedName && value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function killSingleProcess(
  child: ProcessTreeChild,
  signal: NodeJS.Signals,
): void {
  try {
    child.kill(signal);
  } catch {
    // The process may already be gone.
  }
}

function parseCodexEvent(value: unknown): {
  readonly event: RuntimeEvent;
  readonly terminal: boolean;
  readonly failure?: WorkerFailure;
  readonly commandOutcome?: CommandExecutionOutcome;
} {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new WorkerError(
      ERROR_CODES.PROTOCOL_ERROR,
      "Codex emitted a JSONL event without a string type",
    );
  }

  const rawType = value.type;
  const type = normalizeEventType(rawType);
  const item = isRecord(value.item) ? value.item : undefined;
  const commandOutcome = commandExecutionOutcome(rawType, item);
  const activity = classifyActivity(rawType, item);
  const sessionId =
    rawType === "thread.started"
      ? normalizeSessionId(value.thread_id)
      : undefined;
  const event: RuntimeEvent = {
    type,
    ...(activity === undefined ? {} : { activity }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(rawType === "item.completed" && item?.type === "command_execution"
      ? { commandCompleted: true }
      : {}),
    ...(rawType === "item.completed" &&
    item?.type === "agent_message" &&
    typeof item.text === "string"
      ? { agentMessage: item.text }
      : {}),
    ...(rawType === "turn.completed" && isRecord(value.usage)
      ? { usage: parseUsage(value.usage) }
      : {}),
  };

  if (rawType === "error" || rawType === "turn.failed") {
    return {
      event,
      terminal: true,
      failure: publicRuntimeFailure("failed-turn"),
    };
  }

  return {
    event,
    terminal: rawType === "turn.completed",
    ...(commandOutcome === undefined ? {} : { commandOutcome }),
  };
}

function classifyActivity(
  type: string,
  item: Record<string, unknown> | undefined,
): JobActivity | undefined {
  if (type === "thread.started") {
    return "codex_started";
  }
  if (type === "turn.started") {
    return "reasoning";
  }
  if (type === "turn.completed") {
    return "response_ready";
  }
  if (type === "turn.failed" || type === "error") {
    return "failed";
  }
  if (
    type !== "item.started" &&
    type !== "item.updated" &&
    type !== "item.completed"
  ) {
    return "working";
  }

  if (item?.type === "command_execution") {
    return type === "item.completed" ? "command_completed" : "running_command";
  }
  if (item?.type === "agent_message") {
    return type === "item.completed" ? "response_ready" : "composing_response";
  }
  if (item?.type === "reasoning") {
    return "reasoning";
  }
  if (item?.type === "todo_list") {
    return "planning";
  }
  if (item?.type === "file_change") {
    return "preparing_changes";
  }
  if (item?.type === "mcp_tool_call") {
    return "using_tool";
  }
  if (item?.type === "web_search") {
    return "researching";
  }
  return "working";
}

function commandExecutionOutcome(
  type: string,
  item: Record<string, unknown> | undefined,
): CommandExecutionOutcome | undefined {
  if (type !== "item.completed" || item?.type !== "command_execution") {
    return undefined;
  }

  const status = item.status;
  const exitCode = item.exit_code;
  if (
    status === "failed" ||
    status === "declined" ||
    (typeof exitCode === "number" && exitCode !== 0)
  ) {
    return "failed";
  }
  if (
    (status === "completed" && (exitCode === undefined || exitCode === 0)) ||
    (status === undefined && exitCode === 0)
  ) {
    return "succeeded";
  }
  return undefined;
}

function normalizeEventType(type: string): string {
  return PUBLIC_EVENT_TYPES.has(type) ? type : "unknown";
}

function normalizeSessionId(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_SESSION_ID.test(value)
    ? value
    : undefined;
}

function parseUsage(value: Record<string, unknown>): UsageSummary {
  return {
    inputTokens: numeric(value.input_tokens),
    cachedInputTokens: numeric(value.cached_input_tokens),
    outputTokens: numeric(value.output_tokens),
    reasoningOutputTokens: numeric(value.reasoning_output_tokens),
  };
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
