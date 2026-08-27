import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { WorkerConfig } from "../src/config/worker-config.js";
import { ERROR_CODES } from "../src/core/errors.js";
import { JobManager } from "../src/core/job-manager.js";
import { LeaseManager } from "../src/core/lease-manager.js";
import type {
  ResolvedJobRequest,
  RuntimeEvent,
  RuntimeHandle,
  RuntimeResult,
  StartJobInput,
  WorkerRuntime,
} from "../src/core/types.js";
import { GitClient } from "../src/runtime/git-client.js";
import { ProposalWorkspace } from "../src/runtime/proposal-workspace.js";
import {
  createTestRepository,
  makeConfig,
  makeStateDirectory,
  waitForTerminal,
} from "./helpers.js";

interface ControlledRun {
  readonly request: ResolvedJobRequest;
  readonly onEvent: (event: RuntimeEvent) => void;
  readonly handle: RuntimeHandle;
  resolve(result: RuntimeResult): void;
}

class ControlledRuntime implements WorkerRuntime {
  public readonly runs: ControlledRun[] = [];

  public start(
    request: ResolvedJobRequest,
    onEvent: (event: RuntimeEvent) => void,
  ): RuntimeHandle {
    let resolveRun: (result: RuntimeResult) => void = () => undefined;
    const completion = new Promise<RuntimeResult>((resolvePromise) => {
      resolveRun = resolvePromise;
    });
    const handle: RuntimeHandle = {
      completion,
      cancel: async () => {
        resolveRun({ outcome: "cancelled", resultTruncated: false });
      },
    };
    this.runs.push({ request, onEvent, handle, resolve: resolveRun });
    return handle;
  }
}

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
});

async function makeManager(
  configOverrides: Partial<WorkerConfig> = {},
): Promise<{
  readonly manager: JobManager;
  readonly runtime: ControlledRuntime;
  readonly repository: Awaited<ReturnType<typeof createTestRepository>>;
}> {
  const repository = await createTestRepository();
  cleanupPaths.push(repository.root);
  const stateDirectory = await makeStateDirectory();
  cleanupPaths.push(stateDirectory);
  const config = makeConfig({
    allowedRoots: [repository.root],
    stateDirectory,
    ...configOverrides,
  });
  const runtime = new ControlledRuntime();
  const manager = new JobManager({
    config,
    runtime,
    proposalWorkspace: new ProposalWorkspace(config, new GitClient(config)),
    leases: new LeaseManager(stateDirectory),
  });
  await manager.initialize();
  return { manager, runtime, repository };
}

function makeValidationManager(): JobManager {
  const config = makeConfig();
  const runtime = new ControlledRuntime();
  return new JobManager({
    config,
    runtime,
    proposalWorkspace: new ProposalWorkspace(config, new GitClient(config)),
    leases: new LeaseManager(config.stateDirectory),
  });
}

