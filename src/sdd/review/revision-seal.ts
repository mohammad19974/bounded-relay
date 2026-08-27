import { lstat, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import {
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACTS,
  MAX_TOTAL_ARTIFACT_BYTES,
  MAX_REVIEW_SCOPE_PATHS,
  ReviewValidationError,
  assertOnlyKeys,
  expectLiteral,
  expectRecord,
  fullRevision,
  safeArtifactPath,
  sha256Bytes,
  sha256Digest,
  sha256Text,
} from "./validation.js";

export type ReviewMode = "strict" | "draft";

export interface ReviewWorkspaceSnapshot {
  readonly revision: string | null;
  readonly clean: boolean;
  readonly fingerprint: string;
}

export interface ArtifactReadResult {
  readonly content: Uint8Array;
  readonly type: "file" | "directory" | "other";
  readonly symbolicLink: boolean;
}

export type ArtifactReader = (path: string) => Promise<ArtifactReadResult>;

export interface RevisionSealDependencies {
  readonly snapshotWorkspace: () => Promise<ReviewWorkspaceSnapshot>;
  readonly readArtifact: ArtifactReader;
  readonly compareRevision?: (
    baseRevision: string,
    currentRevision: string,
  ) => Promise<RevisionComparison>;
}

export interface RevisionComparison {
  readonly baseRevision: string;
  readonly changedPaths: readonly string[];
  readonly diffSha256: string;
}

export interface SealedArtifact {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface RevisionSeal {
  readonly schemaVersion: 1;
  readonly mode: ReviewMode;
  readonly revision: string | null;
  readonly clean: boolean;
  readonly workspaceFingerprint: string;
  readonly artifacts: readonly SealedArtifact[];
  readonly comparison: RevisionComparison | null;
  readonly sealId: string;
}

export interface RevisionSealFreshness {
  readonly current: boolean;
  readonly reasons: readonly string[];
}

const SEAL_KEYS = new Set([
  "schemaVersion",
  "mode",
  "revision",
  "clean",
  "workspaceFingerprint",
  "artifacts",
  "comparison",
  "sealId",
]);
const ARTIFACT_KEYS = new Set(["path", "bytes", "sha256"]);
const COMPARISON_KEYS = new Set(["baseRevision", "changedPaths", "diffSha256"]);

export async function createRevisionSeal(
  input: {
    readonly mode: ReviewMode;
    readonly artifactPaths: readonly string[];
    readonly baseRevision?: string;
  },
  dependencies: RevisionSealDependencies,
): Promise<RevisionSeal> {
  const mode = reviewMode(input.mode);
  const paths = validateArtifactPaths(input.artifactPaths);
  const workspace = normalizeWorkspaceSnapshot(
    await dependencies.snapshotWorkspace(),
    mode === "strict",
  );
  const artifacts: SealedArtifact[] = [];
  let totalBytes = 0;

  for (const path of paths) {
    const artifact = digestArtifact(
      path,
      await dependencies.readArtifact(path),
    );
    totalBytes += artifact.bytes;
    if (totalBytes > MAX_TOTAL_ARTIFACT_BYTES) {
      throw new ReviewValidationError(
        "REVIEW_ARTIFACT_TOTAL_LIMIT",
        `Reviewed artifacts exceed the ${MAX_TOTAL_ARTIFACT_BYTES}-byte total limit`,
      );
    }
    artifacts.push(artifact);
  }

  const comparison = await createComparison(
    input.baseRevision,
    workspace.revision,
    dependencies,
  );

  const payload = {
    schemaVersion: 1 as const,
    mode,
    revision: workspace.revision,
    clean: workspace.clean,
    workspaceFingerprint: workspace.fingerprint,
    artifacts,
    comparison,
  };
  return {
    ...payload,
    sealId: computeSealId(payload),
  };
}

export function validateRevisionSeal(value: unknown): RevisionSeal {
  const record = expectRecord(value, "revision seal");
  assertOnlyKeys(record, SEAL_KEYS, "revision seal");
  expectLiteral(record.schemaVersion, 1, "revision seal schemaVersion");
  const mode = reviewMode(record.mode);
  const revision = fullRevision(
    record.revision,
    "revision seal revision",
    mode === "strict",
  );
  if (typeof record.clean !== "boolean") {
    throw new ReviewValidationError(
      "INVALID_REVIEW_WORKSPACE",
      "revision seal clean must be a boolean",
    );
  }
  if (mode === "strict" && !record.clean) {
    throw new ReviewValidationError(
      "STRICT_REVIEW_REQUIRES_CLEAN_WORKSPACE",
      "strict review requires a clean workspace",
    );
  }
  const workspaceFingerprint = sha256Digest(
    record.workspaceFingerprint,
    "revision seal workspaceFingerprint",
  );
  if (
    !Array.isArray(record.artifacts) ||
    record.artifacts.length === 0 ||
    record.artifacts.length > MAX_ARTIFACTS
  ) {
    throw new ReviewValidationError(
      "INVALID_REVIEW_ARTIFACTS",
      `revision seal artifacts must contain 1-${MAX_ARTIFACTS} items`,
    );
  }

  const artifacts: SealedArtifact[] = [];
  let totalBytes = 0;
  for (const [index, valueArtifact] of record.artifacts.entries()) {
    const artifactRecord = expectRecord(
      valueArtifact,
      `revision seal artifact ${index}`,
    );
    assertOnlyKeys(
      artifactRecord,
      ARTIFACT_KEYS,
      `revision seal artifact ${index}`,
    );
    const path = safeArtifactPath(
      artifactRecord.path,
      `revision seal artifact ${index} path`,
    );
    const bytes = artifactRecord.bytes;
    if (
      typeof bytes !== "number" ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > MAX_ARTIFACT_BYTES
    ) {
      throw new ReviewValidationError(
        "INVALID_REVIEW_ARTIFACT_SIZE",
        `revision seal artifact ${index} has an invalid byte count`,
      );
    }
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_ARTIFACT_BYTES) {
      throw new ReviewValidationError(
        "REVIEW_ARTIFACT_TOTAL_LIMIT",
        `Reviewed artifacts exceed the ${MAX_TOTAL_ARTIFACT_BYTES}-byte total limit`,
      );
    }
    artifacts.push({
      path,
      bytes,
      sha256: sha256Digest(
        artifactRecord.sha256,
        `revision seal artifact ${index} sha256`,
      ),
    });
  }
  const paths = artifacts.map((artifact) => artifact.path);
  if (new Set(paths).size !== paths.length) {
    throw new ReviewValidationError(
      "DUPLICATE_REVIEW_ARTIFACT",
      "revision seal contains duplicate artifact paths",
    );
  }
  const sortedPaths = [...paths].sort(compareCodeUnits);
  if (paths.some((path, index) => path !== sortedPaths[index])) {
    throw new ReviewValidationError(
      "NON_CANONICAL_REVIEW_ARTIFACTS",
      "revision seal artifact paths must use canonical sorted order",
    );
  }
  const comparison = validateComparison(record.comparison);

  const payload = {
    schemaVersion: 1 as const,
    mode,
    revision,
    clean: record.clean,
    workspaceFingerprint,
    artifacts,
    comparison,
  };
  const sealId = sha256Digest(record.sealId, "revision seal sealId");
  if (computeSealId(payload) !== sealId) {
    throw new ReviewValidationError(
      "REVISION_SEAL_DIGEST_MISMATCH",
      "revision seal content does not match its sealId",
    );
  }
  return { ...payload, sealId };
}

export async function evaluateRevisionSealFreshness(
  sealValue: unknown,
  dependencies: RevisionSealDependencies,
): Promise<RevisionSealFreshness> {
  const seal = validateRevisionSeal(sealValue);
  const reasons: string[] = [];
  let workspace: ReviewWorkspaceSnapshot;
  try {
    workspace = normalizeWorkspaceSnapshot(
      await dependencies.snapshotWorkspace(),
      false,
    );
  } catch {
    return { current: false, reasons: ["workspace-snapshot-invalid"] };
  }

  if (workspace.revision !== seal.revision) {
    reasons.push("revision-changed");
  }
  if (workspace.clean !== seal.clean) {
    reasons.push("clean-state-changed");
  }
  if (workspace.fingerprint !== seal.workspaceFingerprint) {
    reasons.push("workspace-fingerprint-changed");
  }
  if (seal.mode === "strict" && !workspace.clean) {
    reasons.push("strict-workspace-dirty");
  }

  for (const expected of seal.artifacts) {
    try {
      const current = digestArtifact(
        expected.path,
        await dependencies.readArtifact(expected.path),
      );
      if (
        current.bytes !== expected.bytes ||
        current.sha256 !== expected.sha256
      ) {
        reasons.push(`artifact-changed:${expected.path}`);
      }
    } catch {
      reasons.push(`artifact-unavailable:${expected.path}`);
    }
  }

  if (seal.comparison !== null) {
    if (seal.revision === null || dependencies.compareRevision === undefined) {
      reasons.push("comparison-unavailable");
    } else {
      try {
        const currentComparison = validateComparison(
          await dependencies.compareRevision(
            seal.comparison.baseRevision,
            seal.revision,
          ),
        );
        if (
          JSON.stringify(currentComparison) !== JSON.stringify(seal.comparison)
        ) {
          reasons.push("comparison-changed");
        }
      } catch {
        reasons.push("comparison-unavailable");
      }
    }
  }

  const uniqueReasons = [...new Set(reasons)];
  return { current: uniqueReasons.length === 0, reasons: uniqueReasons };
}

export async function createFileSystemArtifactReader(
  repositoryRoot: string,
): Promise<ArtifactReader> {
  const requestedRoot = resolve(repositoryRoot);
  const rootStat = await lstat(requestedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new ReviewValidationError(
      "INVALID_REVIEW_ROOT",
      "review repository root must be a non-symlink directory",
    );
  }
  const canonicalRoot = await realpath(requestedRoot);

  return async (path): Promise<ArtifactReadResult> => {
    const safePath = safeArtifactPath(path, "review artifact path");
    let candidate = canonicalRoot;
    const parts = safePath.split("/");

    for (const [index, part] of parts.entries()) {
      candidate = resolve(candidate, part);
      assertInside(canonicalRoot, candidate);
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink()) {
        throw new ReviewValidationError(
          "SYMLINK_REVIEW_ARTIFACT",
          `review artifact ${safePath} crosses a symbolic link`,
        );
      }
      if (index < parts.length - 1 && !stat.isDirectory()) {
        throw new ReviewValidationError(
          "INVALID_REVIEW_ARTIFACT",
          `review artifact ${safePath} has a non-directory parent`,
        );
      }
      if (index === parts.length - 1) {
        if (!stat.isFile()) {
          throw new ReviewValidationError(
            "NON_REGULAR_REVIEW_ARTIFACT",
            `review artifact ${safePath} must be a regular file`,
          );
        }
        if (stat.size > MAX_ARTIFACT_BYTES) {
          throw new ReviewValidationError(
            "REVIEW_ARTIFACT_LIMIT",
            `review artifact ${safePath} exceeds the ${MAX_ARTIFACT_BYTES}-byte limit`,
          );
        }
      }
    }

    const canonicalCandidate = await realpath(candidate);
    assertInside(canonicalRoot, canonicalCandidate);
    const content = await readFile(canonicalCandidate);
    if (content.byteLength > MAX_ARTIFACT_BYTES) {
      throw new ReviewValidationError(
        "REVIEW_ARTIFACT_LIMIT",
        `review artifact ${safePath} exceeds the ${MAX_ARTIFACT_BYTES}-byte limit`,
      );
    }
    return { content, type: "file", symbolicLink: false };
  };
}

