import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
import {
  ERROR_CODES,
  WorkerError,
  toErrorMessage,
  toWorkerError,
} from "../core/errors.js";
import { buildChildEnvironment } from "../security/environment-policy.js";
import { buildWorkerPrompt } from "../security/task-prompt.js";
import { buildCodexInvocation } from "./codex-command.js";
import { JsonlDecoder } from "./jsonl-decoder.js";

type StopReason = "user" | "shutdown" | "timeout" | "output-limit" | "protocol";

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
    let outputBytes = 0;
    let stderr = "";
    let finalMessage: string | undefined;
    let sessionId: string | undefined;
    let usage: UsageSummary | undefined;
    let terminalEventSeen = false;
    let observedFailure: WorkerFailure | undefined;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

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
      onEvent(parsed.event);
    });

    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > this.#config.maxOutputBytes) {
        observedFailure = {
          code: ERROR_CODES.OUTPUT_LIMIT_EXCEEDED,
          message: "Codex exceeded the configured output limit",
        };
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
      if (Buffer.byteLength(stderr) < 16_384) {
        stderr += stderrDecoder.write(chunk).slice(0, 16_384);
      }
      if (outputBytes > this.#config.maxOutputBytes) {
        observedFailure = {
          code: ERROR_CODES.OUTPUT_LIMIT_EXCEEDED,
          message: "Codex exceeded the configured output limit",
        };
        requestStop("output-limit");
      }
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      const notFound = error.code === "ENOENT";
      finish({
        outcome: "failed",
        resultTruncated: false,
        failure: {
          code: notFound
            ? ERROR_CODES.CODEX_NOT_FOUND
            : ERROR_CODES.RUNTIME_FAILED,
          message: notFound
            ? "Codex executable could not be started"
            : sanitizeFailure(toErrorMessage(error)),
        },
      });
    });

    child.on("close", (exitCode, signal) => {
      try {
        jsonl.push(stdoutDecoder.end());
        jsonl.finish();
        stderr += stderrDecoder.end();
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
          failure: {
            code: ERROR_CODES.TIMEOUT,
            message: `Codex exceeded the ${request.timeoutMs}ms timeout`,
          },
        });
        return;
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
          failure: {
            code: ERROR_CODES.RUNTIME_FAILED,
            message: sanitizeFailure(
              stderr ||
                `Codex exited with ${exitCode ?? "no code"}${signal ? ` (${signal})` : ""}`,
            ),
          },
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

    child.stdin.on("error", (error) => {
      observedFailure = {
        code: ERROR_CODES.RUNTIME_FAILED,
        message: sanitizeFailure(
          `Could not send task to Codex: ${toErrorMessage(error)}`,
        ),
      };
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

function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    if (process.platform === "win32") {
      const killer = spawn(
        "taskkill.exe",
        ["/pid", String(child.pid), "/t", "/f"],
        { shell: false, stdio: "ignore", windowsHide: true },
      );
      killer.unref();
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process may already be gone.
    }
  }
}

function parseCodexEvent(value: unknown): {
  readonly event: RuntimeEvent;
  readonly terminal: boolean;
  readonly failure?: WorkerFailure;
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
    const nestedError = isRecord(value.error) ? value.error : undefined;
    const message =
      (typeof value.message === "string" && value.message) ||
      (typeof nestedError?.message === "string" && nestedError.message) ||
      "Codex reported a failed turn";
    return {
      event,
      terminal: true,
      failure: {
        code: ERROR_CODES.RUNTIME_FAILED,
        message: sanitizeFailure(message),
      },
    };
  }

  return { event, terminal: rawType === "turn.completed" };
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

function sanitizeFailure(message: string): string {
  return message
    .replaceAll(/\p{Cc}+/gu, " ")
    .trim()
    .slice(0, 1_000);
}
