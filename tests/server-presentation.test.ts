import { describe, expect, test } from "vitest";

import type { JobResult, PublicJobSnapshot } from "../src/core/types.js";
import { presentJobResult } from "../src/mcp/server.js";

function snapshot(
  overrides: Partial<PublicJobSnapshot> = {},
): PublicJobSnapshot {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    revision: 2,
    status: "completed",
    mode: "analyze",
    cwd: "/work",
    repositoryRoot: "/work",
    createdAt: "2026-08-31T00:00:00.000Z",
    progress: {
      phase: "terminal",
      activity: "completed",
      activityLabel: "Job completed",
      eventCount: 1,
      commandCount: 0,
      messageCount: 1,
      updatedAt: "2026-08-31T00:00:01.000Z",
      elapsedMs: 1_000,
      sinceLastUpdateMs: 0,
    },
    resultAvailable: true,
    resultTruncated: false,
    ...overrides,
  };
}

function result(
  jobOverrides: Partial<PublicJobSnapshot>,
  finalMessage?: string,
): JobResult {
  return {
    ready: true,
    job: snapshot(jobOverrides),
    ...(finalMessage === undefined ? {} : { finalMessage }),
  };
}

describe("presentJobResult", () => {
  test("adds no hints or partial markers to a plain successful result", () => {
    const presented = presentJobResult(
      result({ sessionId: "thread-1" }, "done"),
      false,
    ) as Record<string, unknown>;

    expect(presented.resumeHint).toBeUndefined();
    expect(presented.notice).toBeUndefined();
    expect(presented.finalMessagePartial).toBeUndefined();
    expect(presented.finalMessage).toBe("done");
  });

  test("adds a resume hint only for a persisted observed session", () => {
    const presented = presentJobResult(
      result({ sessionId: "thread-1", sessionPersisted: true }, "done"),
      false,
    ) as Record<string, unknown>;

    expect(String(presented.resumeHint)).toContain("resumeSessionId");
  });

  test("truncates an oversized final message so the frame stays readable", () => {
    const presented = presentJobResult(
      result({}, "x".repeat(4_500_000)),
      false,
    ) as Record<string, unknown>;

    const message = String(presented.finalMessage);
    expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(3_000_000);
    expect(presented.finalMessagePartial).toBe(true);
    expect(String(presented.notice)).toContain("truncated");
    // The server frame carries the payload twice; the bounded message must
    // keep the doubled frame under the 8 MiB transport cap.
    expect(
      Buffer.byteLength(JSON.stringify(presented), "utf8") * 2,
    ).toBeLessThan(8 * 1024 * 1024);
  });

  test("never truncates a multi-byte message mid-codepoint", () => {
    const presented = presentJobResult(
      result({}, "🙂".repeat(1_000_000)),
      false,
    ) as Record<string, unknown>;

    const message = String(presented.finalMessage);
    expect(message.includes("�")).toBe(false);
    expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(3_000_000);
  });

  test("keeps a large patch plus a large message inside the transport frame", () => {
    const withPatch: JobResult = {
      ready: true,
      job: snapshot({ mode: "proposal" }),
      finalMessage: "m".repeat(2_500_000),
      proposal: {
        effect: "proposal",
        baselineRevision: "a".repeat(40),
        changedFiles: ["src/a.ts"],
        patch: "p".repeat(1_900_000),
        patchBytes: 1_900_000,
        patchSha256: "b".repeat(64),
      },
    };

    const presented = presentJobResult(withPatch, true) as Record<
      string,
      unknown
    >;

    // The frame carries the payload twice, so message + patch together must
    // stay under the transport cap or the whole result becomes unreadable.
    expect(
      Buffer.byteLength(JSON.stringify(presented), "utf8") * 2,
    ).toBeLessThan(8 * 1024 * 1024);
    expect(presented.finalMessagePartial).toBe(true);
    const proposal = presented.proposal as Record<string, unknown>;
    expect(proposal.patch).toBe("p".repeat(1_900_000));
  });

  test("never truncates mid-codepoint at a non-aligned budget", () => {
    // 3-byte codepoints do not divide the cap evenly, so the cut lands inside
    // a character and the guard must trim it.
    const presented = presentJobResult(
      result({}, "☃".repeat(1_200_000)),
      false,
    ) as Record<string, unknown>;

    const message = String(presented.finalMessage);
    expect(message.includes("�")).toBe(false);
    expect(message.endsWith("☃")).toBe(true);
  });

  test("combines the failed-partial and transport-truncation notices", () => {
    const presented = presentJobResult(
      result(
        { status: "failed", resultAvailable: false },
        "y".repeat(4_500_000),
      ),
      false,
    ) as Record<string, unknown>;

    expect(presented.finalMessagePartial).toBe(true);
    expect(String(presented.notice)).toContain("PARTIAL RESULT");
    expect(String(presented.notice)).toContain("truncated");
  });
});
