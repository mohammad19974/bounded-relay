import { ERROR_CODES } from "../core/errors.js";
import type { FailureDiagnostics, WorkerFailure } from "../core/types.js";

const REDACTION_MARKER = "[REDACTED]";
const MIN_REDACTION_VALUE_CHARS = 4;
const MAX_REDACTION_VALUE_CHARS = 4_096;
const MAX_REDACTION_VALUES = 64;
const MAX_REDACTED_TEXT_CHARS = 4_096;

export type RuntimeFailureKind =
  | "executable-not-found"
  | "process-start"
  | "output-limit"
  | "protocol"
  | "timeout"
  | "failed-turn"
  | "command-failure"
  | "nonzero-exit"
  | "stdin"
  | "generic";

const RUNTIME_FAILURES: Readonly<Record<RuntimeFailureKind, WorkerFailure>> = {
  "executable-not-found": {
    code: ERROR_CODES.CODEX_NOT_FOUND,
    message: "Codex executable could not be started",
  },
  "process-start": {
    code: ERROR_CODES.RUNTIME_FAILED,
    message: "The Codex process could not be started",
  },
  "output-limit": {
    code: ERROR_CODES.OUTPUT_LIMIT_EXCEEDED,
    message: "Codex exceeded the configured output limit",
  },
  protocol: {
    code: ERROR_CODES.PROTOCOL_ERROR,
    message: "Codex returned an invalid or incomplete response",
  },
  timeout: {
    code: ERROR_CODES.TIMEOUT,
    message: "Codex exceeded the configured timeout",
  },
  "failed-turn": {
    code: ERROR_CODES.RUNTIME_FAILED,
    message: "Codex reported a failed turn",
  },
  "command-failure": {
    code: ERROR_CODES.RUNTIME_FAILED,
    message: "Codex command execution failed",
  },
  "nonzero-exit": {
    code: ERROR_CODES.RUNTIME_FAILED,
    message: "Codex exited unsuccessfully",
  },
  stdin: {
    code: ERROR_CODES.RUNTIME_FAILED,
    message: "The worker could not send the task to Codex",
  },
  generic: {
    code: ERROR_CODES.RUNTIME_FAILED,
    message: "Codex execution failed",
  },
};

/**
 * Public runtime failures are selected from server-owned text only. Child
 * stderr, event payloads, spawn errors, and adapter-supplied messages are
 * intentionally not accepted by this boundary.
 */
export function publicRuntimeFailure(kind: RuntimeFailureKind): WorkerFailure {
  return RUNTIME_FAILURES[kind];
}

export function normalizePublicRuntimeFailure(
  failure: WorkerFailure | undefined,
): WorkerFailure {
  const diagnostics = sanitizeFailureDiagnostics(failure?.diagnostics);
  const base = selectSafeFailure(failure);
  return diagnostics === undefined ? base : { ...base, diagnostics };
}

function selectSafeFailure(failure: WorkerFailure | undefined): WorkerFailure {
  if (failure !== undefined) {
    for (const safeFailure of Object.values(RUNTIME_FAILURES)) {
      if (
        failure.code === safeFailure.code &&
        failure.message === safeFailure.message
      ) {
        return safeFailure;
      }
    }
  }

  switch (failure?.code) {
    case ERROR_CODES.CODEX_NOT_FOUND:
      return publicRuntimeFailure("executable-not-found");
    case ERROR_CODES.OUTPUT_LIMIT_EXCEEDED:
      return publicRuntimeFailure("output-limit");
    case ERROR_CODES.PROTOCOL_ERROR:
      return publicRuntimeFailure("protocol");
    case ERROR_CODES.TIMEOUT:
      return publicRuntimeFailure("timeout");
    default:
      return publicRuntimeFailure("generic");
  }
}

const DIAGNOSTIC_STOP_REASONS: ReadonlySet<string> = new Set([
  "timeout",
  "output-limit",
  "protocol",
]);
const DIAGNOSTIC_COUNTERS = [
  "eventCount",
  "commandsSucceeded",
  "commandsFailed",
  "stdoutBytes",
  "stderrBytes",
  "elapsedMs",
  "partialMessageChars",
] as const;

/**
 * Keeps only server-derived numeric and enum diagnostic fields. Unknown keys,
 * strings, and negative or non-integer numbers are dropped so child-provided
 * text can never ride along with a public failure.
 */
export function sanitizeFailureDiagnostics(
  value: unknown,
): FailureDiagnostics | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const diagnostics: {
    -readonly [K in keyof FailureDiagnostics]: FailureDiagnostics[K];
  } = {};
  if (
    typeof record.stopReason === "string" &&
    DIAGNOSTIC_STOP_REASONS.has(record.stopReason)
  ) {
    diagnostics.stopReason = record.stopReason as
      "timeout" | "output-limit" | "protocol";
  }
  if (
    typeof record.exitCode === "number" &&
    Number.isInteger(record.exitCode)
  ) {
    diagnostics.exitCode = record.exitCode;
  }
  for (const key of DIAGNOSTIC_COUNTERS) {
    const candidate = record[key];
    if (
      typeof candidate === "number" &&
      Number.isInteger(candidate) &&
      candidate >= 0
    ) {
      diagnostics[key] = candidate;
    }
  }
  return Object.keys(diagnostics).length === 0 ? undefined : diagnostics;
}

/**
 * Removes known literal values from bounded public text. Empty, very short,
 * and absent candidates are ignored so an unrelated large environment does
 * not erase otherwise useful diagnostics. If too many or oversized secrets
 * are actually present, the whole diagnostic fails closed to one marker.
 */
export function redactKnownValues(
  value: string,
  knownValues: readonly (string | undefined)[],
): string {
  const eligibleValues = knownValues.filter(
    (candidate): candidate is string =>
      typeof candidate === "string" &&
      candidate.length >= MIN_REDACTION_VALUE_CHARS,
  );
  const presentValues = [...new Set(eligibleValues)].filter((candidate) =>
    value.includes(candidate),
  );
  if (
    presentValues.length > MAX_REDACTION_VALUES ||
    presentValues.some(
      (candidate) => candidate.length > MAX_REDACTION_VALUE_CHARS,
    )
  ) {
    return REDACTION_MARKER;
  }
  const candidates = presentValues.sort(
    (left, right) => right.length - left.length,
  );
  const lookahead = candidates.reduce(
    (maximum, candidate) => Math.max(maximum, candidate.length),
    0,
  );
  let redacted = value.slice(0, MAX_REDACTED_TEXT_CHARS + lookahead);
  for (const candidate of candidates) {
    redacted = redacted.replaceAll(candidate, REDACTION_MARKER);
  }
  return redacted.slice(0, MAX_REDACTED_TEXT_CHARS);
}
