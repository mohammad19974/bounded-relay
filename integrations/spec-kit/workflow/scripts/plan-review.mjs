#!/usr/bin/env node

import {
  artifactRevision,
  assertIsoDate,
  assertJobId,
  assertModel,
  assertReview,
  assertRevisionEqual,
  assertSafeIdentifier,
  evidencePath,
  fail,
  hostReviewContextId,
  optionalProjectProfilePath,
  printSuccess,
  readJson,
  requireSchema,
  workflowContext,
  writeJsonAtomic,
} from "./evidence-core.mjs";
import { randomUUID } from "node:crypto";
import { assertStrictSddReview } from "./strict-review.mjs";

function verifyClaude(document, context, runId) {
  requireSchema(document, runId, "plan-review");
  if (document.state !== "claude-frozen") {
    fail("Claude plan review has not been frozen");
  }
  assertSafeIdentifier(document.nonce, "plan review nonce");
  assertRevisionEqual(
    document.revision,
    artifactRevision(
      context,
      ["spec.md", "plan.md"],
      false,
      projectProfileArtifacts(context),
    ),
    "plan revision",
  );
  assertReview(
    document.claudeReview,
    "claude",
    document.revision.seal,
    "Claude plan review",
  );
  if (document.claudeReview.modelSource !== "host-selected") {
    fail("Claude review must inherit the Claude Code host model");
  }
  assertModel(document.claudeReview.model ?? null, "Claude reported model");
  if (document.codexReview !== null) {
    fail("Codex evidence must not exist before the Claude review is frozen");
  }
  return hostReviewContextId(document, "plan");
}

function verifyComplete(document, context, runId) {
  requireSchema(document, runId, "plan-review");
  if (document.state !== "complete") {
    fail("dual plan review is incomplete");
  }
  assertSafeIdentifier(document.nonce, "plan review nonce");
  assertRevisionEqual(
    document.revision,
    artifactRevision(
      context,
      ["spec.md", "plan.md"],
      false,
      projectProfileArtifacts(context),
    ),
    "plan revision",
  );
  assertReview(
    document.claudeReview,
    "claude",
    document.revision.seal,
    "Claude plan review",
  );
  if (document.claudeReview.modelSource !== "host-selected") {
    fail("Claude review must inherit the Claude Code host model");
  }
  assertModel(document.claudeReview.model ?? null, "Claude reported model");
  if (
    document.claudeReview.reviewId !== hostReviewContextId(document, "plan")
  ) {
    fail("Claude plan review is not bound to this run and revision context");
  }
  assertReview(
    document.codexReview,
    "codex",
    document.revision.seal,
    "Codex plan review",
  );
  if (document.codexReview.modelSource !== "worker-resolved") {
    fail("Codex review must preserve BoundedRelay's observed model source");
  }
  assertModel(document.codexReview.model ?? null, "Codex review model");
  assertJobId(document.codexReview.jobId, "Codex plan review job id");
  assertStrictSddReview(
    document.codexReview,
    document.claudeReview,
    document.revision,
    "plan",
  );
  if (
    Date.parse(document.codexReview.startedAt) <
    Date.parse(document.claudeReview.completedAt)
  ) {
    fail("Codex review started before Claude findings were frozen");
  }
  const reconciliation = document.reconciliation;
  if (
    typeof reconciliation !== "object" ||
    reconciliation === null ||
    !new Set(["approved", "changes-requested"]).has(reconciliation.verdict) ||
    typeof reconciliation.summary !== "string" ||
    reconciliation.summary.trim() === "" ||
    reconciliation.summary.length > 8000
  ) {
    fail("plan review reconciliation is invalid");
  }
  assertIsoDate(reconciliation.completedAt, "reconciliation.completedAt");
  if (reconciliation.verdict !== "approved") {
    fail(
      "plan review requested changes; create a new revision and rerun both reviews",
    );
  }
}

function projectProfileArtifacts(context) {
  const path = optionalProjectProfilePath(context);
  return path === null ? [] : [path];
}

try {
  const [action, runId] = process.argv.slice(2);
  if (!new Set(["prepare", "verify-claude", "verify"]).has(action) || !runId) {
    fail("usage: plan-review.mjs <prepare|verify-claude|verify> <run-id>");
  }
  const context = workflowContext(runId);
  const path = evidencePath(context, "plan-review");

  if (action === "prepare") {
    writeJsonAtomic(path, {
      schemaVersion: 1,
      kind: "plan-review",
      runId,
      nonce: randomUUID(),
      state: "pending",
      revision: artifactRevision(
        context,
        ["spec.md", "plan.md"],
        false,
        projectProfileArtifacts(context),
      ),
      claudeReview: null,
      codexReview: null,
      reconciliation: null,
      preparedAt: new Date().toISOString(),
    });
    printSuccess({
      runId,
      state: "pending",
      evidence:
        ".specify/workflows/runs/" + runId + "/evidence/plan-review.json",
    });
  } else {
    const document = readJson(path, "plan review evidence");
    if (action === "verify-claude") {
      const reviewId = verifyClaude(document, context, runId);
      writeJsonAtomic(path, {
        ...document,
        claudeReview: { ...document.claudeReview, reviewId },
      });
      printSuccess({
        runId,
        state: "claude-frozen",
        revisionSeal: document.revision.seal,
        reviewId,
      });
    } else {
      verifyComplete(document, context, runId);
      printSuccess({
        runId,
        state: "complete",
        verdict: document.reconciliation.verdict,
      });
    }
  }
} catch (error) {
  process.stderr.write(`Plan review evidence error: ${error.message}\n`);
  process.exitCode = 1;
}
