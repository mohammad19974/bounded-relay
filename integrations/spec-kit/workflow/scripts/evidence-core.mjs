#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

export const MAX_EVIDENCE_BYTES = 256 * 1024;
export const MAX_PROJECT_PROFILE_BYTES = 128 * 1024;
const MAX_INPUT_BYTES = 128 * 1024;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACTS = 64;
const MAX_TOTAL_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_REVIEW_SCOPE_PATHS = 256;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FULL_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export function fail(message) {
  throw new Error(message);
}

const MAX_CHILD_DIAGNOSTIC_CHARS = 2_000;

/**
 * Fails with the child's own diagnostics attached. A nested verification chain
 * that reports only its own layer is not operable: the real cause is whatever
 * the child wrote before exiting.
 */
export function failChild(message, result) {
  const detail = [result?.error?.message, result?.stderr, result?.stdout]
    .filter((value) => typeof value === "string" && value.trim() !== "")
    .join("\n")
    .trim()
    .slice(-MAX_CHILD_DIAGNOSTIC_CHARS);
  fail(detail === "" ? message : `${message}: ${detail}`);
}

export function assertSafeIdentifier(value, label = "identifier") {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value)) {
    fail(`${label} is invalid`);
  }
}

export function assertInside(parent, candidate, label, allowSame = false) {
  const rel = relative(parent, candidate);
  if (
    (allowSame && rel === "") ||
    (rel !== "" &&
      rel !== ".." &&
      !rel.startsWith(`..${sep}`) &&
      !rel.startsWith(sep))
  ) {
    return;
  }
  fail(`${label} escapes its expected directory`);
}

export function assertDirectory(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail(`${label} is missing`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(`${label} must be a non-symlink directory`);
  }
}

export function assertRegularFile(path, label, maxBytes = MAX_EVIDENCE_BYTES) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail(`${label} is missing`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail(`${label} must be a regular non-symlink file`);
  }
  if (stat.size > maxBytes) {
    fail(`${label} exceeds ${maxBytes} bytes`);
  }
  return stat;
}

export function readJson(path, label, maxBytes = MAX_EVIDENCE_BYTES) {
  assertRegularFile(path, label, maxBytes);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

export function writeJsonAtomic(path, value) {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    fail(`could not atomically write evidence: ${error.message}`);
  }
}

export function workflowContext(runId) {
  assertSafeIdentifier(runId, "workflow run id");
  const projectRoot = realpathSync(resolve(process.cwd()));
  const specifyRoot = resolve(projectRoot, ".specify");
  const workflowsRoot = resolve(specifyRoot, "workflows");
  const runsRoot = resolve(workflowsRoot, "runs");
  assertDirectory(specifyRoot, ".specify directory");
  assertDirectory(workflowsRoot, "workflow state directory");
  assertDirectory(runsRoot, "workflow runs directory");
  assertInside(
    projectRoot,
    realpathSync(runsRoot),
    "resolved workflow runs directory",
  );
  const runDirectory = resolve(runsRoot, runId);
  assertInside(runsRoot, runDirectory, "workflow run directory");
  assertDirectory(runDirectory, "workflow run directory");

  const inputsPath = resolve(runDirectory, "inputs.json");
  const document = readJson(inputsPath, "workflow inputs", MAX_INPUT_BYTES);
  const inputs = document?.inputs;
  if (typeof inputs !== "object" || inputs === null || Array.isArray(inputs)) {
    fail("workflow inputs must contain an inputs object");
  }

  const featureDirectory = inputs.feature_directory;
  if (
    typeof featureDirectory !== "string" ||
    featureDirectory.length > 4096 ||
    featureDirectory.startsWith("/") ||
    featureDirectory.includes("\0") ||
    featureDirectory.includes("\\") ||
    /^[A-Za-z]:/u.test(featureDirectory) ||
    featureDirectory
      .split("/")
      .some(
        (part) =>
          part === "" ||
          part === "." ||
          part === ".." ||
          part.toLowerCase() === ".git",
      )
  ) {
    fail("feature_directory must be a safe relative path");
  }
  const requestedFeaturePath = resolve(projectRoot, featureDirectory);
  assertInside(projectRoot, requestedFeaturePath, "feature directory");
  assertNoSymlinkSegments(projectRoot, featureDirectory, "feature directory");
  assertDirectory(requestedFeaturePath, "feature directory");
  const featurePath = realpathSync(requestedFeaturePath);
  assertInside(projectRoot, featurePath, "resolved feature directory");

  const evidenceDirectory = resolve(runDirectory, "evidence");
  assertInside(runDirectory, evidenceDirectory, "evidence directory");
  try {
    assertDirectory(evidenceDirectory, "evidence directory");
  } catch (error) {
    if (!String(error.message).includes("is missing")) {
      throw error;
    }
    mkdirSync(evidenceDirectory, { mode: 0o700 });
  }

  return {
    projectRoot,
    runDirectory,
    evidenceDirectory,
    featureDirectory,
    featurePath,
    inputs,
  };
}

