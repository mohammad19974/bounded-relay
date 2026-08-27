import { rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, test } from "vitest";

import type { WorkerConfig } from "../src/config/worker-config.js";
import { ERROR_CODES } from "../src/core/errors.js";
import { JobManager } from "../src/core/job-manager.js";
import { LeaseManager } from "../src/core/lease-manager.js";
import type {
  ResolvedJobRequest,
  RuntimeHandle,
  RuntimeResult,
  WorkerRuntime,
} from "../src/core/types.js";
import { buildCodexInvocation } from "../src/runtime/codex-command.js";
import { GitClient } from "../src/runtime/git-client.js";
import { ProposalWorkspace } from "../src/runtime/proposal-workspace.js";
import { ReviewWorkspace } from "../src/runtime/review-workspace.js";
import { buildWorkerPrompt } from "../src/security/task-prompt.js";
import {
  SddReviewService,
  type StartSddReviewInput,
} from "../src/sdd/review-job.js";
import {
  createTestRepository,
  makeConfig,
  makeRequest,
  makeStateDirectory,
  waitForTerminal,
} from "./helpers.js";

interface ControlledRun {
  readonly request: ResolvedJobRequest;
  resolve(result: RuntimeResult): void;
}

class ControlledRuntime implements WorkerRuntime {
  public readonly runs: ControlledRun[] = [];

  public start(request: ResolvedJobRequest): RuntimeHandle {
    let resolveRun: (result: RuntimeResult) => void = () => undefined;
    const completion = new Promise<RuntimeResult>((resolvePromise) => {
      resolveRun = resolvePromise;
    });
    this.runs.push({ request, resolve: resolveRun });
    return {
      completion,
      cancel: async () => {
        resolveRun({ outcome: "cancelled", resultTruncated: false });
      },
    };
  }
}

interface Harness {
  readonly config: WorkerConfig;
  readonly manager: JobManager;
  readonly repository: Awaited<ReturnType<typeof createTestRepository>>;
  readonly runtime: ControlledRuntime;
}

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
});

async function createHarness(): Promise<Harness> {
  const repository = await createTestRepository();
  cleanupPaths.push(repository.root);
  const stateDirectory = await makeStateDirectory();
  cleanupPaths.push(stateDirectory);
  const config = makeConfig({
    allowedRoots: [repository.root],
    allowedModels: ["gpt-5.6-sol"],
    stateDirectory,
  });
  const runtime = new ControlledRuntime();
  const git = new GitClient(config);
  const manager = new JobManager({
    config,
    runtime,
    proposalWorkspace: new ProposalWorkspace(config, git),
    reviewWorkspace: new ReviewWorkspace(config, git),
    leases: new LeaseManager(stateDirectory),
    reviews: new SddReviewService(config, git),
  });
  await manager.initialize();
  return { config, manager, repository, runtime };
}

function strictReviewInput(
  repository: Awaited<ReturnType<typeof createTestRepository>>,
  overrides: Partial<StartSddReviewInput> = {},
): StartSddReviewInput {
  return {
    phase: "plan",
    mode: "strict",
    artifactPaths: ["README.md", "src/allowed.ts"],
    expectedRevision: repository.revision,
    cwd: repository.root,
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    hostReview: {
      reviewId: "claude-plan-review",
      verdict: "approved",
      summary: "The host review approves the sealed plan.",
      findings: [],
    },
    ...overrides,
  };
}

function approvedCodexDecision(
  summary = "The sealed plan is approved.",
): string {
  return JSON.stringify({
    schemaVersion: 1,
    verdict: "approved",
    summary,
    findings: [],
  });
}

async function waitForRun(runtime: ControlledRuntime): Promise<ControlledRun> {
  const deadline = Date.now() + 2_000;
  while (runtime.runs.length === 0) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the controlled runtime");
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  const run = runtime.runs[0];
  if (run === undefined) {
    throw new Error("The controlled runtime did not retain its run");
  }
  return run;
}

