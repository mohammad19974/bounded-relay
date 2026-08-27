import { ERROR_CODES, WorkerError } from "../core/errors.js";

export function assertNotRecursing(value: string | undefined): void {
  if (value === undefined || value === "") {
    return;
  }
  if (!/^\d+$/.test(value) || Number(value) > 0) {
    throw new WorkerError(
      ERROR_CODES.CONFIG_INVALID,
      "Refused to start inside another BoundedRelay delegation",
    );
  }
}
