import { EventEmitter } from "node:events";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { WorkerConfig } from "../src/config/worker-config.js";
import { ERROR_CODES } from "../src/core/errors.js";
import type { RuntimeEvent } from "../src/core/types.js";
import {
  CodexRuntime,
  terminateProcessTree,
  type SpawnTaskkill,
  type TaskkillProcess,
} from "../src/runtime/codex-runtime.js";
import { redactKnownValues } from "../src/security/redaction-policy.js";
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

async function writeAdversarialCodex(root: string): Promise<string> {
  const executable = join(root, "adversarial-codex.mjs");
  await writeFile(
    executable,
    `process.stdin.resume();
process.stdin.on("end", () => {
  const sensitive = [
    process.env.OPENAI_API_KEY,
    process.env.FORWARDED_TEST_SECRET,
  ].filter(Boolean).join("::");
  if (["failure-event", "error-event"].includes(process.env.ADVERSARIAL_SCENARIO)) {
    process.stdout.write(JSON.stringify({
      type: process.env.ADVERSARIAL_SCENARIO === "error-event" ? "error" : "turn.failed",
      message: sensitive,
      error: { message: sensitive },
    }) + "\\n");
    return;
  }
  process.stderr.write(sensitive);
  process.exitCode = 17;
});
`,
    "utf8",
  );
  return executable;
}

