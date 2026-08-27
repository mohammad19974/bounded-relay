#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";

import {
  comparisonRevision,
  assertJobId,
  assertModel,
  assertReview,
  assertRevisionEqual,
  assertSafeIdentifier,
  canonicalDigest,
  currentGitRevision,
  evidencePath,
  fail,
  fileDigest,
  hostReviewContextId,
  printSuccess,
  readJson,
  repositoryTree,
  requireSchema,
  workflowContext,
  writeJsonAtomic,
} from "./evidence-core.mjs";
import { assertCheckReceipts } from "./check-receipts.mjs";
import { assertStrictSddReview } from "./strict-review.mjs";

const EXECUTION_SCRIPT = fileURLToPath(
  new URL("./execution.mjs", import.meta.url),
);
const DEFAULT_CODEX_REVIEW_POLICY = {
  source: "server-allowlisted",
  model: null,
  reasoningEffort: null,
  reason: "server-default-independent-review",
};
const CRITICAL_CODEX_REVIEW_POLICY = {
  source: "server-allowlisted",
  model: "gpt-5.6-sol",
  reasoningEffort: "ultra",
  reason: "critical-cross-provider-review",
};

function codexReviewPolicy(context, runId) {
  const routing = readJson(
    evidencePath(context, "routing"),
    "routing evidence",
  );
  requireSchema(routing, runId, "routing");
  if (!Array.isArray(routing.assignments)) {
    fail("review model policy requires routing assignments");
  }
  return routing.assignments.some(
    (assignment) =>
      assignment.risk === "critical" && assignment.reviewerProvider === "codex",
  )
    ? CRITICAL_CODEX_REVIEW_POLICY
    : DEFAULT_CODEX_REVIEW_POLICY;
}

function assertCurrentExecution(runId) {
  const execution = spawnSync(
    process.execPath,
    [EXECUTION_SCRIPT, "verify", runId],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      shell: false,
    },
  );
  if (execution.error || execution.status !== 0) {
    fail("implementation review requires revalidated current wave execution");
  }
}

function reviewSource(context, runId, phase) {
  if (phase === "implementation") {
    assertCurrentExecution(runId);
    const path = evidencePath(context, "execution");
    const execution = readJson(path, "execution evidence");
    requireSchema(execution, runId, "execution");
    const finalCheckpoint = execution.checkpoints?.at(-1);
    if (
      execution.state !== "complete" ||
      execution.activeWave !== null ||
      !Array.isArray(execution.results) ||
      !Array.isArray(execution.checkpoints) ||
      finalCheckpoint?.completedRevision === undefined
    ) {
      fail("implementation review requires complete wave execution evidence");
    }
    const checks = execution.results.flatMap((result) => result.checks ?? []);
    return {
      baseRevision: execution.routingRevision,
      sourceEvidence: {
        kind: "execution",
        sha256: fileDigest(path, "execution evidence"),
        finalRevision: finalCheckpoint.completedRevision,
      },
      checks,
      checksRequired: execution.results.some(
        (result) => result.effect !== "analysis",
      ),
    };
  }

  const path = evidencePath(context, "implementation-review");
  const implementation = readJson(path, "implementation review evidence");
  requireSchema(implementation, runId, "implementation-review");
  if (
    implementation.state !== "complete" ||
    implementation.verdict !== "approved" ||
    implementation.claudeReview?.verdict !== "approved" ||
    implementation.codexReview?.verdict !== "approved"
  ) {
    fail("convergence review requires an approved implementation review");
  }
  const executionPath = evidencePath(context, "execution");
  const execution = readJson(executionPath, "execution evidence");
  requireSchema(execution, runId, "execution");
  const executionFinal = execution.checkpoints?.at(-1)?.completedRevision;
  const expectedImplementationSource = {
    kind: "execution",
    sha256: fileDigest(executionPath, "execution evidence"),
    finalRevision: executionFinal,
  };
  if (
    executionFinal === undefined ||
    canonicalDigest(implementation.sourceEvidence) !==
      canonicalDigest(expectedImplementationSource) ||
    canonicalDigest(implementation.checks) !==
      canonicalDigest(
        execution.results.flatMap((result) => result.checks ?? []),
      )
  ) {
    fail("implementation review is no longer bound to execution evidence");
  }
  assertStrictSddReview(
    implementation.codexReview,
    implementation.claudeReview,
    implementation.revision,
    "implementation",
  );
  assertCheckReceipts(
    implementation.checks,
    "implementation review checks",
    false,
    256,
  );
  if (implementation.checksSha256 !== canonicalDigest(implementation.checks)) {
    fail("implementation review check receipt digest is invalid");
  }
  if (
    implementation.claudeReview.reviewId !==
      hostReviewContextId(implementation, "implementation") ||
    implementation.codexReview.model !==
      implementation.codexReviewPolicy?.model ||
    implementation.codexReview.reasoningEffort !==
      implementation.codexReviewPolicy?.reasoningEffort ||
    canonicalDigest(implementation.codexReviewPolicy) !==
      canonicalDigest(codexReviewPolicy(context, runId))
  ) {
    fail("implementation review context or model policy is stale");
  }
  if (currentGitRevision(context) !== implementation.revision?.head) {
    fail(
      "convergence found new work; start a fresh approved routing and wave-execution run",
    );
  }
  return {
    baseRevision: implementation.revision?.head,
    sourceEvidence: {
      kind: "implementation-review",
      sha256: fileDigest(path, "implementation review evidence"),
      finalRevision: implementation.revision?.head,
    },
    checks: [],
    checksRequired: false,
  };
}