function reviewMode(value: unknown): ReviewMode {
  if (value !== "strict" && value !== "draft") {
    throw new ReviewValidationError(
      "INVALID_REVIEW_MODE",
      "review mode must be strict or draft",
    );
  }
  return value;
}

async function createComparison(
  baseRevisionValue: unknown,
  currentRevision: string | null,
  dependencies: RevisionSealDependencies,
): Promise<RevisionComparison | null> {
  if (baseRevisionValue === undefined) {
    return null;
  }
  const baseRevision = fullRevision(
    baseRevisionValue,
    "review comparison baseRevision",
    true,
  );
  if (
    baseRevision === null ||
    currentRevision === null ||
    dependencies.compareRevision === undefined
  ) {
    throw new ReviewValidationError(
      "REVIEW_COMPARISON_UNAVAILABLE",
      "review comparison requires two committed revisions and a Git comparator",
    );
  }
  return validateComparison(
    await dependencies.compareRevision(baseRevision, currentRevision),
  );
}

function validateComparison(value: unknown): RevisionComparison | null {
  if (value === null) {
    return null;
  }
  const record = expectRecord(value, "review comparison");
  assertOnlyKeys(record, COMPARISON_KEYS, "review comparison");
  const baseRevision = fullRevision(
    record.baseRevision,
    "review comparison baseRevision",
    true,
  );
  if (baseRevision === null) {
    throw new ReviewValidationError(
      "INVALID_REVIEW_COMPARISON",
      "review comparison baseRevision is required",
    );
  }
  if (
    !Array.isArray(record.changedPaths) ||
    record.changedPaths.length > MAX_REVIEW_SCOPE_PATHS
  ) {
    throw new ReviewValidationError(
      "INVALID_REVIEW_COMPARISON",
      `review comparison changedPaths must contain at most ${MAX_REVIEW_SCOPE_PATHS} items`,
    );
  }
  const changedPaths = record.changedPaths.map((path, index) =>
    safeArtifactPath(path, `review comparison changedPaths[${index}]`),
  );
  const sortedPaths = [...changedPaths].sort(compareCodeUnits);
  if (
    new Set(changedPaths).size !== changedPaths.length ||
    changedPaths.some((path, index) => path !== sortedPaths[index])
  ) {
    throw new ReviewValidationError(
      "INVALID_REVIEW_COMPARISON",
      "review comparison changedPaths must be unique and canonical",
    );
  }
  return {
    baseRevision,
    changedPaths,
    diffSha256: sha256Digest(record.diffSha256, "review comparison diffSha256"),
  };
}

