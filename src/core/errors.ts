export const ERROR_CODES = {
  CANCELLED: "CANCELLED",
  CODEX_NOT_FOUND: "CODEX_NOT_FOUND",
  CODEX_INCOMPATIBLE: "CODEX_INCOMPATIBLE",
  CONFIG_INVALID: "CONFIG_INVALID",
  DUPLICATE_IDEMPOTENCY_KEY: "DUPLICATE_IDEMPOTENCY_KEY",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  INVALID_PATH: "INVALID_PATH",
  INVALID_REQUEST: "INVALID_REQUEST",
  JOB_NOT_FOUND: "JOB_NOT_FOUND",
  LEASE_CONFLICT: "LEASE_CONFLICT",
  OUTPUT_LIMIT_EXCEEDED: "OUTPUT_LIMIT_EXCEEDED",
  PATCH_LIMIT_EXCEEDED: "PATCH_LIMIT_EXCEEDED",
  PROPOSALS_DISABLED: "PROPOSALS_DISABLED",
  PROTOCOL_ERROR: "PROTOCOL_ERROR",
  QUEUE_FULL: "QUEUE_FULL",
  REVISION_MISMATCH: "REVISION_MISMATCH",
  REVIEW_INVALID: "REVIEW_INVALID",
  RUNTIME_FAILED: "RUNTIME_FAILED",
  SUBMODULES_UNSUPPORTED: "SUBMODULES_UNSUPPORTED",
  TIMEOUT: "TIMEOUT",
  WORKER_SHUTTING_DOWN: "WORKER_SHUTTING_DOWN",
  WORKTREE_DIRTY: "WORKTREE_DIRTY",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class WorkerError extends Error {
  public readonly code: ErrorCode;

  public constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "WorkerError";
    this.code = code;
  }
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export function toWorkerError(error: unknown): WorkerError {
  if (error instanceof WorkerError) {
    return error;
  }

  return new WorkerError(ERROR_CODES.INTERNAL_ERROR, toErrorMessage(error));
}