export function evidencePath(context, name) {
  assertSafeIdentifier(name, "evidence name");
  const path = resolve(context.evidenceDirectory, `${name}.json`);
  assertInside(context.evidenceDirectory, path, "evidence file");
  return path;
}

export function optionalProjectProfilePath(context) {
  const value = context?.inputs?.project_profile;
  if (value === undefined || value === "") {
    return null;
  }
  const repositoryPath = safeRepositoryPath(value, "project_profile");
  const path = resolve(context.projectRoot, ...repositoryPath.split("/"));
  assertInside(context.projectRoot, path, "project profile");
  assertNoSymlinkSegments(
    context.projectRoot,
    repositoryPath,
    "project profile",
  );
  assertRegularFile(path, "project profile", MAX_PROJECT_PROFILE_BYTES);
  const committedBytes = readCommittedRepositoryFile(
    context,
    currentGitRevision(context),
    repositoryPath,
    "project profile",
    MAX_PROJECT_PROFILE_BYTES,
  );
  if (!readFileSync(path).equals(committedBytes)) {
    fail("project_profile does not match the sealed Git revision");
  }
  return repositoryPath;
}

export function artifactRevision(
  context,
  artifacts,
  includeWorktree = false,
  extraRepositoryPaths = [],
) {
  const repositoryPaths = artifactRepositoryPaths(
    context,
    artifacts,
    extraRepositoryPaths,
  );
  return projectRevision(context, repositoryPaths, includeWorktree, null);
}

export function artifactRevisionAt(
  context,
  revisionValue,
  artifacts,
  extraRepositoryPaths = [],
) {
  const head = normalizedRevision(revisionValue, "artifact revision");
  runGit(context.projectRoot, ["rev-parse", "--verify", `${head}^{commit}`]);
  const repositoryPaths = artifactRepositoryPaths(
    context,
    artifacts,
    extraRepositoryPaths,
  );
  if (repositoryPaths.length === 0 || repositoryPaths.length > MAX_ARTIFACTS) {
    fail(`strict review supports 1-${MAX_ARTIFACTS} existing artifacts`);
  }
  const canonicalPaths = [...repositoryPaths].sort(compareCodeUnits);
  if (new Set(canonicalPaths).size !== canonicalPaths.length) {
    fail("strict review artifact paths must be unique");
  }

  let totalBytes = 0;
  const artifactRecords = canonicalPaths.map((repositoryPath) => {
    const bytes = readCommittedRepositoryFile(
      context,
      head,
      repositoryPath,
      `${repositoryPath} artifact`,
      MAX_ARTIFACT_BYTES,
    );
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_ARTIFACT_BYTES) {
      fail(
        `strict review artifacts exceed ${MAX_TOTAL_ARTIFACT_BYTES} total bytes`,
      );
    }
    return {
      path: repositoryPath,
      bytes: bytes.byteLength,
      sha256: digest(bytes),
    };
  });
  const payload = {
    head,
    artifacts: artifactRecords,
    comparison: null,
    worktreeSha256: null,
  };
  return { ...payload, seal: digest(JSON.stringify(payload)) };
}

