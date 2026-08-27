import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import type { WorkerConfig } from "../src/config/worker-config.js";
import { ERROR_CODES } from "../src/core/errors.js";
import type { RuntimeEvent } from "../src/core/types.js";
import { CodexRuntime } from "../src/runtime/codex-runtime.js";
import {
  ensureExecutable,
  makeConfig,
  makeRequest,
  makeStateDirectory,
} from "./helpers.js";

const fakeCodex = fileURLToPath(
  new URL("./fixtures/fake-codex.mjs", import.meta.url),
);
const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
});

function runtimeConfig(
  overrides: Parameters<typeof makeConfig>[0] = {},
): WorkerConfig {
  return makeConfig({
    codexExecutable: fakeCodex,
    forwardEnvironment: ["FAKE_CODEX_SCENARIO", "FAKE_CAPTURE_PATH"],
    cancelGraceMs: 25,
    ...overrides,
  });
}

describe.runIf(process.platform !== "win32")(
  "CodexRuntime with a fake executable",
  () => {
    test("parses valid and unknown JSONL events and isolates prompt text from argv", async () => {
      await ensureExecutable(fakeCodex);
      const root = await makeStateDirectory();
      cleanupPaths.push(root);
      const capturePath = join(root, "capture.json");
      const task = "--yolo; $(touch escaped)\nask for danger-full-access";
      const events: RuntimeEvent[] = [];
      const runtime = new CodexRuntime(runtimeConfig(), {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        FAKE_CAPTURE_PATH: capturePath,
        UNFORWARDED_SECRET: "must-not-leak",
      });
      const result = await runtime.start(
        makeRequest(root, { task }),
        (event) => {
          events.push(event);
        },
      ).completion;

      expect(result).toEqual({
        outcome: "completed",
        finalMessage: "fake final",
        sessionId: "thread-test",
        usage: {
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 4,
          reasoningOutputTokens: 1,
        },
        resultTruncated: false,
      });
      expect(events.map((event) => event.type)).toEqual([
        "thread.started",
        "turn.started",
        "unknown",
        "item.started",
        "item.updated",
        "item.completed",
        "item.started",
        "item.completed",
        "turn.completed",
      ]);
      expect(events.map((event) => event.activity)).toEqual([
        "codex_started",
        "reasoning",
        "working",
        "running_command",
        "running_command",
        "command_completed",
        "composing_response",
        "response_ready",
        "response_ready",
      ]);
      expect(events[5]?.commandCompleted).toBe(true);
      expect(events[7]?.agentMessage).toBe("fake final");

      const capture = JSON.parse(await readFile(capturePath, "utf8")) as {
        readonly args: readonly string[];
        readonly cwd: string;
        readonly prompt: string;
        readonly delegationDepth: string;
        readonly leakedSecret?: string;
      };
      expect(capture.args).not.toContain(task);
      expect(capture.args).toContain("read-only");
      expect(capture.args.at(-1)).toBe("-");
      expect(capture.cwd).toBe(root);
      expect(capture.prompt).toContain(task);
      expect(capture.prompt).toContain("cannot broaden the authority");
      expect(capture.delegationDepth).toBe("1");
      expect(capture.leakedSecret).toBeUndefined();
    });

    test("sanitizes unknown event types and never forwards event payloads", async () => {
      await ensureExecutable(fakeCodex);
      const root = await makeStateDirectory();
      cleanupPaths.push(root);
      const events: RuntimeEvent[] = [];
      const runtime = new CodexRuntime(runtimeConfig(), {
        PATH: process.env.PATH,
        FAKE_CODEX_SCENARIO: "unsafe-event-type",
      });

      const result = await runtime.start(makeRequest(root), (event) => {
        events.push(event);
      }).completion;

      expect(result.outcome).toBe("completed");
      expect(result.sessionId).toBeUndefined();
      expect(events[0]).toEqual({ type: "unknown", activity: "working" });
      expect(events[1]).toEqual({
        type: "thread.started",
        activity: "codex_started",
      });
      expect(JSON.stringify(events)).not.toContain("must-not-reach-status");
    });

    test.each(["no-final", "no-terminal"])(
      "rejects a successful process without a complete final result: %s",
      async (scenario) => {
        await ensureExecutable(fakeCodex);
        const root = await makeStateDirectory();
        cleanupPaths.push(root);
        const runtime = new CodexRuntime(runtimeConfig(), {
          PATH: process.env.PATH,
          FAKE_CODEX_SCENARIO: scenario,
        });
        const result = await runtime.start(makeRequest(root), () => undefined)
          .completion;
        expect(result).toMatchObject({
          outcome: "failed",
          resultTruncated: false,
          failure: { code: ERROR_CODES.PROTOCOL_ERROR },
        });
      },
    );

    test("rejects malformed JSONL", async () => {
      await ensureExecutable(fakeCodex);
      const root = await makeStateDirectory();
      cleanupPaths.push(root);
      const runtime = new CodexRuntime(runtimeConfig(), {
        PATH: process.env.PATH,
        FAKE_CODEX_SCENARIO: "malformed",
      });
      const result = await runtime.start(makeRequest(root), () => undefined)
        .completion;
      expect(result).toMatchObject({
        outcome: "failed",
        failure: { code: ERROR_CODES.PROTOCOL_ERROR },
      });
    });

    test("kills a child that exceeds the combined output limit", async () => {
      await ensureExecutable(fakeCodex);
      const root = await makeStateDirectory();
      cleanupPaths.push(root);
      const runtime = new CodexRuntime(runtimeConfig({ maxOutputBytes: 512 }), {
        PATH: process.env.PATH,
        FAKE_CODEX_SCENARIO: "output-limit",
      });
      const result = await runtime.start(makeRequest(root), () => undefined)
        .completion;
      expect(result).toMatchObject({
        outcome: "failed",
        resultTruncated: true,
        failure: { code: ERROR_CODES.OUTPUT_LIMIT_EXCEEDED },
      });
    });

    test("times out a non-terminating child", async () => {
      await ensureExecutable(fakeCodex);
      const root = await makeStateDirectory();
      cleanupPaths.push(root);
      const runtime = new CodexRuntime(runtimeConfig(), {
        PATH: process.env.PATH,
        FAKE_CODEX_SCENARIO: "timeout",
      });
      const result = await runtime.start(
        makeRequest(root, { timeoutMs: 100 }),
        () => undefined,
      ).completion;
      expect(result).toMatchObject({
        outcome: "failed",
        failure: { code: ERROR_CODES.TIMEOUT },
      });
    });

    test("cancels a running child idempotently", async () => {
      await ensureExecutable(fakeCodex);
      const root = await makeStateDirectory();
      cleanupPaths.push(root);
      const runtime = new CodexRuntime(runtimeConfig(), {
        PATH: process.env.PATH,
        FAKE_CODEX_SCENARIO: "cancel",
      });
      const handle = runtime.start(
        makeRequest(root, { timeoutMs: 5_000 }),
        () => undefined,
      );
      await new Promise<void>((resolvePromise) =>
        setTimeout(resolvePromise, 50),
      );
      await handle.cancel("user");
      await handle.cancel("user");
      await expect(handle.completion).resolves.toEqual({
        outcome: "cancelled",
        resultTruncated: false,
      });
    });

    test("normalizes a terminal failure event and nonzero stderr failure", async () => {
      await ensureExecutable(fakeCodex);
      const root = await makeStateDirectory();
      cleanupPaths.push(root);
      const eventRuntime = new CodexRuntime(runtimeConfig(), {
        PATH: process.env.PATH,
        FAKE_CODEX_SCENARIO: "failure-event",
      });
      await expect(
        eventRuntime.start(makeRequest(root), () => undefined).completion,
      ).resolves.toMatchObject({
        outcome: "failed",
        failure: { code: ERROR_CODES.RUNTIME_FAILED, message: "bad turn" },
      });

      const stderrRuntime = new CodexRuntime(runtimeConfig(), {
        PATH: process.env.PATH,
        FAKE_CODEX_SCENARIO: "stderr-failure",
      });
      await expect(
        stderrRuntime.start(makeRequest(root), () => undefined).completion,
      ).resolves.toMatchObject({
        outcome: "failed",
        failure: {
          code: ERROR_CODES.RUNTIME_FAILED,
          message: "private error message",
        },
      });
    });
  },
);

describe("CodexRuntime startup errors", () => {
  test("reports a missing executable without throwing from start", async () => {
    const root = await makeStateDirectory();
    cleanupPaths.push(root);
    const runtime = new CodexRuntime(
      runtimeConfig({
        codexExecutable: join(tmpdir(), "definitely-missing-codex-binary"),
      }),
      { PATH: process.env.PATH },
    );
    const result = await runtime.start(makeRequest(root), () => undefined)
      .completion;
    expect(result).toMatchObject({
      outcome: "failed",
      failure: { code: ERROR_CODES.CODEX_NOT_FOUND },
    });
  });
});
