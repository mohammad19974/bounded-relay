#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

import {
  assertCleanWorkflowWorktree,
  assertDirectory,
  assertInside,
  assertRegularFile,
  assertSha256,
  canonicalDigest,
  currentGitRevision,
  evidencePath,
  fail,
  fileDigest,
  printSuccess,
  readJson,
  requireSchema,
  workflowContext,
  writeJsonAtomic,
} from "./evidence-core.mjs";

const PROOF_SCRIPT = fileURLToPath(
  new URL("./proof-pack.mjs", import.meta.url),
);
const HANDOFF_RELATIVE_PATH = ".specify/agents/HANDOFF.md";
const DRAFT_FILE = "handoff-draft.md";
const CONTEXT_KEYS = new Set([
  "schemaVersion",
  "kind",
  "runId",
  "proofFile",
  "draftFile",
  "proofSha256",
  "bundleFingerprint",
  "finalRevision",
  "marker",
  "preparedAt",
]);

function assertVerifiedProof(runId) {
  const result = spawnSync(process.execPath, [PROOF_SCRIPT, "verify", runId], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    fail("handoff preparation requires a currently verified proof pack");
  }
}

function assertVerifiedProofIsolated(context, runId) {
  const temporaryRoot = mkdtempSync(
    resolve(tmpdir(), "boundedrelay-handoff-proof-"),
  );
  const clone = resolve(temporaryRoot, "repository");
  try {
    runGit(
      context.projectRoot,
      [
        "-c",
        "protocol.file.allow=always",
        "clone",
        "--quiet",
        "--no-checkout",
        "--no-hardlinks",
        "--no-local",
        context.projectRoot,
        clone,
      ],
      "could not create the isolated handoff proof clone",
    );
    runGit(
      clone,
      ["config", "core.hooksPath", "/dev/null"],
      "could not disable clone hooks",
    );
    runGit(
      clone,
      ["checkout", "--detach", "--quiet", currentGitRevision(context)],
      "could not check out the final proof revision",
    );
    const runsRoot = resolve(clone, ".specify/workflows/runs");
    mkdirSync(runsRoot, { recursive: true, mode: 0o700 });
    const copiedRun = resolve(runsRoot, runId);
    assertInside(runsRoot, copiedRun, "isolated workflow run");
    cpSync(context.runDirectory, copiedRun, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
    });
    const result = spawnSync(
      process.execPath,
      [PROOF_SCRIPT, "verify", runId],
      {
        cwd: clone,
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
        shell: false,
      },
    );
    if (result.error || result.status !== 0) {
      fail("isolated handoff proof revalidation failed");
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function runGit(cwd, args, message) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    fail(message);
  }
}

function expectedContext(context, runId) {
  const proofPath = evidencePath(context, "proof-pack");
  const proof = readJson(proofPath, "proof pack evidence");
  requireSchema(proof, runId, "proof-pack");
  assertSha256(proof.bundleFingerprint, "proof bundle fingerprint");
  const convergence = proof.evidence?.find(
    (entry) => entry.kind === "convergence-review",
  );
  if (
    typeof convergence !== "object" ||
    convergence === null ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(convergence.revision)
  ) {
    fail("proof pack lacks a final convergence revision");
  }
  const proofSha256 = fileDigest(proofPath, "proof pack evidence");
  const marker =
    `<!-- boundedrelay-handoff-v1 run=${runId} ` +
    `proof-sha256=${proofSha256} bundle=${proof.bundleFingerprint} ` +
    `revision=${convergence.revision} -->`;
  return {
    proofFile: "evidence/proof-pack.json",
    draftFile: DRAFT_FILE,
    proofSha256,
    bundleFingerprint: proof.bundleFingerprint,
    finalRevision: convergence.revision,
    marker,
  };
}

function assertDraft(context, expected) {
  const draftPath = resolve(context.runDirectory, DRAFT_FILE);
  assertInside(context.runDirectory, draftPath, "run-local handoff draft");
  assertRegularFile(draftPath, "run-local handoff draft", 256 * 1024);
  const handoff = readFileSync(draftPath, "utf8");
  const markers = handoff.match(/<!-- boundedrelay-handoff-v1 [^\r\n]* -->/gu);
  const finalLine = handoff.trimEnd().split(/\r?\n/u).at(-1);
  if (
    markers?.length !== 1 ||
    markers[0] !== expected.marker ||
    finalLine !== expected.marker
  ) {
    fail("handoff draft lacks the exact proof-pack binding marker");
  }
  return handoff;
}