function artifactRepositoryPaths(context, artifacts, extraRepositoryPaths) {
  const featurePaths = artifacts.map((name) => {
    assertSafeIdentifier(name.replace(/\.md$/u, ""), "artifact name");
    return `${context.featureDirectory}/${name}`;
  });
  const extras = extraRepositoryPaths.map((path) =>
    safeRepositoryPath(path, "additional review artifact path"),
  );
  return [...featurePaths, ...extras];
}

export function comparisonRevision(
  context,
  baseRevisionValue,
  requiredArtifacts,
  includeWorktree = true,
  extraRepositoryPaths = [],
) {
  const comparison = repositoryRevisionComparison(context, baseRevisionValue);
  const requiredPaths = artifactRepositoryPaths(
    context,
    requiredArtifacts,
    extraRepositoryPaths,
  );
  return projectRevision(
    context,
    [...new Set(requiredPaths)],
    includeWorktree,
    {
      baseRevision: comparison.baseRevision,
      changedPaths: comparison.changedPaths,
      diffSha256: comparison.diffSha256,
    },
  );
}

function projectRevision(
  context,
  repositoryPaths,
  includeWorktree,
  comparison,
) {
  if (
    !Array.isArray(repositoryPaths) ||
    repositoryPaths.length === 0 ||
    repositoryPaths.length > MAX_ARTIFACTS
  ) {
    fail(`strict review supports 1-${MAX_ARTIFACTS} existing artifacts`);
  }
  const canonicalPaths = repositoryPaths
    .map((path) => safeRepositoryPath(path, "review artifact path"))
    .sort(compareCodeUnits);
  if (new Set(canonicalPaths).size !== canonicalPaths.length) {
    fail("strict review artifact paths must be unique");
  }

  let totalBytes = 0;
  const artifactRecords = canonicalPaths.map((repositoryPath) => {
    const path = resolve(context.projectRoot, ...repositoryPath.split("/"));
    assertInside(context.projectRoot, path, "review artifact");
    assertNoSymlinkSegments(
      context.projectRoot,
      repositoryPath,
      `${repositoryPath} artifact`,
    );
    const stat = assertRegularFile(
      path,
      `${repositoryPath} artifact`,
      MAX_ARTIFACT_BYTES,
    );
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_ARTIFACT_BYTES) {
      fail(
        `strict review artifacts exceed ${MAX_TOTAL_ARTIFACT_BYTES} total bytes`,
      );
    }
    runGit(context.projectRoot, [
      "ls-files",
      "--error-unmatch",
      "--",
      repositoryPath,
    ]);
    const bytes = readFileSync(path);
    const committedBytes = runGitBuffer(context.projectRoot, [
      "show",
      `HEAD:${repositoryPath}`,
    ]);
    if (!bytes.equals(committedBytes)) {
      fail(`${repositoryPath} does not match the sealed Git revision`);
    }
    return {
      path: repositoryPath,
      bytes: bytes.byteLength,
      sha256: digest(bytes),
    };
  });

  const head = currentGitRevision(context);
  assertCleanWorkflowWorktree(context);
  const worktreeSha256 = includeWorktree
    ? workingTreeDigest(context.projectRoot)
    : null;
  const payload = {
    head,
    artifacts: artifactRecords,
    comparison,
    worktreeSha256,
  };
  return { ...payload, seal: digest(JSON.stringify(payload)) };
}

export function currentGitRevision(context) {
  return normalizedRevision(
    runGit(context.projectRoot, ["rev-parse", "HEAD"]).trim().toLowerCase(),
    "Git HEAD",
  );
}