function assertBoundEvidence(
  document,
  source,
  revision,
  phase,
  context,
  reviewPolicy,
) {
  if (
    canonicalDigest(document.sourceEvidence) !==
    canonicalDigest(source.sourceEvidence)
  ) {
    fail(`${phase} review source evidence is stale`);
  }
  if (
    (phase === "implementation" &&
      source.sourceEvidence.finalRevision !== revision.head) ||
    (phase === "convergence" &&
      source.sourceEvidence.finalRevision !== revision.comparison?.baseRevision)
  ) {
    fail(`${phase} review revision is not chained to its source evidence`);
  }
  const checksRequired =
    source.checksRequired ||
    (revision.comparison?.changedPaths.length ?? 0) > 0;
  assertCheckReceipts(
    document.checks,
    `${phase} review checks`,
    checksRequired,
    256,
  );
  if (document.checksSha256 !== canonicalDigest(document.checks)) {
    fail(`${phase} review check receipt digest is invalid`);
  }
  if (
    phase === "implementation" &&
    canonicalDigest(document.checks) !== canonicalDigest(source.checks)
  ) {
    fail("implementation review checks must exactly match verified execution");
  }
  if (
    canonicalDigest(document.codexReviewPolicy) !==
    canonicalDigest(reviewPolicy)
  ) {
    fail(`${phase} Codex review policy changed after preparation`);
  }
  if (phase === "convergence") {
    if (
      revision.head !== source.sourceEvidence.finalRevision ||
      revision.comparison?.baseRevision !==
        source.sourceEvidence.finalRevision ||
      revision.comparison.changedPaths.length !== 0
    ) {
      fail(
        "convergence review cannot seal unrouted changes; start a fresh routed workflow run",
      );
    }
    const sealedTree = repositoryTree(context, revision.head);
    if (document.checks.some((receipt) => receipt.testedTree !== sealedTree)) {
      fail("convergence checks do not match the sealed Git tree");
    }
  }
}

function verifyClaude(
  document,
  revision,
  phase,
  runId,
  source,
  context,
  reviewPolicy,
) {
  requireSchema(document, runId, `${phase}-review`);
  if (document.state !== "claude-frozen") {
    fail(`Claude ${phase} review has not been frozen`);
  }
  assertSafeIdentifier(document.nonce, `${phase} review nonce`);
  assertRevisionEqual(document.revision, revision, `${phase} revision`);
  assertBoundEvidence(document, source, revision, phase, context, reviewPolicy);
  assertReview(
    document.claudeReview,
    "claude",
    revision.seal,
    `Claude ${phase} review`,
  );
  if (document.claudeReview.modelSource !== "host-selected") {
    fail(`Claude ${phase} review must inherit the host model`);
  }
  assertModel(document.claudeReview.model ?? null, `Claude ${phase} model`);
  if (document.codexReview !== null || document.verdict !== null) {
    fail(
      `Codex ${phase} evidence must not exist before the host review freezes`,
    );
  }
  return hostReviewContextId(document, phase);
}

