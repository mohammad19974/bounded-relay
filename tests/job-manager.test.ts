import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

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
import { ReviewWorkspace } from "../src/runtime/review-workspace.js";
import {
  SddReviewService,
  type StartSddReviewInput,
} from "../src/sdd/review-job.js";
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
  readonly cancelReasons: ("user" | "shutdown")[];
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
    const cancelReasons: ("user" | "shutdown")[] = [];
    const handle: RuntimeHandle = {
      completion,
      cancel: async (reason) => {
        cancelReasons.push(reason);
        resolveRun({ outcome: "cancelled", resultTruncated: false });
      },
    };
    this.runs.push({
      request,
      onEvent,
      handle,
      cancelReasons,
      resolve: resolveRun,
    });
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
  readonly stateDirectory: string;
  readonly reviews: SddReviewService;
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
  const git = new GitClient(config);
  const reviews = new SddReviewService(config, git);
  const manager = new JobManager({
    config,
    runtime,
    proposalWorkspace: new ProposalWorkspace(config, git),
    reviewWorkspace: new ReviewWorkspace(config, git),
    leases: new LeaseManager(stateDirectory),
    reviews,
  });
  await manager.initialize();
  return { manager, runtime, repository, stateDirectory, reviews };
}

function makeValidationManager(): JobManager {
  const config = makeConfig();
  const runtime = new ControlledRuntime();
  const git = new GitClient(config);
  return new JobManager({
    config,
    runtime,
    proposalWorkspace: new ProposalWorkspace(config, git),
    reviewWorkspace: new ReviewWorkspace(config, git),
    leases: new LeaseManager(config.stateDirectory),
    reviews: new SddReviewService(config, git),
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

function strictReviewInput(
  repository: Awaited<ReturnType<typeof createTestRepository>>,
): StartSddReviewInput {
  return {
    phase: "plan",
    mode: "strict",
    artifactPaths: ["README.md"],
    expectedRevision: repository.revision,
    cwd: repository.root,
    hostReview: {
      reviewId: "shutdown-race-host-review",
      verdict: "approved",
      summary: "The host review approves the sealed plan.",
      findings: [],
    },
  };
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
    const adversarialSecret = `sk-test-${"x".repeat(48)}`;
    runtime.runs[0]?.resolve({
      outcome: "failed",
      resultTruncated: false,
      failure: {
        code: ERROR_CODES.TIMEOUT,
        message: `timed out with ${adversarialSecret}`,
      },
    });
    const failed = await waitForTerminal(manager, first.id);
    expect(failed).toMatchObject({
      status: "failed",
      error: {
        code: ERROR_CODES.TIMEOUT,
        message: "Codex exceeded the configured timeout",
      },
    });
    expect(JSON.stringify(failed)).not.toContain(adversarialSecret);

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

  test("applies server-owned default model and effort only when the caller omits them", async () => {
    const { manager, repository } = await makeManager({
      allowedModels: ["gpt-5.6-sol", "gpt-5.6-terra"],
      defaultModel: "gpt-5.6-sol",
      defaultReasoningEffort: "high",
    });
    await expect(
      manager.submit({ task: "review", cwd: repository.root }),
    ).resolves.toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
    await expect(
      manager.submit({
        task: "review explicitly",
        cwd: repository.root,
        model: "gpt-5.6-terra",
        reasoningEffort: "low",
      }),
    ).resolves.toMatchObject({
      model: "gpt-5.6-terra",
      reasoningEffort: "low",
    });
  });

  test("retains a partial final message and diagnostics when the runtime fails", async () => {
    const { manager, runtime, repository } = await makeManager();
    const submitted = await manager.submit({
      task: "long analysis",
      cwd: repository.root,
    });
    await waitForRuns(runtime, 1);
    runtime.runs[0]?.resolve({
      outcome: "failed",
      resultTruncated: true,
      finalMessage: "Partial findings: the first two files are clean.",
      failure: {
        code: ERROR_CODES.TIMEOUT,
        message: "Codex exceeded the configured timeout",
        diagnostics: {
          stopReason: "timeout",
          eventCount: 5,
          commandsSucceeded: 2,
          commandsFailed: 0,
          stdoutBytes: 2_048,
          stderrBytes: 10,
          elapsedMs: 1_000,
          partialMessageChars: 47,
        },
      },
    });
    const failed = await waitForTerminal(manager, submitted.id);
    expect(failed).toMatchObject({
      status: "failed",
      resultTruncated: true,
      partialResultAvailable: true,
      error: {
        code: ERROR_CODES.TIMEOUT,
        message: "Codex exceeded the configured timeout",
        diagnostics: { stopReason: "timeout", eventCount: 5 },
      },
    });
    expect(failed.resultAvailable).toBe(false);
    expect(manager.result(submitted.id)).toMatchObject({
      ready: true,
      finalMessage: "Partial findings: the first two files are clean.",
    });
  });

  test("drops adversarial diagnostics keys and invalid values from failures", async () => {
    const { manager, runtime, repository } = await makeManager();
    const submitted = await manager.submit({
      task: "diagnose",
      cwd: repository.root,
    });
    await waitForRuns(runtime, 1);
    runtime.runs[0]?.resolve({
      outcome: "failed",
      resultTruncated: false,
      failure: {
        code: ERROR_CODES.TIMEOUT,
        message: "Codex exceeded the configured timeout",
        diagnostics: {
          stopReason: "weird-reason",
          eventCount: -5,
          stdoutBytes: 3.5,
          commandsFailed: 2,
          evil: "leaked-secret-value",
        } as never,
      },
    });
    const failed = await waitForTerminal(manager, submitted.id);
    expect(failed.error?.diagnostics).toEqual({ commandsFailed: 2 });
    expect(JSON.stringify(failed)).not.toContain("leaked-secret-value");
    expect(JSON.stringify(failed)).not.toContain("weird-reason");
  });

  test("marks a persisted session as resumable only once a session was observed", async () => {
    const { manager, runtime, repository } = await makeManager();
    const persisted = await manager.submit({
      task: "warm analysis",
      cwd: repository.root,
      persistSession: true,
    });
    // Before Codex reports a thread, no recorded session exists to resume.
    expect(persisted.sessionPersisted).toBeUndefined();
    await waitForRuns(runtime, 1);
    expect(
      (await manager.status(persisted.id)).sessionPersisted,
    ).toBeUndefined();
    runtime.runs[0]?.resolve({
      outcome: "completed",
      finalMessage: "done",
      sessionId: "01a0493b-30d2-7cd2-b01c-52db2a4bca0e",
      resultTruncated: false,
    });
    const terminal = await waitForTerminal(manager, persisted.id);
    expect(terminal).toMatchObject({
      sessionPersisted: true,
      sessionId: "01a0493b-30d2-7cd2-b01c-52db2a4bca0e",
    });

    const ephemeral = await manager.submit({
      task: "cold analysis",
      cwd: repository.root,
    });
    await waitForRuns(runtime, 2);
    runtime.runs[1]?.resolve({
      outcome: "completed",
      finalMessage: "done",
      sessionId: "01a0493b-30d2-7cd2-b01c-52db2a4bca0e",
      resultTruncated: false,
    });
    const ephemeralTerminal = await waitForTerminal(manager, ephemeral.id);
    expect(ephemeralTerminal.sessionPersisted).toBeUndefined();
  });

  test("marks a resumed job's session as resumable once its thread is observed", async () => {
    const { manager, runtime, repository } = await makeManager();
    const resumed = await manager.submit({
      task: "continue the thread",
      cwd: repository.root,
      resumeSessionId: "01a0493b-30d2-7cd2-b01c-52db2a4bca0e",
    });
    await waitForRuns(runtime, 1);
    runtime.runs[0]?.resolve({
      outcome: "completed",
      finalMessage: "done",
      sessionId: "01a0493b-30d2-7cd2-b01c-52db2a4bca0e",
      resultTruncated: false,
    });
    const terminal = await waitForTerminal(manager, resumed.id);
    expect(terminal.sessionPersisted).toBe(true);
  });

  test("lets an explicit model and effort override the defaults on a resume", async () => {
    const { manager, repository } = await makeManager({
      allowedModels: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      defaultReasoningEffort: "high",
    });
    const explicit = await manager.submit({
      task: "continue with an explicit model",
      cwd: repository.root,
      resumeSessionId: "01a0493b-30d2-7cd2-b01c-52db2a4bca0e",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
    });
    expect(explicit).toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
    });
  });

  test("ignores a whitespace-only partial final message on failure", async () => {
    const { manager, runtime, repository } = await makeManager();
    const submitted = await manager.submit({
      task: "fail with blank salvage",
      cwd: repository.root,
    });
    await waitForRuns(runtime, 1);
    runtime.runs[0]?.resolve({
      outcome: "failed",
      resultTruncated: false,
      finalMessage: "  \n",
      failure: {
        code: ERROR_CODES.TIMEOUT,
        message: "Codex exceeded the configured timeout",
      },
    });
    const failed = await waitForTerminal(manager, submitted.id);
    expect(failed.partialResultAvailable).toBeUndefined();
    expect(manager.result(submitted.id).finalMessage).toBeUndefined();
  });

  test("never salvages a partial final message for a failed SDD review", async () => {
    const { manager, runtime, repository } = await makeManager();
    const review = await manager.submitReview(strictReviewInput(repository));
    await waitForRuns(runtime, 1);
    runtime.runs[0]?.resolve({
      outcome: "failed",
      resultTruncated: true,
      finalMessage: '{"verdict":"approved","summary":"unvalidated"}',
      sessionId: "01a0493b-30d2-7cd2-b01c-52db2a4bca0e",
      failure: {
        code: ERROR_CODES.TIMEOUT,
        message: "Codex exceeded the configured timeout",
      },
    });
    const failed = await waitForTerminal(manager, review.id);
    expect(failed.status).toBe("failed");
    expect(failed.partialResultAvailable).toBeUndefined();
    expect(failed.resultAvailable).toBe(false);
    expect(manager.result(review.id).finalMessage).toBeUndefined();
  });

  test("drops an already-received partial message when the job is cancelled", async () => {
    const { manager, runtime, repository } = await makeManager();
    const submitted = await manager.submit({
      task: "cancel mid-flight",
      cwd: repository.root,
    });
    await waitForRuns(runtime, 1);
    runtime.runs[0]?.onEvent({
      type: "item.completed",
      activity: "response_ready",
      agentMessage: "half-finished thought",
    });
    runtime.runs[0]?.resolve({
      outcome: "cancelled",
      resultTruncated: false,
      finalMessage: "half-finished thought",
    });
    const cancelled = await waitForTerminal(manager, submitted.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.partialResultAvailable).toBeUndefined();
    expect(manager.result(submitted.id).finalMessage).toBeUndefined();
  });

  test("applies server defaults to a resumed job so it never runs at the CLI default effort", async () => {
    const { manager, repository } = await makeManager({
      allowedModels: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      defaultReasoningEffort: "high",
    });
    // Omitting the flags does not preserve the thread's original model; it
    // drops Codex to its built-in default effort, which is the exact failure
    // the server-owned defaults exist to prevent.
    await expect(
      manager.submit({
        task: "continue the thread",
        cwd: repository.root,
        resumeSessionId: "01a0493b-30d2-7cd2-b01c-52db2a4bca0e",
      }),
    ).resolves.toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
  });

  test("keeps a completed run's final message when proposal finalization fails", async () => {
    const { manager, runtime, repository } = await makeManager({
      enableProposals: true,
      maxConcurrent: 1,
    });
    const submitted = await manager.submit({
      task: "propose a change",
      cwd: repository.root,
      mode: "proposal",
      expectedRevision: repository.revision,
      writePaths: ["src"],
    });
    await waitForRuns(runtime, 1);
    const run = runtime.runs[0];
    // Write outside the lease so finalize() rejects the patch after Codex
    // already produced a complete, valuable report.
    await writeFile(
      join(run?.request.executionRoot ?? "", "README.md"),
      "escaped\n",
      "utf8",
    );
    run?.resolve({
      outcome: "completed",
      finalMessage: "Full report: what I changed, why, and how I verified it.",
      resultTruncated: false,
    });
    const failed = await waitForTerminal(manager, submitted.id, 5_000);
    expect(failed.status).toBe("failed");
    expect(failed.partialResultAvailable).toBe(true);
    expect(manager.result(submitted.id).finalMessage).toBe(
      "Full report: what I changed, why, and how I verified it.",
    );
  });

  test("keeps a completed result when cancellation lands after the runtime finished", async () => {
    const { manager, runtime, repository } = await makeManager();
    const submitted = await manager.submit({
      task: "race the cancel",
      cwd: repository.root,
    });
    await waitForRuns(runtime, 1);
    runtime.runs[0]?.resolve({
      outcome: "completed",
      finalMessage: "finished before the cancel arrived",
      resultTruncated: false,
    });
    await manager.cancel(submitted.id);
    const terminal = await waitForTerminal(manager, submitted.id);
    expect(terminal.status).toBe("completed");
    expect(manager.result(submitted.id).finalMessage).toBe(
      "finished before the cancel arrived",
    );
  });

  test("evicts history by completion order so a long job survives to be read", async () => {
    const { manager, runtime, repository } = await makeManager({
      maxConcurrent: 2,
      maxHistory: 3,
    });
    const long = await manager.submit({ task: "long", cwd: repository.root });
    await waitForRuns(runtime, 1);
    for (let index = 0; index < 3; index += 1) {
      const short = await manager.submit({
        task: `short-${index}`,
        cwd: repository.root,
      });
      await waitForRuns(runtime, index + 2);
      runtime.runs[index + 1]?.resolve({
        outcome: "completed",
        finalMessage: `short ${index}`,
        resultTruncated: false,
      });
      await waitForTerminal(manager, short.id);
    }
    runtime.runs[0]?.resolve({
      outcome: "completed",
      finalMessage: "the long job's answer",
      resultTruncated: false,
    });
    await waitForTerminal(manager, long.id);

    // The oldest-created job finished last; evicting by creation time would
    // delete its result the instant it became readable.
    expect(manager.result(long.id)).toMatchObject({
      ready: true,
      finalMessage: "the long job's answer",
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

  test("shutdown atomically cancels active and queued jobs and refuses new work", async () => {
    const { manager, runtime, repository } = await makeManager({
      maxConcurrent: 1,
      maxQueued: 4,
    });
    const first = await manager.submit({ task: "one", cwd: repository.root });
    const second = await manager.submit({ task: "two", cwd: repository.root });
    const third = await manager.submit({
      task: "three",
      cwd: repository.root,
    });
    await waitForRuns(runtime, 1);

    const firstShutdown = manager.shutdown();
    const repeatedShutdown = manager.shutdown();
    expect(repeatedShutdown).toBe(firstShutdown);
    await firstShutdown;

    await expect(waitForTerminal(manager, first.id)).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(waitForTerminal(manager, second.id)).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(waitForTerminal(manager, third.id)).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(runtime.runs).toHaveLength(1);
    expect(runtime.runs[0]?.cancelReasons).toEqual(["shutdown"]);

    await expect(
      manager.submit({ task: "too late", cwd: repository.root }),
    ).rejects.toMatchObject({ code: ERROR_CODES.WORKER_SHUTTING_DOWN });
    await expect(manager.submitReview(null as never)).rejects.toMatchObject({
      code: ERROR_CODES.WORKER_SHUTTING_DOWN,
    });
    await expect(manager.shutdown()).resolves.toBeUndefined();
  });

  test("shutdown waits for proposal cleanup and lease release", async () => {
    const { manager, runtime, repository, stateDirectory } = await makeManager({
      enableProposals: true,
      maxConcurrent: 1,
    });
    const proposal = await manager.submit({
      task: "prepare an isolated proposal",
      cwd: repository.root,
      mode: "proposal",
      expectedRevision: repository.revision,
      writePaths: ["src"],
    });
    await waitForRuns(runtime, 1);
    expect(await readdir(join(stateDirectory, "workspaces"))).not.toEqual([]);
    expect(await readdir(join(stateDirectory, "locks"))).not.toEqual([]);

    await manager.shutdown();

    await expect(waitForTerminal(manager, proposal.id)).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(await readdir(join(stateDirectory, "workspaces"))).toEqual([]);
    expect(await readdir(join(stateDirectory, "locks"))).toEqual([]);
  });

  test("shutdown waits for strict review workspace cleanup", async () => {
    const { manager, runtime, repository, stateDirectory } = await makeManager({
      maxConcurrent: 1,
    });
    const review = await manager.submitReview(strictReviewInput(repository));
    await waitForRuns(runtime, 1);
    expect(await readdir(join(stateDirectory, "reviews"))).not.toEqual([]);

    await manager.shutdown();

    await expect(waitForTerminal(manager, review.id)).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(await readdir(join(stateDirectory, "reviews"))).toEqual([]);
  });

  test("review preparation cannot enqueue after shutdown begins", async () => {
    const { manager, repository, stateDirectory, reviews } =
      await makeManager();
    const originalPrepare = reviews.prepare.bind(reviews);
    let releasePreparation: () => void = () => undefined;
    const preparationGate = new Promise<void>((resolvePromise) => {
      releasePreparation = resolvePromise;
    });
    let signalPreparation: () => void = () => undefined;
    const preparationStarted = new Promise<void>((resolvePromise) => {
      signalPreparation = resolvePromise;
    });
    vi.spyOn(reviews, "prepare").mockImplementation(
      async (input, repositoryRoot) => {
        signalPreparation();
        await preparationGate;
        return await originalPrepare(input, repositoryRoot);
      },
    );

    const submission = manager.submitReview(strictReviewInput(repository));
    await preparationStarted;
    const shutdown = manager.shutdown();
    releasePreparation();

    await expect(submission).rejects.toMatchObject({
      code: ERROR_CODES.WORKER_SHUTTING_DOWN,
    });
    await shutdown;
    expect(manager.list()).toEqual([]);
    expect(await readdir(join(stateDirectory, "reviews"))).toEqual([]);
  });

  test("keeps a completed result while pending jobs fill the history limit", async () => {
    const { manager, runtime, repository } = await makeManager({
      maxConcurrent: 1,
      maxHistory: 10,
    });
    const completed = await manager.submit({
      task: "first",
      cwd: repository.root,
    });
    await waitForRuns(runtime, 1);
    runtime.runs[0]?.resolve({
      outcome: "completed",
      finalMessage: "final answer",
      resultTruncated: false,
    });
    await waitForTerminal(manager, completed.id);

    // Pending work must never evict the only finished result.
    for (let index = 0; index < 10; index += 1) {
      await manager.submit({ task: `pending-${index}`, cwd: repository.root });
    }

    expect(manager.result(completed.id)).toMatchObject({ ready: true });
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