export function assertRevisionAncestor(
  context,
  ancestorRevisionValue,
  descendantRevisionValue,
  label = "revision ancestry",
) {
  const ancestorRevision = normalizedRevision(
    ancestorRevisionValue,
    `${label} ancestor`,
  );
  const descendantRevision = normalizedRevision(
    descendantRevisionValue,
    `${label} descendant`,
  );
  runGit(context.projectRoot, [
    "rev-parse",
    "--verify",
    `${ancestorRevision}^{commit}`,
  ]);
  runGit(context.projectRoot, [
    "rev-parse",
    "--verify",
    `${descendantRevision}^{commit}`,
  ]);
  const ancestry = spawnGit(context.projectRoot, [
    "merge-base",
    "--is-ancestor",
    ancestorRevision,
    descendantRevision,
  ]);
  if (ancestry.status !== 0) {
    fail(`${label} is not an ancestor chain`);
  }
}

export function repositoryTree(
  context,
  revisionValue = currentGitRevision(context),
) {
  const revision = normalizedRevision(revisionValue, "tree revision");
  return normalizedRevision(
    runGit(context.projectRoot, ["rev-parse", "--verify", `${revision}^{tree}`])
      .trim()
      .toLowerCase(),
    "Git tree",
  );
}

export function assertCleanWorkflowWorktree(context) {
  const status = runGit(context.projectRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
  ])
    .split("\n")
    .filter(Boolean)
    .filter(
      (line) =>
        !line
          .slice(3)
          .replace(/^"|"$/gu, "")
          .startsWith(".specify/workflows/runs/"),
    );
  if (status.length > 0) {
    fail(
      "strict evidence requires a clean Git worktree outside run-local workflow evidence",
    );
  }
}

export function repositoryRevisionComparison(
  context,
  baseRevisionValue,
  currentRevisionValue = currentGitRevision(context),
) {
  const baseRevision = normalizedRevision(baseRevisionValue, "base revision");
  const currentRevision = normalizedRevision(
    currentRevisionValue,
    "current revision",
  );
  runGit(context.projectRoot, [
    "rev-parse",
    "--verify",
    `${baseRevision}^{commit}`,
  ]);
  runGit(context.projectRoot, [
    "rev-parse",
    "--verify",
    `${currentRevision}^{commit}`,
  ]);
  const ancestry = spawnGit(context.projectRoot, [
    "merge-base",
    "--is-ancestor",
    baseRevision,
    currentRevision,
  ]);
  if (ancestry.status !== 0) {
    fail("review comparison base must be an ancestor of the current revision");
  }
  const changedPaths = gitChangedPaths(context, baseRevision, currentRevision);
  if (changedPaths.length > MAX_REVIEW_SCOPE_PATHS) {
    fail(
      `review comparison exceeds ${MAX_REVIEW_SCOPE_PATHS} changed paths; split the checkpoint`,
    );
  }
  const diff = runGitBuffer(context.projectRoot, [
    "diff",
    "--binary",
    "--full-index",
    "--no-ext-diff",
    "--no-renames",
    `${baseRevision}..${currentRevision}`,
    "--",
  ]);
  return {
    baseRevision,
    currentRevision,
    changedPaths,
    diffSha256: digest(diff),
  };
}

function gitChangedPaths(context, baseRevision, currentRevision, diffFilter) {
  const args = ["diff", "--name-only", "-z", "--no-ext-diff", "--no-renames"];
  if (diffFilter !== undefined) {
    args.push(`--diff-filter=${diffFilter}`);
  }
  args.push(`${baseRevision}..${currentRevision}`, "--");
  const paths = runGit(context.projectRoot, args)
    .split("\0")
    .filter(Boolean)
    .map((path) => safeRepositoryPath(path, "changed review path"))
    .sort(compareCodeUnits);
  if (new Set(paths).size !== paths.length) {
    fail("Git comparison returned duplicate changed paths");
  }
  return paths;
}