describe("structured SDD review runtime integration", () => {
  test("rejects malformed direct review input as a public request error", async () => {
    const { manager } = await createHarness();
    await expect(
      manager.submitReview(null as unknown as StartSddReviewInput),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_REQUEST,
    });
    await expect(
      manager.submitReview({
        phase: "plan",
        unexpectedAuthority: "write",
      } as unknown as StartSddReviewInput),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_REQUEST });
  });

  test("passes a current strict dual-approval gate without exposing host evidence to Codex", async () => {
    const { config, manager, repository, runtime } = await createHarness();
    const hostSecrets = {
      summary: "HOST-ONLY-SUMMARY-7d451e",
      model: "HOST-ONLY-MODEL-19b3",
      requirement: "HOST-ONLY-REQUIREMENT-805f",
      nextAction: "HOST-ONLY-NEXT-ACTION-ea42",
    };
    const submitted = await manager.submitReview(
      strictReviewInput(repository, {
        hostReview: {
          reviewId: "claude-secret-plan-review",
          verdict: "approved",
          summary: hostSecrets.summary,
          declaredModelLabel: hostSecrets.model,
          findings: [
            {
              id: "host-observation-1",
              severity: "low",
              requirement: hostSecrets.requirement,
              summary: "A non-blocking host-only observation.",
              artifactPath: "README.md",
              nextAction: hostSecrets.nextAction,
            },
          ],
        },
      }),
    );
    const run = await waitForRun(runtime);

    expect(run.request.repositoryRoot).toBe(repository.root);
    expect(run.request.executionRoot).not.toBe(repository.root);
    expect(run.request.executionRoot).toContain("strict-review-");

    const prompt = buildWorkerPrompt(run.request);
    const invocation = buildCodexInvocation(run.request, config);
    for (const secret of Object.values(hostSecrets)) {
      expect(run.request.task).not.toContain(secret);
      expect(prompt).not.toContain(secret);
      expect(invocation.args.join("\n")).not.toContain(secret);
    }
    expect(run.request.task).toContain(
      "You have not been given the Claude host review",
    );
    expect(prompt).toContain(run.request.task);

    const schemaFlag = invocation.args.indexOf("--output-schema");
    expect(schemaFlag).toBeGreaterThan(-1);
    const schemaPath = invocation.args[schemaFlag + 1];
    expect(schemaPath?.replaceAll("\\", "/")).toMatch(
      /\/schemas\/sdd\/v1\/codex-review-output\.schema\.json$/u,
    );
    expect(invocation.args).toContain("read-only");
    expect(
      buildCodexInvocation(makeRequest(repository.root), config).args,
    ).not.toContain("--output-schema");

    run.resolve({
      outcome: "completed",
      finalMessage: approvedCodexDecision("Independent Codex approval."),
      resultTruncated: false,
    });
    const terminal = await waitForTerminal(manager, submitted.id);
    expect(terminal).toMatchObject({
      status: "completed",
      sddReview: {
        phase: "plan",
        mode: "strict",
      },
    });

    const result = manager.result(submitted.id);
    if (result.review === undefined) {
      throw new Error("Expected a structured SDD review artifact");
    }
    expect(result).toMatchObject({
      ready: true,
      finalMessage: "Independent Codex approval.",
    });
    expect(result.review.gate).toMatchObject({
      passed: true,
      status: "ready",
      reasons: [],
      freshnessReasons: [],
    });
    expect(result.review.hostEvidence.reviewer).toMatchObject({
      provider: "claude",
      lane: "claude-host",
      modelSource: "host-selected",
      declaredModelLabel: hostSecrets.model,
    });
    expect(result.review.codexEvidence.reviewer).toEqual({
      provider: "codex",
      lane: "codex",
      modelSource: "worker-resolved",
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
    });
    expect(result.review.codexEvidence.sealId).toBe(
      result.review.hostEvidence.sealId,
    );
  });

  test("fails closed when Codex returns malformed or fenced review JSON", async () => {
    const { manager, repository, runtime } = await createHarness();
    const submitted = await manager.submitReview(strictReviewInput(repository));
    const run = await waitForRun(runtime);

    run.resolve({
      outcome: "completed",
      finalMessage:
        '```json\n{"schemaVersion":1,"verdict":"approved","summary":"bad","findings":[]}\n```',
      resultTruncated: false,
    });

    const terminal = await waitForTerminal(manager, submitted.id);
    expect(terminal).toMatchObject({
      status: "failed",
      error: { code: ERROR_CODES.REVIEW_INVALID },
    });
    expect(manager.result(submitted.id)).toMatchObject({
      ready: true,
      job: { status: "failed" },
    });
    expect(manager.result(submitted.id).review).toBeUndefined();
    expect(manager.result(submitted.id).finalMessage).toBeUndefined();
  });

  test("returns a stale blocked gate when a sealed artifact changes during review", async () => {
    const { manager, repository, runtime } = await createHarness();
    const submitted = await manager.submitReview(strictReviewInput(repository));
    const run = await waitForRun(runtime);

    await writeFile(
      `${repository.root}/README.md`,
      "changed while Codex was reviewing\n",
      "utf8",
    );
    run.resolve({
      outcome: "completed",
      finalMessage: approvedCodexDecision(),
      resultTruncated: false,
    });

    const terminal = await waitForTerminal(manager, submitted.id);
    expect(terminal.status).toBe("completed");
    const review = manager.result(submitted.id).review;
    if (review === undefined) {
      throw new Error("Expected stale review evidence");
    }
    expect(review.gate).toMatchObject({
      passed: false,
      status: "stale",
      reasons: [],
    });
    expect(review.gate.freshnessReasons).toEqual(
      expect.arrayContaining([
        "clean-state-changed",
        "workspace-fingerprint-changed",
        "strict-workspace-dirty",
        "artifact-changed:README.md",
      ]),
    );
  });

  test("binds idempotency to frozen host evidence as well as the revision seal", async () => {
    const { manager, repository, runtime } = await createHarness();
    const input = strictReviewInput(repository, {
      idempotencyKey: "plan-review-idempotency",
      hostReview: {
        reviewId: "claude-idempotent-review",
        verdict: "approved",
        summary: "Frozen host evidence version one.",
        findings: [],
      },
    });
    const first = await manager.submitReview(input);
    const duplicate = await manager.submitReview(input);
    expect(duplicate.id).toBe(first.id);

    await expect(
      manager.submitReview({
        ...input,
        hostReview: {
          ...input.hostReview,
          summary: "Frozen host evidence version two.",
        },
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.DUPLICATE_IDEMPOTENCY_KEY,
    });

    const run = await waitForRun(runtime);
    run.resolve({
      outcome: "completed",
      finalMessage: approvedCodexDecision(),
      resultTruncated: false,
    });
    await waitForTerminal(manager, first.id);
  });
});