function validateArtifactPaths(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_ARTIFACTS
  ) {
    throw new ReviewValidationError(
      "INVALID_REVIEW_ARTIFACTS",
      `artifactPaths must contain 1-${MAX_ARTIFACTS} paths`,
    );
  }
  const paths = value.map((path, index) =>
    safeArtifactPath(path, `artifactPaths[${index}]`),
  );
  if (new Set(paths).size !== paths.length) {
    throw new ReviewValidationError(
      "DUPLICATE_REVIEW_ARTIFACT",
      "artifactPaths contains a duplicate path",
    );
  }
  return [...paths].sort(compareCodeUnits);
}

function normalizeWorkspaceSnapshot(
  value: ReviewWorkspaceSnapshot,
  strict: boolean,
): ReviewWorkspaceSnapshot {
  const record = expectRecord(value, "review workspace snapshot");
  assertOnlyKeys(
    record,
    new Set(["revision", "clean", "fingerprint"]),
    "review workspace snapshot",
  );
  if (typeof record.clean !== "boolean") {
    throw new ReviewValidationError(
      "INVALID_REVIEW_WORKSPACE",
      "review workspace snapshot clean must be a boolean",
    );
  }
  if (strict && !record.clean) {
    throw new ReviewValidationError(
      "STRICT_REVIEW_REQUIRES_CLEAN_WORKSPACE",
      "strict review requires a clean workspace",
    );
  }
  return {
    revision: fullRevision(
      record.revision,
      "review workspace snapshot revision",
      strict,
    ),
    clean: record.clean,
    fingerprint: sha256Digest(
      record.fingerprint,
      "review workspace snapshot fingerprint",
    ),
  };
}