export function assertRevisionEqual(expected, actual, label = "revision") {
  if (
    typeof expected !== "object" ||
    expected === null ||
    typeof actual !== "object" ||
    actual === null ||
    canonicalDigest(expected) !== canonicalDigest(actual)
  ) {
    fail(`${label} is stale`);
  }
}

export function fileDigest(path, label, maxBytes = MAX_EVIDENCE_BYTES) {
  assertRegularFile(path, label, maxBytes);
  return digest(readFileSync(path));
}

export function readCommittedRepositoryFile(
  context,
  revisionValue,
  repositoryPathValue,
  label,
  maxBytes = MAX_ARTIFACT_BYTES,
) {
  const revision = normalizedRevision(revisionValue, `${label} revision`);
  const repositoryPath = safeRepositoryPath(
    repositoryPathValue,
    `${label} path`,
  );
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    fail(`${label} byte limit is invalid`);
  }
  const output = runGitBuffer(context.projectRoot, [
    "ls-tree",
    "-z",
    revision,
    "--",
    repositoryPath,
  ]);
  const nul = output.indexOf(0);
  if (
    nul <= 0 ||
    nul !== output.byteLength - 1 ||
    output.indexOf(0, nul + 1) !== -1
  ) {
    fail(`${label} is missing or ambiguous at the committed revision`);
  }
  const record = output.subarray(0, nul);
  const tab = record.indexOf(0x09);
  if (tab <= 0) {
    fail(`${label} has invalid committed Git metadata`);
  }
  const metadata = record.subarray(0, tab).toString("ascii").split(" ");
  const committedPath = record.subarray(tab + 1);
  if (
    metadata.length !== 3 ||
    !new Set(["100644", "100755"]).has(metadata[0]) ||
    metadata[1] !== "blob" ||
    !FULL_REVISION.test(metadata[2] ?? "") ||
    !committedPath.equals(Buffer.from(repositoryPath))
  ) {
    fail(`${label} must be an exact regular committed file`);
  }
  const objectId = metadata[2];
  const sizeText = runGit(context.projectRoot, [
    "cat-file",
    "-s",
    objectId,
  ]).trim();
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
    fail(`${label} exceeds ${maxBytes} bytes`);
  }
  const bytes = runGitBuffer(context.projectRoot, [
    "cat-file",
    "blob",
    objectId,
  ]);
  if (bytes.byteLength !== size) {
    fail(`${label} committed byte count changed during inspection`);
  }
  return bytes;
}

export function canonicalDigest(value) {
  return digest(canonicalJson(value));
}

export function hostReviewContextId(document, phase) {
  assertSafeIdentifier(document?.runId, `${phase} review run id`);
  assertSafeIdentifier(document?.nonce, `${phase} review nonce`);
  const contextDigest = canonicalDigest({
    schemaVersion: 1,
    runId: document.runId,
    phase,
    nonce: document.nonce,
    revision: document.revision,
    sourceEvidence: document.sourceEvidence,
    codexReviewPolicy: document.codexReviewPolicy,
    checksSha256: document.checksSha256,
  });
  return `host-${phase}-${contextDigest}`;
}

export function jsonDigest(value) {
  return digest(JSON.stringify(value));
}