function publishHandoff(context, handoff) {
  const agentsDirectory = resolve(context.projectRoot, ".specify/agents");
  assertInside(context.projectRoot, agentsDirectory, "agent context directory");
  assertDirectory(agentsDirectory, "agent context directory");
  const handoffPath = resolve(context.projectRoot, HANDOFF_RELATIVE_PATH);
  assertInside(context.projectRoot, handoffPath, "canonical handoff path");
  try {
    assertRegularFile(handoffPath, "canonical handoff", 256 * 1024);
  } catch (error) {
    if (!String(error.message).includes("is missing")) {
      throw error;
    }
  }
  const temporaryPath = resolve(
    agentsDirectory,
    `.HANDOFF.${process.pid}.${randomUUID()}.tmp`,
  );
  assertInside(agentsDirectory, temporaryPath, "temporary handoff path");
  try {
    writeFileSync(temporaryPath, handoff, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, handoffPath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may already have been renamed or never created.
    }
    fail(`could not publish the verified handoff: ${error.message}`);
  }
}

function currentCanonicalHandoff(context) {
  const handoffPath = resolve(context.projectRoot, HANDOFF_RELATIVE_PATH);
  assertInside(context.projectRoot, handoffPath, "canonical handoff path");
  try {
    assertRegularFile(handoffPath, "canonical handoff", 256 * 1024);
    return readFileSync(handoffPath, "utf8");
  } catch (error) {
    if (String(error.message).includes("is missing")) {
      return null;
    }
    throw error;
  }
}

function assertOnlyHandoffChanged(context) {
  const status = spawnSync(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    {
      cwd: context.projectRoot,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      shell: false,
    },
  );
  if (status.error || status.status !== 0) {
    fail("could not verify handoff worktree scope");
  }
  const unexpected = status.stdout
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(3))
    .filter(
      (path) =>
        path !== HANDOFF_RELATIVE_PATH &&
        !path.startsWith(".specify/workflows/runs/"),
    );
  if (unexpected.length > 0) {
    fail("handoff verification found changes outside the canonical handoff");
  }
}

try {
  const [action, runId] = process.argv.slice(2);
  if (!new Set(["prepare", "verify"]).has(action) || !runId) {
    fail("usage: handoff.mjs <prepare|verify> <run-id>");
  }
  const context = workflowContext(runId);
  const path = evidencePath(context, "handoff-context");

  if (action === "prepare") {
    assertVerifiedProof(runId);
    const expected = expectedContext(context, runId);
    if (currentGitRevision(context) !== expected.finalRevision) {
      fail("handoff preparation revision differs from the proof pack");
    }
    writeJsonAtomic(path, {
      schemaVersion: 1,
      kind: "handoff-context",
      runId,
      ...expected,
      preparedAt: new Date().toISOString(),
    });
    printSuccess({
      runId,
      state: "pending-handoff",
      marker: expected.marker,
    });
    process.exit(0);
  }

  assertOnlyHandoffChanged(context);
  assertVerifiedProofIsolated(context, runId);
  const verifiedExpected = expectedContext(context, runId);
  const document = readJson(path, "handoff context evidence");
  requireSchema(document, runId, "handoff-context");
  if (
    Object.keys(document).some((key) => !CONTEXT_KEYS.has(key)) ||
    Number.isNaN(Date.parse(document.preparedAt)) ||
    canonicalDigest({
      proofFile: document.proofFile,
      draftFile: document.draftFile,
      proofSha256: document.proofSha256,
      bundleFingerprint: document.bundleFingerprint,
      finalRevision: document.finalRevision,
      marker: document.marker,
    }) !== canonicalDigest(verifiedExpected)
  ) {
    fail("handoff context is stale or malformed");
  }
  if (currentGitRevision(context) !== verifiedExpected.finalRevision) {
    fail("repository revision changed after proof approval");
  }
  const handoff = assertDraft(context, verifiedExpected);
  const published = currentCanonicalHandoff(context);
  if (published === null) {
    assertCleanWorkflowWorktree(context);
    publishHandoff(context, handoff);
  } else if (published !== handoff) {
    publishHandoff(context, handoff);
  }
  assertOnlyHandoffChanged(context);
  printSuccess({
    runId,
    state: "verified-handoff",
    proofSha256: verifiedExpected.proofSha256,
    finalRevision: verifiedExpected.finalRevision,
  });
} catch (error) {
  process.stderr.write(`Handoff binding error: ${error.message}\n`);
  process.exitCode = 1;
}
