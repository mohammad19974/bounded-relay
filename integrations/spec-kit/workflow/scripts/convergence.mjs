#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";

import {
  currentGitRevision,
  evidencePath,
  fail,
  printSuccess,
  readJson,
  requireSchema,
  workflowContext,
} from "./evidence-core.mjs";

const IMPLEMENTATION_REVIEW_SCRIPT = fileURLToPath(
  new URL("./implementation-review.mjs", import.meta.url),
);

function verifyImplementationReview(runId) {
  const result = spawnSync(
    process.execPath,
    [IMPLEMENTATION_REVIEW_SCRIPT, "verify", runId, "implementation"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      shell: false,
    },
  );
  if (result.error || result.status !== 0) {
    fail(
      "convergence changed reviewed state; preserve the new tasks and start a fresh approved routing run",
    );
  }
}

try {
  const [action, runId] = process.argv.slice(2);
  if (action !== "verify-no-new-work" || !runId) {
    fail("usage: convergence.mjs verify-no-new-work <run-id>");
  }
  const context = workflowContext(runId);
  verifyImplementationReview(runId);
  const implementation = readJson(
    evidencePath(context, "implementation-review"),
    "implementation review evidence",
  );
  requireSchema(implementation, runId, "implementation-review");
  if (
    implementation.state !== "complete" ||
    implementation.verdict !== "approved" ||
    implementation.claudeReview?.verdict !== "approved" ||
    implementation.codexReview?.verdict !== "approved" ||
    currentGitRevision(context) !== implementation.revision?.head
  ) {
    fail(
      "convergence may continue only when it found no work beyond the approved routed revision",
    );
  }
  printSuccess({
    runId,
    state: "no-new-work",
    revision: implementation.revision.head,
    next: "convergence-review",
  });
} catch (error) {
  process.stderr.write(`Convergence boundary error: ${error.message}\n`);
  process.exitCode = 1;
}
