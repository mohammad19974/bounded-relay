import { describe, expect, test } from "vitest";

import {
  ERROR_CODES,
  WorkerError,
  toErrorMessage,
  toWorkerError,
} from "../src/core/errors.js";

describe("worker error normalization", () => {
  test("preserves an existing typed worker error", () => {
    const error = new WorkerError(ERROR_CODES.INVALID_REQUEST, "invalid");

    expect(error.name).toBe("WorkerError");
    expect(error.code).toBe(ERROR_CODES.INVALID_REQUEST);
    expect(toWorkerError(error)).toBe(error);
  });

  test("normalizes native and unknown failures without leaking their values", () => {
    expect(toErrorMessage(new Error("native failure"))).toBe("native failure");
    expect(toErrorMessage({ secret: "do not stringify" })).toBe(
      "Unknown error",
    );

    expect(toWorkerError(new Error("native failure"))).toMatchObject({
      code: ERROR_CODES.INTERNAL_ERROR,
      message: "native failure",
    });
    expect(toWorkerError("opaque failure")).toMatchObject({
      code: ERROR_CODES.INTERNAL_ERROR,
      message: "Unknown error",
    });
  });
});
