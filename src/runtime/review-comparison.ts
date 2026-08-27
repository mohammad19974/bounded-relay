import { createHash } from "node:crypto";

import {
  MAX_REVIEW_SCOPE_PATHS,
  ReviewValidationError,
  type RevisionComparison,
} from "../sdd/review/index.js";
import { safeArtifactPath } from "../sdd/review/validation.js";
import type { GitClient } from "./git-client.js";

const FULL_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export async function compareGitRevisions(
  git: GitClient,
  repositoryRoot: string,
  baseRevisionValue: string,
  currentRevisionValue: string,
): Promise<RevisionComparison> {
  const baseRevision = normalizedRevision(baseRevisionValue, "base");
  const currentRevision = normalizedRevision(currentRevisionValue, "current");
  await git.run(repositoryRoot, [
    "rev-parse",
    "--verify",
    `${baseRevision}^{commit}`,
  ]);
  const ancestry = await git.run(
    repositoryRoot,
    ["merge-base", "--is-ancestor", baseRevision, currentRevision],
    [0, 1],
  );
  if (ancestry.exitCode !== 0) {
    throw new ReviewValidationError(
      "REVIEW_BASE_NOT_ANCESTOR",
      "review comparison base revision must be an ancestor of the sealed revision",
    );
  }
  const range = `${baseRevision}..${currentRevision}`;
  const names = await git.run(repositoryRoot, [
    "diff",
    "--name-only",
    "-z",
    "--no-ext-diff",
    "--no-renames",
    range,
    "--",
  ]);
  const changedPaths = names.stdout
    .split("\0")
    .filter(Boolean)
    .map((path, index) =>
      safeArtifactPath(path, `review comparison changedPaths[${index}]`),
    )
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (
    changedPaths.length > MAX_REVIEW_SCOPE_PATHS ||
    new Set(changedPaths).size !== changedPaths.length
  ) {
    throw new ReviewValidationError(
      "REVIEW_SCOPE_LIMIT",
      `review comparison exceeds ${MAX_REVIEW_SCOPE_PATHS} unique paths`,
    );
  }
  const diff = await git.run(repositoryRoot, [
    "diff",
    "--binary",
    "--full-index",
    "--no-ext-diff",
    "--no-renames",
    range,
    "--",
  ]);
  return {
    baseRevision,
    changedPaths,
    diffSha256: createHash("sha256").update(diff.stdout).digest("hex"),
  };
}

function normalizedRevision(value: string, label: string): string {
  const normalized = value.toLowerCase();
  if (!FULL_REVISION.test(normalized)) {
    throw new ReviewValidationError(
      "INVALID_REVIEW_REVISION",
      `review comparison ${label} revision must be a full Git object id`,
    );
  }
  return normalized;
}