function digestArtifact(
  path: string,
  artifact: ArtifactReadResult,
): SealedArtifact {
  if (artifact.symbolicLink) {
    throw new ReviewValidationError(
      "SYMLINK_REVIEW_ARTIFACT",
      `review artifact ${path} must not be a symbolic link`,
    );
  }
  if (artifact.type !== "file") {
    throw new ReviewValidationError(
      "NON_REGULAR_REVIEW_ARTIFACT",
      `review artifact ${path} must be a regular file`,
    );
  }
  if (!(artifact.content instanceof Uint8Array)) {
    throw new ReviewValidationError(
      "INVALID_REVIEW_ARTIFACT",
      `review artifact ${path} did not return bytes`,
    );
  }
  if (artifact.content.byteLength > MAX_ARTIFACT_BYTES) {
    throw new ReviewValidationError(
      "REVIEW_ARTIFACT_LIMIT",
      `review artifact ${path} exceeds the ${MAX_ARTIFACT_BYTES}-byte limit`,
    );
  }
  return {
    path,
    bytes: artifact.content.byteLength,
    sha256: sha256Bytes(artifact.content),
  };
}

function computeSealId(payload: {
  readonly schemaVersion: 1;
  readonly mode: ReviewMode;
  readonly revision: string | null;
  readonly clean: boolean;
  readonly workspaceFingerprint: string;
  readonly artifacts: readonly SealedArtifact[];
  readonly comparison: RevisionComparison | null;
}): string {
  return sha256Text(JSON.stringify(payload));
}

function assertInside(parent: string, candidate: string): void {
  const pathFromParent = relative(parent, candidate);
  if (
    pathFromParent === "" ||
    (pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`) &&
      !pathFromParent.startsWith(sep))
  ) {
    return;
  }
  throw new ReviewValidationError(
    "REVIEW_ARTIFACT_ESCAPE",
    "review artifact escapes the repository root",
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
