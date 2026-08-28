#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";

import {
  assertRevisionEqual,
  assertJobId,
  assertSha256,
  canonicalDigest,
  comparisonRevision,
  evidencePath,
  fail,
  failChild,
  fileDigest,
  hostReviewContextId,
  optionalProjectProfilePath,
  printSuccess,
  readJson,
  requireSchema,
  workflowContext,
  writeJsonAtomic,
} from "./evidence-core.mjs";
import { assertCheckReceipts } from "./check-receipts.mjs";
import { assertStrictSddReview } from "./strict-review.mjs";

const ROUTING_POLICY_VERSION = "sdd-routing-v2";
const FIT_POLICY_VERSION = "sdd-task-fit-v1";
const PROFILED_ROUTING_POLICY_VERSION = "sdd-routing-v3";
const PROFILED_FIT_POLICY_VERSION = "sdd-capability-fit-v1";
const ROUTER_ENTRY = fileURLToPath(
  new URL("../../../../dist/cli.js", import.meta.url),
);
const EXECUTION_SCRIPT = fileURLToPath(
  new URL("./execution.mjs", import.meta.url),
);
const ROUTING_SCRIPT = fileURLToPath(new URL("./routing.mjs", import.meta.url));

function loadComplete(context, name) {
  const path = evidencePath(context, name);
  const document = readJson(path, `${name} evidence`);
  requireSchema(document, context.runId, name);
  if (document.state !== "complete") {
    fail(`${name} evidence is incomplete`);
  }
  return { document, path };
}

function approvedReview(document, phase) {
  const verdict =
    phase === "plan" ? document.reconciliation?.verdict : document.verdict;
  if (
    verdict !== "approved" ||
    document.claudeReview?.verdict !== "approved" ||
    document.codexReview?.verdict !== "approved"
  ) {
    fail(`${phase} review is not approved by both providers`);
  }
  const codex = document.codexReview;
  assertStrictSddReview(codex, document.claudeReview, document.revision, phase);
  assertJobId(codex.jobId, `${phase} Codex review job id`);
  if (document.claudeReview.reviewId !== hostReviewContextId(document, phase)) {
    fail(`${phase} host review is not bound to its frozen workflow context`);
  }
  const strict = codex.sddReview;
  if (
    strict?.tool !== "codex_worker_sdd_review" ||
    strict.phase !== phase ||
    strict.mode !== "strict" ||
    strict.gate?.passed !== true ||
    strict.gate?.status !== "ready"
  ) {
    fail(`${phase} review lacks a ready strict dual-review gate`);
  }
  assertSha256(strict.seal?.sealId, `${phase} strict seal id`);
  assertSha256(
    strict.gate?.evidenceDigests?.codex,
    `${phase} Codex evidence digest`,
  );
  if (phase !== "plan") {
    assertCheckReceipts(
      document.checks,
      `${phase} review checks`,
      false,
      256,
      false,
    );
    if (document.checksSha256 !== canonicalDigest(document.checks)) {
      fail(`${phase} review check receipt digest is invalid`);
    }
    if (
      codex.model !== document.codexReviewPolicy?.model ||
      codex.reasoningEffort !== document.codexReviewPolicy?.reasoningEffort
    ) {
      fail(`${phase} Codex review does not match its prepared model policy`);
    }
  }
  assertSha256(
    strict.gate?.evidenceDigests?.host,
    `${phase} host evidence digest`,
  );
  return {
    phase,
    jobId: codex.jobId,
    sealId: strict.seal.sealId,
    hostEvidenceSha256: strict.gate.evidenceDigests.host,
    codexEvidenceSha256: strict.gate.evidenceDigests.codex,
  };
}

function assertStaticRouting(runId) {
  const routing = spawnSync(
    process.execPath,
    [ROUTING_SCRIPT, "verify-static", runId],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      shell: false,
    },
  );
  if (routing.error || routing.status !== 0) {
    failChild(
      "proof pack could not revalidate complete routing evidence",
      routing,
    );
  }
}