try {
  const [action, runId, phase = "implementation"] = process.argv.slice(2);
  if (
    !new Set(["prepare", "verify-claude", "verify"]).has(action) ||
    !runId ||
    !new Set(["implementation", "convergence"]).has(phase)
  ) {
    fail(
      "usage: implementation-review.mjs <prepare|verify-claude|verify> <run-id> <implementation|convergence>",
    );
  }
  const context = workflowContext(runId);
  const name = `${phase}-review`;
  const path = evidencePath(context, name);
  const source = reviewSource(context, runId, phase);
  const reviewPolicy = codexReviewPolicy(context, runId);
  const revision = comparisonRevision(
    context,
    source.baseRevision,
    ["spec.md", "plan.md", "tasks.md"],
    true,
  );

  if (action === "prepare") {
    writeJsonAtomic(path, {
      schemaVersion: 1,
      kind: name,
      runId,
      nonce: randomUUID(),
      state: "pending",
      revision,
      sourceEvidence: source.sourceEvidence,
      codexReviewPolicy: reviewPolicy,
      checks: source.checks,
      checksSha256: canonicalDigest(source.checks),
      claudeReview: null,
      codexReview: null,
      verdict: null,
      preparedAt: new Date().toISOString(),
    });
    printSuccess({
      runId,
      phase,
      state: "pending",
      revisionSeal: revision.seal,
    });
  } else {
    const document = readJson(path, `${phase} review evidence`);
    if (action === "verify-claude") {
      const reviewId = verifyClaude(
        document,
        revision,
        phase,
        runId,
        source,
        context,
        reviewPolicy,
      );
      writeJsonAtomic(path, {
        ...document,
        claudeReview: { ...document.claudeReview, reviewId },
      });
      printSuccess({
        runId,
        phase,
        state: "claude-frozen",
        revisionSeal: revision.seal,
        reviewId,
      });
      process.exit(0);
    }
    requireSchema(document, runId, name);
    if (document.state !== "complete") {
      fail(`${phase} review is incomplete`);
    }
    assertRevisionEqual(document.revision, revision, `${phase} revision`);
    assertBoundEvidence(
      document,
      source,
      revision,
      phase,
      context,
      reviewPolicy,
    );
    assertSafeIdentifier(document.nonce, `${phase} review nonce`);
    assertReview(
      document.claudeReview,
      "claude",
      revision.seal,
      `Claude ${phase} review`,
    );
    if (document.claudeReview.modelSource !== "host-selected") {
      fail(`Claude ${phase} review must inherit the host model`);
    }
    assertModel(document.claudeReview.model ?? null, `Claude ${phase} model`);
    if (
      document.claudeReview.reviewId !== hostReviewContextId(document, phase)
    ) {
      fail(
        `Claude ${phase} review is not bound to its frozen evidence context`,
      );
    }
    assertReview(
      document.codexReview,
      "codex",
      revision.seal,
      `Codex ${phase} review`,
    );
    if (document.codexReview.modelSource !== "worker-resolved") {
      fail(
        `Codex ${phase} review must preserve BoundedRelay's observed model source`,
      );
    }
    assertModel(document.codexReview.model ?? null, `Codex ${phase} model`);
    if (
      document.codexReview.model !== reviewPolicy.model ||
      document.codexReview.reasoningEffort !== reviewPolicy.reasoningEffort
    ) {
      fail(`Codex ${phase} review did not use its routed review profile`);
    }
    assertJobId(document.codexReview.jobId, `Codex ${phase} review job id`);
    assertStrictSddReview(
      document.codexReview,
      document.claudeReview,
      revision,
      phase,
    );
    if (
      Date.parse(document.codexReview.startedAt) <
      Date.parse(document.claudeReview.completedAt)
    ) {
      fail(`Codex ${phase} review started before Claude findings were frozen`);
    }
    if (document.verdict !== "approved") {
      fail(
        `${phase} review requested changes; create a new revision and rerun both reviews`,
      );
    }
    if (
      document.verdict === "approved" &&
      (document.claudeReview.verdict !== "approved" ||
        document.codexReview.verdict !== "approved")
    ) {
      fail(
        `${phase} cannot be approved while either reviewer requests changes`,
      );
    }
    printSuccess({
      runId,
      phase,
      state: "complete",
      verdict: document.verdict,
    });
  }
} catch (error) {
  process.stderr.write(
    `Implementation review evidence error: ${error.message}\n`,
  );
  process.exitCode = 1;
}