async function waitForRuns(
  runtime: ControlledRuntime,
  count: number,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (runtime.runs.length < count) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${count} runtime start(s)`);
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

describe("JobManager request policy and idempotency", () => {
  test("allows only configured model identifiers and validates task/request limits", async () => {
    const { manager, repository } = await makeManager({
      allowedModels: ["gpt-5.6-sol"],
      maxTaskChars: 100,
      defaultTimeoutMs: 5_000,
      maxTimeoutMs: 5_000,
    });
    await expect(
      manager.submit({
        task: "review",
        cwd: repository.root,
        model: "gpt-5.6-sol",
      }),
    ).resolves.toMatchObject({ model: "gpt-5.6-sol" });
    await expect(
      manager.submit({
        task: "review",
        cwd: repository.root,
        model: "not-allowed",
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_REQUEST });
    await expect(
      manager.submit({
        task: "review",
        cwd: repository.root,
        model: "bad model",
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_REQUEST });
    await expect(
      manager.submit({ task: "   ", cwd: repository.root }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_REQUEST,
    });
    await expect(
      manager.submit({ task: `bad\0task`, cwd: repository.root }),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_REQUEST });
    await expect(
      manager.submit({ task: "x".repeat(101), cwd: repository.root }),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_REQUEST });
    await expect(
      manager.submit({ task: "review", cwd: repository.root, timeoutMs: 999 }),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_REQUEST });
    await expect(
      manager.submit({
        task: "review",
        cwd: repository.root,
        timeoutMs: 5_001,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_REQUEST });
  });

  test("requires explicit proposal capability and proposal-only revision fields", async () => {
    const { manager, repository } = await makeManager();
    await expect(
      manager.submit({
        task: "change",
        cwd: repository.root,
        mode: "proposal",
        expectedRevision: repository.revision,
        writePaths: ["src"],
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.PROPOSALS_DISABLED });
    await expect(
      manager.submit({
        task: "review",
        cwd: repository.root,
        expectedRevision: repository.revision,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_REQUEST });
  });

  test("returns the original job for the same idempotent request and rejects rebinding", async () => {
    const { manager, repository } = await makeManager();
    const first = await manager.submit({
      task: " review this ",
      cwd: repository.root,
      idempotencyKey: "request-1",
    });
    const duplicate = await manager.submit({
      task: "review this",
      cwd: repository.root,
      idempotencyKey: "request-1",
    });
    expect(duplicate.id).toBe(first.id);
    await expect(
      manager.submit({
        task: "different",
        cwd: repository.root,
        idempotencyKey: "request-1",
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.DUPLICATE_IDEMPOTENCY_KEY });
    await expect(
      manager.submit({
        task: "review",
        cwd: repository.root,
        idempotencyKey: "bad key",
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_REQUEST });
  });

  test.each([
    null,
    [],
    "task",
    {},
    { task: 42 },
    { task: "review", cwd: 42 },
    { task: "review", cwd: "x".repeat(4_097) },
    { task: "review", mode: "write-directly" },
    { task: "review", writePaths: "src" },
    { task: "review", writePaths: ["src", 42] },
    { task: "review", expectedRevision: 42 },
    { task: "review", model: 42 },
    { task: "review", idempotencyKey: 42 },
    { task: "review", reasoningEffort: "infinite" },
    { task: "review", timeoutMs: "forever" },
  ])(
    "rejects malformed runtime input before policy resolution: %#",
    async (input) => {
      const manager = makeValidationManager();
      await expect(
        manager.submit(input as StartJobInput),
      ).rejects.toMatchObject({
        code: ERROR_CODES.INVALID_REQUEST,
      });
    },
  );
});

describe("JobManager lifecycle", () => {
  test("tracks events, status revisions, result data, usage, and list filters", async () => {
    const { manager, runtime, repository } = await makeManager();
    const submitted = await manager.submit({
      task: "review",
      cwd: repository.root,
    });
    expect(manager.result(submitted.id)).toMatchObject({ ready: false });
    await waitForRuns(runtime, 1);
    const running = await manager.status(submitted.id);
    expect(running.status).toBe("running");
    const revision = running.revision;
    runtime.runs[0]?.onEvent({
      type: "thread.started",
      activity: "codex_started",
      sessionId: "session-1",
    });
    runtime.runs[0]?.onEvent({
      type: "item.completed",
      activity: "command_completed",
      commandCompleted: true,
    });
    runtime.runs[0]?.onEvent({
      type: "item.completed",
      activity: "response_ready",
      agentMessage: "draft",
    });
    runtime.runs[0]?.onEvent({
      type: "turn.completed",
      activity: "response_ready",
      usage: {
        inputTokens: 5,
        cachedInputTokens: 1,
        outputTokens: 3,
        reasoningOutputTokens: 2,
      },
    });
    const updated = await manager.status(submitted.id, 100);
    expect(updated.revision).toBeGreaterThan(revision);
    expect(updated.progress).toMatchObject({
      eventCount: 4,
      commandCount: 1,
      messageCount: 1,
      lastEventType: "turn.completed",
      activity: "response_ready",
      activityLabel: "Codex produced a response",
    });
    expect(Number.isNaN(Date.parse(updated.progress.updatedAt))).toBe(false);
    expect(Number.isInteger(updated.progress.elapsedMs)).toBe(true);
    expect(Number.isInteger(updated.progress.sinceLastUpdateMs)).toBe(true);
    runtime.runs[0]?.resolve({
      outcome: "completed",
      finalMessage: "final answer",
      sessionId: "session-1",
      usage: {
        inputTokens: 5,
        cachedInputTokens: 1,
        outputTokens: 3,
        reasoningOutputTokens: 2,
      },
      resultTruncated: true,
    });
    const terminal = await waitForTerminal(manager, submitted.id);
    expect(terminal).toMatchObject({
      status: "completed",
      resultAvailable: true,
      resultTruncated: true,
      sessionId: "session-1",
      progress: {
        phase: "terminal",
        activity: "completed",
        activityLabel: "Job completed",
      },
    });
    expect(manager.result(submitted.id)).toMatchObject({
      ready: true,
      finalMessage: "final answer",
    });
    expect(manager.list({ status: "completed", limit: 1 })).toHaveLength(1);
    expect(manager.list({ status: "failed" })).toEqual([]);
  });

  test("reports queue position and supports revision-aware long polling", async () => {
    const { manager, runtime, repository } = await makeManager({
      maxConcurrent: 1,
      maxQueued: 4,
    });
    const first = await manager.submit({
      task: "first",
      cwd: repository.root,
    });
    await waitForRuns(runtime, 1);
    const second = await manager.submit({
      task: "second",
      cwd: repository.root,
    });
    expect(second).toMatchObject({
      status: "queued",
      queuePosition: 1,
      progress: {
        activity: "queued",
        activityLabel: "Waiting for an available worker slot",
      },
    });
    const third = await manager.submit({
      task: "third",
      cwd: repository.root,
    });
    expect(third).toMatchObject({ status: "queued", queuePosition: 2 });
    const fourth = await manager.submit({
      task: "fourth",
      cwd: repository.root,
    });
    expect(fourth).toMatchObject({ status: "queued", queuePosition: 3 });

    await manager.cancel(fourth.id);
    expect((await manager.status(second.id)).revision).toBe(second.revision);
    expect((await manager.status(third.id)).revision).toBe(third.revision);

    const current = await manager.status(first.id);
    const staleRevision = await manager.status(
      first.id,
      1_000,
      current.revision - 1,
    );
    expect(staleRevision.revision).toBe(current.revision);

    const nextUpdate = manager.status(first.id, 1_000, current.revision);
    runtime.runs[0]?.onEvent({
      type: "turn.started",
      activity: "reasoning",
    });
    await expect(nextUpdate).resolves.toMatchObject({
      revision: current.revision + 1,
      progress: {
        activity: "reasoning",
        activityLabel: "Codex is reasoning",
      },
    });
    await expect(
      manager.status(first.id, 0, current.revision + 10),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_REQUEST });

    await manager.cancel(second.id);
    const advancedQueue = await manager.status(third.id);
    expect(advancedQueue).toMatchObject({
      status: "queued",
      queuePosition: 1,
    });
    expect(advancedQueue.revision).toBeGreaterThan(third.revision);

    await manager.cancel(first.id);
    await manager.cancel(third.id);
  });

  test("bounds the queue, allows queued cancellation, and starts the next job", async () => {
    const { manager, runtime, repository } = await makeManager({
      maxConcurrent: 1,
      maxQueued: 1,
    });
    const first = await manager.submit({ task: "first", cwd: repository.root });
    await waitForRuns(runtime, 1);
    const second = await manager.submit({
      task: "second",
      cwd: repository.root,
    });
    expect(second.status).toBe("queued");
    await expect(
      manager.submit({ task: "third", cwd: repository.root }),
    ).rejects.toMatchObject({ code: ERROR_CODES.QUEUE_FULL });
    await expect(manager.cancel(second.id)).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(manager.result(second.id)).toMatchObject({
      ready: true,
      job: { error: { code: ERROR_CODES.CANCELLED } },
    });
    runtime.runs[0]?.resolve({
      outcome: "completed",
      finalMessage: "first done",
      resultTruncated: false,
    });
    await waitForTerminal(manager, first.id);
    expect(runtime.runs).toHaveLength(1);
  });

  test("cancels a running job and keeps repeated cancellation safe", async () => {
    const { manager, runtime, repository } = await makeManager();
    const submitted = await manager.submit({
      task: "long",
      cwd: repository.root,
    });
    await waitForRuns(runtime, 1);
    await manager.cancel(submitted.id);
    const cancelled = await waitForTerminal(manager, submitted.id);
    expect(cancelled.status).toBe("cancelled");
    await expect(manager.cancel(submitted.id)).resolves.toMatchObject({
      status: "cancelled",
    });
  });

  test("maps runtime failures and missing outcomes to terminal failures", async () => {
    const { manager, runtime, repository } = await makeManager({
      maxConcurrent: 1,
    });
    const first = await manager.submit({ task: "fail", cwd: repository.root });
    await waitForRuns(runtime, 1);
    runtime.runs[0]?.resolve({
      outcome: "failed",
      resultTruncated: false,
      failure: { code: ERROR_CODES.TIMEOUT, message: "timed out" },
    });
    await expect(waitForTerminal(manager, first.id)).resolves.toMatchObject({
      status: "failed",
      error: { code: ERROR_CODES.TIMEOUT },
    });

    const second = await manager.submit({
      task: "fail generically",
      cwd: repository.root,
    });
    await waitForRuns(runtime, 2);
    runtime.runs[1]?.resolve({ outcome: "failed", resultTruncated: false });
    await expect(waitForTerminal(manager, second.id)).resolves.toMatchObject({
      status: "failed",
      error: { code: ERROR_CODES.RUNTIME_FAILED },
    });
  });

  test("throws a typed error for unknown jobs", async () => {
    const { manager } = await makeManager();
    await expect(manager.status("missing")).rejects.toMatchObject({
      code: ERROR_CODES.JOB_NOT_FOUND,
    });
    expect(() => manager.result("missing")).toThrow(
      expect.objectContaining({ code: ERROR_CODES.JOB_NOT_FOUND }),
    );
  });

  test("shutdown cancels all active runtime handles", async () => {
    const { manager, runtime, repository } = await makeManager({
      maxConcurrent: 2,
    });
    const first = await manager.submit({ task: "one", cwd: repository.root });
    const second = await manager.submit({ task: "two", cwd: repository.root });
    await waitForRuns(runtime, 2);
    await manager.shutdown();
    await expect(waitForTerminal(manager, first.id)).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(waitForTerminal(manager, second.id)).resolves.toMatchObject({
      status: "cancelled",
    });
  });
});

describe("JobManager proposal integration", () => {
  test("executes in the disposable clone and exposes the validated proposal", async () => {
    const { manager, runtime, repository } = await makeManager({
      enableProposals: true,
      maxConcurrent: 1,
    });
    const submitted = await manager.submit({
      task: "update allowed file",
      cwd: repository.root,
      mode: "proposal",
      expectedRevision: repository.revision,
      writePaths: ["src"],
    });
    await waitForRuns(runtime, 1);
    const run = runtime.runs[0];
    expect(run?.request.executionRoot).not.toBe(repository.root);
    await writeFile(
      join(run?.request.executionRoot ?? "", "src", "allowed.ts"),
      "export const value = 3;\n",
      "utf8",
    );
    run?.resolve({
      outcome: "completed",
      finalMessage: "proposal ready",
      resultTruncated: false,
    });
    await expect(
      waitForTerminal(manager, submitted.id, 5_000),
    ).resolves.toMatchObject({
      status: "completed",
    });
    expect(manager.result(submitted.id)).toMatchObject({
      ready: true,
      proposal: {
        effect: "proposal",
        baselineRevision: repository.revision,
        changedFiles: ["src/allowed.ts"],
      },
    });
  });
});