function assertHistoricalReviewChain(execution, implementation, convergence) {
  const finalCheckpoint = execution.document.checkpoints?.at(-1);
  if (finalCheckpoint?.completedRevision === undefined) {
    fail("review chain requires a final execution checkpoint");
  }
  const expectedImplementationSource = {
    kind: "execution",
    sha256: fileDigest(execution.path, "execution evidence"),
    finalRevision: finalCheckpoint.completedRevision,
  };
  const executionChecks = execution.document.results.flatMap(
    (result) => result.checks ?? [],
  );
  if (
    canonicalDigest(implementation.document.sourceEvidence) !==
      canonicalDigest(expectedImplementationSource) ||
    implementation.document.revision?.head !==
      expectedImplementationSource.finalRevision ||
    implementation.document.revision?.comparison?.baseRevision !==
      execution.document.routingRevision ||
    canonicalDigest(implementation.document.checks) !==
      canonicalDigest(executionChecks)
  ) {
    fail(
      "implementation review is not bound to the included execution history",
    );
  }
  const expectedConvergenceSource = {
    kind: "implementation-review",
    sha256: fileDigest(implementation.path, "implementation review evidence"),
    finalRevision: implementation.document.revision.head,
  };
  if (
    canonicalDigest(convergence.document.sourceEvidence) !==
      canonicalDigest(expectedConvergenceSource) ||
    convergence.document.revision?.head !==
      implementation.document.revision.head ||
    convergence.document.revision?.comparison?.baseRevision !==
      implementation.document.revision.head ||
    convergence.document.revision?.comparison?.changedPaths?.length !== 0
  ) {
    fail(
      "convergence review is not a no-delta audit of the routed implementation",
    );
  }
}

function assertAuthoritativeRoute(routing) {
  const execution = spawnSync(
    process.execPath,
    [ROUTER_ENTRY, "sdd", "route"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      input: JSON.stringify(routing.router?.request),
      maxBuffer: 2 * 1024 * 1024,
      timeout: 30_000,
      shell: false,
    },
  );
  if (execution.error || execution.status !== 0) {
    fail("proof pack could not run the authoritative SDD router");
  }
  let result;
  try {
    result = JSON.parse(execution.stdout);
  } catch {
    fail("authoritative SDD router returned invalid JSON");
  }
  if (canonicalDigest(result) !== canonicalDigest(routing.router?.result)) {
    fail("proof pack routing evidence differs from the authoritative router");
  }
}

function assertExecutionHistory(runId) {
  const execution = spawnSync(
    process.execPath,
    [EXECUTION_SCRIPT, "verify-history", runId],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      shell: false,
    },
  );
  if (execution.error || execution.status !== 0) {
    failChild(
      "proof pack could not revalidate wave execution history",
      execution,
    );
  }
}

function evidenceRecord(name, loaded, fallbackRevision) {
  const revision = loaded.document.revision ?? fallbackRevision;
  assertSha256(revision?.seal, `${name} revision seal`);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(revision?.head)) {
    fail(`${name} revision must be a full Git object id`);
  }
  return {
    kind: name,
    file: `evidence/${name}.json`,
    sha256: fileDigest(loaded.path, `${name} evidence`),
    revision: revision.head,
    revisionSeal: revision.seal,
  };
}