async function writeEscapingCodex(root: string): Promise<string> {
  const executable = join(root, "escaping-codex.mjs");
  // Emits a complete turn, then leaves a detached descendant holding the
  // inherited stdout pipe open long after the Codex process itself exits.
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { spawn } from "node:child_process";
process.stdin.resume();
process.stdin.on("end", () => {
  spawn(
    process.execPath,
    ["-e", "setTimeout(() => undefined, 60000)"],
    { detached: true, stdio: ["ignore", "inherit", "inherit"] },
  ).unref();
  process.stdout.write(
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }) + "\\n",
  );
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: {} }) + "\\n");
  process.exit(0);
});
`,
    "utf8",
  );
  return executable;
}

describe.runIf(process.platform !== "win32")(
  "CodexRuntime descendant containment",
  () => {
    test("settles a run whose descendant escapes and holds stdout open", async () => {
      const root = await makeStateDirectory();
      cleanupPaths.push(root);
      const escaping = await writeEscapingCodex(root);
      await ensureExecutable(escaping);
      const runtime = new CodexRuntime(
        runtimeConfig({ codexExecutable: escaping }),
        { HOME: process.env.HOME, PATH: process.env.PATH },
      );

      const started = Date.now();
      const result = await runtime.start(makeRequest(root), () => undefined)
        .completion;

      expect(result.outcome).toBe("completed");
      // Must not wait on the escaped descendant's 60s lifetime.
      expect(Date.now() - started).toBeLessThan(15_000);
    }, 30_000);
  },
);

describe("Windows process-tree termination", () => {
  test("uses SystemRoot taskkill without a shell and falls back on launch failure", () => {
    const unref = vi.fn((): void => undefined);
    const killer = Object.assign(new EventEmitter(), {
      unref,
    }) as EventEmitter & TaskkillProcess;
    const spawnTaskkill: SpawnTaskkill = vi.fn(() => killer);
    const kill = vi.fn(() => true);

    terminateProcessTree({ pid: 4242, kill }, "SIGTERM", {
      platform: "win32",
      environment: { systemroot: "C:\\Windows" },
      spawnTaskkill,
    });

    expect(spawnTaskkill).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\taskkill.exe",
      ["/pid", "4242", "/t", "/f"],
      { shell: false, stdio: "ignore", windowsHide: true },
    );
    expect(unref).toHaveBeenCalledOnce();
    expect(kill).not.toHaveBeenCalled();

    killer.emit("error", new Error("taskkill unavailable"));
    killer.emit("exit", 1, null);
    expect(kill).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });

  test("does not search PATH when SystemRoot is missing or relative", () => {
    const spawnTaskkill: SpawnTaskkill = vi.fn(() => {
      throw new Error("unexpected taskkill spawn");
    });
    const kill = vi.fn(() => true);

    terminateProcessTree({ pid: 4242, kill }, "SIGKILL", {
      platform: "win32",
      environment: { SystemRoot: "relative\\windows" },
      spawnTaskkill,
    });

    expect(spawnTaskkill).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledWith("SIGKILL");
  });
});

describe("known-value redaction", () => {
  test("replaces literal secrets without treating them as patterns", () => {
    const token = "sk-test-[literal].*token";
    expect(
      redactKnownValues(`before ${token} after ${token}`, [
        undefined,
        "",
        "abc",
        token,
      ]),
    ).toBe("before [REDACTED] after [REDACTED]");
  });

  test("bounds adversarial values and public output", () => {
    const longSecret = `known-${"s".repeat(8_000)}`;
    const redacted = redactKnownValues(
      `${longSecret}${"public".repeat(2_000)}`,
      [
        longSecret,
        ...Array.from({ length: 100 }, (_, index) => `value-${index}`),
      ],
    );
    expect(redacted).not.toContain(longSecret.slice(0, 4_096));
    expect(redacted.length).toBeLessThanOrEqual(4_096);
  });

  test("ignores absent oversized and numerous values without hiding diagnostics", () => {
    const diagnostic = "codex help is available";
    const candidates = [
      `absent-${"x".repeat(8_000)}`,
      ...Array.from({ length: 100 }, (_, index) => `absent-value-${index}`),
    ];

    expect(redactKnownValues(diagnostic, candidates)).toBe(diagnostic);
  });

  test("fails closed when an oversized known value is present", () => {
    const longSecret = `present-${"x".repeat(8_000)}`;

    expect(redactKnownValues(`before ${longSecret} after`, [longSecret])).toBe(
      "[REDACTED]",
    );
  });
});

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
        failure: {
          code: ERROR_CODES.PROTOCOL_ERROR,
          diagnostics: { stopReason: "protocol" },
        },
      });
    });

    test("kills a child that exceeds the stdout budget", async () => {
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
        resultTruncated: true,
        failure: { code: ERROR_CODES.TIMEOUT },
      });
      expect(result.finalMessage).toBeUndefined();
    });

    test("returns the partial final message and diagnostics when a run times out", async () => {
      await ensureExecutable(fakeCodex);
      const root = await makeStateDirectory();
      cleanupPaths.push(root);
      const runtime = new CodexRuntime(runtimeConfig(), {
        PATH: process.env.PATH,
        FAKE_CODEX_SCENARIO: "timeout-after-message",
      });
      // The fixture emits its partial message immediately and then hangs; the
      // generous timeout keeps the message-before-timeout ordering stable
      // even when the whole suite spawns processes in parallel.
      const result = await runtime.start(
        makeRequest(root, { timeoutMs: 5_000 }),
        () => undefined,
      ).completion;
      expect(result).toMatchObject({
        outcome: "failed",
        resultTruncated: true,
        finalMessage: "Partial: checked src/allowed.ts",
        failure: {
          code: ERROR_CODES.TIMEOUT,
          diagnostics: {
            stopReason: "timeout",
            eventCount: 2,
            commandsSucceeded: 0,
            commandsFailed: 0,
            partialMessageChars: "Partial: checked src/allowed.ts".length,
          },
        },
      });
    }, 10_000);

    test("keeps stderr noise from consuming the stdout budget", async () => {
      await ensureExecutable(fakeCodex);
      const root = await makeStateDirectory();
      cleanupPaths.push(root);
      const runtime = new CodexRuntime(
        runtimeConfig({ maxOutputBytes: 16_384 }),
        {
          PATH: process.env.PATH,
          FAKE_CODEX_SCENARIO: "stderr-noise",
        },
      );
      const result = await runtime.start(makeRequest(root), () => undefined)
        .completion;
      expect(result).toMatchObject({
        outcome: "completed",
        finalMessage: "fake final",
        resultTruncated: false,
      });
    });

    test("kills a child that floods stderr past its own budget", async () => {
      await ensureExecutable(fakeCodex);
      const root = await makeStateDirectory();
      cleanupPaths.push(root);
      const runtime = new CodexRuntime(
        runtimeConfig({ maxStderrBytes: 16_384 }),
        {
          PATH: process.env.PATH,
          FAKE_CODEX_SCENARIO: "stderr-flood",
        },
      );
      const result = await runtime.start(
        makeRequest(root, { timeoutMs: 5_000 }),
        () => undefined,
      ).completion;
      expect(result).toMatchObject({
        outcome: "failed",
        resultTruncated: true,
        failure: { code: ERROR_CODES.OUTPUT_LIMIT_EXCEEDED },
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

    test("drops an already-received partial message on cancellation", async () => {
      await ensureExecutable(fakeCodex);
      const root = await makeStateDirectory();
      cleanupPaths.push(root);
      let sawMessage: () => void = () => undefined;
      const messageSeen = new Promise<void>((resolvePromise) => {
        sawMessage = resolvePromise;
      });
      const runtime = new CodexRuntime(runtimeConfig(), {
        PATH: process.env.PATH,
        FAKE_CODEX_SCENARIO: "cancel-after-message",
      });
      const handle = runtime.start(
        makeRequest(root, { timeoutMs: 30_000 }),
        (event) => {
          if (event.agentMessage !== undefined) {
            sawMessage();
          }
        },
      );
      await messageSeen;
      await handle.cancel("user");
      // Strict equality: cancellation must not carry salvage fields.
      await expect(handle.completion).resolves.toEqual({
        outcome: "cancelled",
        resultTruncated: false,
      });
    }, 15_000);

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
        failure: {
          code: ERROR_CODES.RUNTIME_FAILED,
          message: "Codex reported a failed turn",
        },
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
          message: "Codex exited unsuccessfully",
          diagnostics: { exitCode: 7 },
        },
      });
    });

    test("fails closed when Codex exits zero after every command execution failed", async () => {
      await ensureExecutable(fakeCodex);
      const root = await makeStateDirectory();
      cleanupPaths.push(root);
      const runtime = new CodexRuntime(runtimeConfig(), {
        PATH: process.env.PATH,
        FAKE_CODEX_SCENARIO: "failed-command-outer-zero",
      });

      await expect(
        runtime.start(makeRequest(root), () => undefined).completion,
      ).resolves.toMatchObject({
        outcome: "failed",
        resultTruncated: false,
        finalMessage: "All checks passed even though none ran successfully.",
        failure: {
          code: ERROR_CODES.RUNTIME_FAILED,
          message: "Codex command execution failed",
          diagnostics: {
            commandsSucceeded: 0,
            commandsFailed: 1,
            exitCode: 0,
          },
        },
      });
    });

    test("allows a generic analysis to recover after a failed exploratory command", async () => {
      await ensureExecutable(fakeCodex);
      const root = await makeStateDirectory();
      cleanupPaths.push(root);
      const runtime = new CodexRuntime(runtimeConfig(), {
        PATH: process.env.PATH,
        FAKE_CODEX_SCENARIO: "failed-then-successful-command",
      });

      await expect(
        runtime.start(makeRequest(root), () => undefined).completion,
      ).resolves.toMatchObject({
        outcome: "completed",
        finalMessage: "Recovered after a failed probe.",
        resultTruncated: false,
      });
    });

    test("fails an SDD review that produced a verdict without one successful inspection command", async () => {
      await ensureExecutable(fakeCodex);
      const root = await makeStateDirectory();
      cleanupPaths.push(root);
      const runtime = new CodexRuntime(runtimeConfig(), {
        PATH: process.env.PATH,
        FAKE_CODEX_SCENARIO: "unsafe-event-type",
      });

      await expect(
        runtime.start(
          makeRequest(root, {
            sddReview: { seal: { mode: "strict" } } as NonNullable<
              ReturnType<typeof makeRequest>["sddReview"]
            >,
          }),
          () => undefined,
        ).completion,
      ).resolves.toMatchObject({
        outcome: "failed",
        resultTruncated: false,
        failure: {
          code: ERROR_CODES.RUNTIME_FAILED,
          message: "Codex command execution failed",
        },
      });
    });

    test("preserves draft SDD review compatibility when no inspection command is emitted", async () => {
      await ensureExecutable(fakeCodex);
      const root = await makeStateDirectory();
      cleanupPaths.push(root);
      const runtime = new CodexRuntime(runtimeConfig(), {
        PATH: process.env.PATH,
        FAKE_CODEX_SCENARIO: "unsafe-event-type",
      });

      await expect(
        runtime.start(
          makeRequest(root, {
            sddReview: { seal: { mode: "draft" } } as NonNullable<
              ReturnType<typeof makeRequest>["sddReview"]
            >,
          }),
          () => undefined,
        ).completion,
      ).resolves.toMatchObject({
        outcome: "completed",
        finalMessage: "safe final",
        resultTruncated: false,
      });
    });

    test.each([
      ["failure-event", "Codex reported a failed turn"],
      ["error-event", "Codex reported a failed turn"],
      ["stderr", "Codex exited unsuccessfully"],
    ])(
      "never reflects forwarded secrets from %s failures",
      async (scenario, expectedMessage) => {
        const root = await makeStateDirectory();
        cleanupPaths.push(root);
        const executable = await writeAdversarialCodex(root);
        const authToken = `sk-test-${"a".repeat(48)}`;
        const forwardedToken = `forwarded-test-${"b".repeat(48)}`;
        const runtime = new CodexRuntime(
          runtimeConfig({
            codexExecutable: executable,
            codexLauncherExecutable: process.execPath,
            codexLauncherArguments: [executable],
            forwardAuthEnvironment: true,
            forwardEnvironment: [
              "ADVERSARIAL_SCENARIO",
              "FORWARDED_TEST_SECRET",
            ],
          }),
          {
            PATH: process.env.PATH,
            OPENAI_API_KEY: authToken,
            ADVERSARIAL_SCENARIO: scenario,
            FORWARDED_TEST_SECRET: forwardedToken,
          },
        );

        const result = await runtime.start(makeRequest(root), () => undefined)
          .completion;

        expect(result).toMatchObject({
          outcome: "failed",
          failure: {
            code: ERROR_CODES.RUNTIME_FAILED,
            message: expectedMessage,
          },
        });
        expect(JSON.stringify(result)).not.toContain(authToken);
        expect(JSON.stringify(result)).not.toContain(forwardedToken);
      },
    );
  },
);

describe("CodexRuntime startup errors", () => {
  test("reports a missing executable without throwing from start", async () => {
    const root = await makeStateDirectory();
    cleanupPaths.push(root);
    const pathSecret = `path-secret-${"z".repeat(48)}`;
    const runtime = new CodexRuntime(
      runtimeConfig({
        codexExecutable: join(tmpdir(), pathSecret),
      }),
      { PATH: process.env.PATH },
    );
    const result = await runtime.start(makeRequest(root), () => undefined)
      .completion;
    expect(result).toMatchObject({
      outcome: "failed",
      failure: { code: ERROR_CODES.CODEX_NOT_FOUND },
    });
    expect(JSON.stringify(result)).not.toContain(pathSecret);
  });
});
