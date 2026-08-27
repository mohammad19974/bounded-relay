export const SDD_ROUTING_ERROR_CODES = {
  INVALID_INPUT: "INVALID_INPUT",
  INVALID_TASK: "INVALID_TASK",
  DUPLICATE_TASK_ID: "DUPLICATE_TASK_ID",
  UNKNOWN_DEPENDENCY: "UNKNOWN_DEPENDENCY",
  DEPENDENCY_CYCLE: "DEPENDENCY_CYCLE",
  INVALID_WRITE_SCOPE: "INVALID_WRITE_SCOPE",
} as const;

export type SddRoutingErrorCode =
  (typeof SDD_ROUTING_ERROR_CODES)[keyof typeof SDD_ROUTING_ERROR_CODES];

export class SddRoutingError extends Error {
  public readonly code: SddRoutingErrorCode;

  public constructor(code: SddRoutingErrorCode, message: string) {
    super(message);
    this.name = "SddRoutingError";
    this.code = code;
  }
}