export function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest`);
  }
}

export function assertJobId(value, label) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    fail(`${label} must be a UUID`);
  }
}

export function assertIsoDate(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    fail(`${label} must be an ISO-compatible timestamp`);
  }
}

export function assertModel(value, label) {
  if (
    value !== null &&
    (typeof value !== "string" || !SAFE_MODEL.test(value))
  ) {
    fail(`${label} is invalid`);
  }
}

export function assertReview(review, provider, revisionSeal, label) {
  if (typeof review !== "object" || review === null || Array.isArray(review)) {
    fail(`${label} is missing`);
  }
  if (review.provider !== provider || review.status !== "complete") {
    fail(`${label} must be a completed ${provider} review`);
  }
  if (review.revisionSeal !== revisionSeal) {
    fail(`${label} does not match the frozen revision`);
  }
  if (!new Set(["approved", "changes-requested"]).has(review.verdict)) {
    fail(`${label} verdict is invalid`);
  }
  if (
    typeof review.summary !== "string" ||
    review.summary.trim() === "" ||
    review.summary.length > 8000
  ) {
    fail(`${label} summary must be bounded and non-empty`);
  }
  if (!Array.isArray(review.findings) || review.findings.length > 100) {
    fail(`${label} findings must be a bounded array`);
  }
  for (const finding of review.findings) {
    if (
      typeof finding !== "object" ||
      finding === null ||
      !new Set(["critical", "high", "medium", "low"]).has(finding.severity) ||
      typeof finding.summary !== "string" ||
      finding.summary.trim() === "" ||
      finding.summary.length > 4000
    ) {
      fail(`${label} contains an invalid finding`);
    }
  }
  assertIsoDate(review.startedAt, `${label}.startedAt`);
  assertIsoDate(review.completedAt, `${label}.completedAt`);
  if (Date.parse(review.completedAt) < Date.parse(review.startedAt)) {
    fail(`${label} completion precedes its start`);
  }
}

export function requireSchema(document, runId, kind) {
  if (
    document?.schemaVersion !== 1 ||
    document.runId !== runId ||
    document.kind !== kind
  ) {
    fail(`${kind} evidence does not belong to this workflow run`);
  }
}

export function printSuccess(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function workingTreeDigest(projectRoot) {
  const diff = runGit(projectRoot, [
    "diff",
    "--binary",
    "--full-index",
    "HEAD",
    "--",
  ]);
  const untrackedOutput = runGit(projectRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const untracked = untrackedOutput
    .split("\0")
    .filter(Boolean)
    .filter((path) => !path.startsWith(".specify/workflows/runs/"))
    .sort();
  const hash = createHash("sha256").update(diff);
  for (const relativePath of untracked) {
    if (
      relativePath.startsWith("/") ||
      relativePath
        .split("/")
        .some((part) => part === "" || part === "." || part === "..")
    ) {
      fail("Git reported an unsafe untracked path");
    }
    const path = resolve(projectRoot, ...relativePath.split("/"));
    assertInside(projectRoot, path, "untracked path");
    assertRegularFile(
      path,
      `untracked file ${relativePath}`,
      MAX_ARTIFACT_BYTES,
    );
    hash.update(relativePath).update("\0").update(readFileSync(path));
  }
  return hash.digest("hex");
}

function canonicalJson(value) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("canonical JSON does not support non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  fail(`canonical JSON does not support ${typeof value}`);
}

function assertNoSymlinkSegments(root, relativePath, label) {
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = resolve(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      fail(`${label} is missing`);
    }
    if (stat.isSymbolicLink()) {
      fail(`${label} must not traverse a symbolic link`);
    }
  }
}

export function safeRepositoryPath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value.startsWith("/") ||
    value.includes("\0") ||
    value.includes("\\") ||
    /^[A-Za-z]:/u.test(value) ||
    value
      .split("/")
      .some(
        (part) =>
          part === "" ||
          part === "." ||
          part === ".." ||
          part.toLowerCase() === ".git",
      )
  ) {
    fail(`${label} must be a safe repository-relative path`);
  }
  return value;
}

function normalizedRevision(value, label) {
  if (typeof value !== "string" || !FULL_REVISION.test(value.toLowerCase())) {
    fail(`${label} must be a full Git object id`);
  }
  return value.toLowerCase();
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function runGit(cwd, args) {
  const result = spawnGit(cwd, args);
  if (result.error || result.status !== 0) {
    failChild(`Git command failed while sealing workflow evidence`, result);
  }
  return result.stdout;
}

function runGitBuffer(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    failChild(`Git command failed while sealing workflow evidence`, result);
  }
  return result.stdout;
}

function spawnGit(cwd, args) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    shell: false,
  });
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