try {
  const [action, runId] = process.argv.slice(2);
  if (!new Set(["assemble", "verify"]).has(action) || !runId) {
    fail("usage: proof-pack.mjs <assemble|verify> <run-id>");
  }
  const context = { ...workflowContext(runId), runId };

  const plan = loadComplete(context, "plan-review");
  const routing = loadComplete(context, "routing");
  const execution = loadComplete(context, "execution");
  const implementation = loadComplete(context, "implementation-review");
  const convergence = loadComplete(context, "convergence-review");
  assertStaticRouting(runId);
  assertHistoricalReviewChain(execution, implementation, convergence);

  const routeResult = routing.document.router?.result;
  const legacyPolicies =
    routeResult?.schemaVersion === 1 &&
    routeResult.routingPolicyVersion === ROUTING_POLICY_VERSION &&
    routeResult.fitPolicyVersion === FIT_POLICY_VERSION &&
    (routing.document.projectProfile ?? null) === null;
  const profiledPolicies =
    routeResult?.schemaVersion === 2 &&
    routeResult.routingPolicyVersion === PROFILED_ROUTING_POLICY_VERSION &&
    routeResult.fitPolicyVersion === PROFILED_FIT_POLICY_VERSION &&
    (routing.document.projectProfile ?? null) !== null;
  if (!legacyPolicies && !profiledPolicies) {
    fail("proof pack requires the current routing and fit policies");
  }
  assertSha256(routeResult.planFingerprint, "route plan fingerprint");
  assertAuthoritativeRoute(routing.document);

  const routingSha256 = fileDigest(routing.path, "routing evidence");
  if (execution.document.routingSha256 !== routingSha256) {
    fail("execution evidence does not match the routed plan");
  }
  if (
    routing.document.planReviewSha256 !==
    fileDigest(plan.path, "plan review evidence")
  ) {
    fail("routing evidence is not bound to the included plan review");
  }
  assertExecutionHistory(runId);
  const delegatedJobs = execution.document.results
    .filter((result) => result.provider === "codex")
    .map((result) => {
      if (result.status !== "accepted" || result.transport !== "boundedrelay") {
        fail(`delegated task ${result.taskId} is not accepted`);
      }
      assertJobId(result.jobId, `delegated task ${result.taskId} job id`);
      if (!new Set(["analysis", "proposal-integrated"]).has(result.effect)) {
        fail(`delegated task ${result.taskId} has an invalid effect`);
      }
      if (result.effect === "proposal-integrated") {
        assertSha256(
          result.patchSha256,
          `delegated task ${result.taskId} patch digest`,
        );
      }
      return {
        taskId: result.taskId,
        wave: result.wave,
        jobId: result.jobId,
        effect: result.effect,
        baselineRevision: result.baselineRevision,
        ...(result.effect === "proposal-integrated"
          ? {
              patchSha256: result.patchSha256,
              changedFiles: [...result.changedFiles].sort(),
            }
          : {}),
      };
    });

  const projectProfilePath = optionalProjectProfilePath(context);
  const currentConvergenceRevision = comparisonRevision(
    context,
    convergence.document.sourceEvidence?.finalRevision,
    ["spec.md", "plan.md", "tasks.md"],
    true,
    projectProfilePath === null ? [] : [projectProfilePath],
  );
  assertRevisionEqual(
    convergence.document.revision,
    currentConvergenceRevision,
    "current convergence revision",
  );

  const reviews = [
    approvedReview(plan.document, "plan"),
    approvedReview(implementation.document, "implementation"),
    approvedReview(convergence.document, "convergence"),
  ];
  const evidence = [
    evidenceRecord("plan-review", plan, routing.document.revision),
    evidenceRecord("routing", routing, routing.document.revision),
    {
      kind: "execution",
      file: "evidence/execution.json",
      sha256: fileDigest(execution.path, "execution evidence"),
      revision: execution.document.checkpoints.at(-1).completedRevision,
      revisionSeal: canonicalDigest({
        routingSha256: execution.document.routingSha256,
        checkpoints: execution.document.checkpoints,
      }),
    },
    evidenceRecord(
      "implementation-review",
      implementation,
      routing.document.revision,
    ),
    evidenceRecord(
      "convergence-review",
      convergence,
      routing.document.revision,
    ),
  ];
  const payload = {
    schemaVersion: 1,
    kind: "proof-pack",
    runId,
    state: "complete",
    policy: {
      routingPolicyVersion: routeResult.routingPolicyVersion,
      fitPolicyVersion: routeResult.fitPolicyVersion,
      planFingerprint: routeResult.planFingerprint,
      projectProfile: routing.document.projectProfile ?? null,
      crossReviewPolicy: routing.document.crossReviewPolicy ?? null,
    },
    routingTotals: routing.document.totals,
    decisions: {
      plan: "approved",
      implementation: "approved",
      convergence: "approved",
    },
    evidence,
    codexReviews: reviews,
    delegatedJobs,
    executionCheckpoints: execution.document.checkpoints.map((checkpoint) => ({
      wave: checkpoint.wave,
      writerTaskId: checkpoint.writerTaskId,
      baselineRevision: checkpoint.baselineRevision,
      completedRevision: checkpoint.completedRevision,
      diffSha256: checkpoint.diffSha256,
      resultsSha256: checkpoint.resultsSha256,
      checksSha256: checkpoint.checksSha256,
    })),
    checkEvidence: [implementation.document, convergence.document].map(
      (review) => ({
        phase:
          review.kind === "implementation-review"
            ? "implementation"
            : "convergence",
        count: review.checks.length,
        sha256: review.checksSha256,
      }),
    ),
  };
  const bundleFingerprint = canonicalDigest(payload);
  const path = evidencePath(context, "proof-pack");
  if (action === "assemble") {
    writeJsonAtomic(path, {
      ...payload,
      bundleFingerprint,
      assembledAt: new Date().toISOString(),
    });
  } else {
    const existing = readJson(path, "proof pack evidence");
    requireSchema(existing, runId, "proof-pack");
    const { assembledAt, ...actual } = existing;
    if (
      typeof assembledAt !== "string" ||
      Number.isNaN(Date.parse(assembledAt)) ||
      canonicalDigest(actual) !==
        canonicalDigest({ ...payload, bundleFingerprint })
    ) {
      fail("proof pack no longer matches its revalidated source evidence");
    }
  }
  printSuccess({
    runId,
    state: "complete",
    verified: action === "verify",
    bundleFingerprint,
    evidenceFiles: evidence.length,
    codexJobs: reviews.length + delegatedJobs.length,
  });
} catch (error) {
  process.stderr.write(`Proof pack error: ${error.message}\n`);
  process.exitCode = 1;
}
