import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { WorkerConfig } from "../config/worker-config.js";
import { ERROR_CODES, WorkerError } from "../core/errors.js";
import type { ResolvedJobRequest } from "../core/types.js";
import { isPathInside } from "../security/path-policy.js";
import {
  ReviewValidationError,
  createFileSystemArtifactReader,
  evaluateRevisionSealFreshness,
  validateRevisionSeal,
  type ReviewWorkspaceSnapshot,
  type RevisionSeal,
} from "../sdd/review/index.js";
import type { GitClient } from "./git-client.js";
import { compareGitRevisions } from "./review-comparison.js";

const FULL_REVISION = /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/;
export const REVIEW_CLEANUP_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 3,
  retryDelay: 100,
} as const;

/**
 * A prepared strict review always executes from a revision-pinned, detached
 * clone.
 * Draft reviews intentionally remain source-based and are rejected by this
 * class rather than being given a misleading isolation guarantee.
 */
export interface PreparedReviewWorkspace {
  readonly request: ResolvedJobRequest;
  cleanup(): Promise<void>;
}

/** Creates disposable read-only execution roots for strict SDD review jobs. */
export class ReviewWorkspace {
  readonly #git: GitClient;
  readonly #reviewsDirectory: string;

  public constructor(config: WorkerConfig, git: GitClient) {
    this.#git = git;
    this.#reviewsDirectory = resolve(config.stateDirectory, "reviews");
  }

  public async initialize(): Promise<void> {
    await mkdir(this.#reviewsDirectory, { recursive: true, mode: 0o700 });
  }

  public async prepare(
    request: ResolvedJobRequest,
  ): Promise<PreparedReviewWorkspace> {
    const seal = this.#strictSeal(request);
    const expectedRevision = request.expectedRevision?.toLowerCase();
    if (expectedRevision === undefined) {
      throw new WorkerError(
        ERROR_CODES.INVALID_REQUEST,
        "Strict SDD reviews require expectedRevision",
      );
    }

    await this.#assertNoSubmodules(request.repositoryRoot);
    await this.#assertSourceCurrent(
      request.repositoryRoot,
      expectedRevision,
      seal,
    );

    const temporaryDirectory = await mkdtemp(
      join(this.#reviewsDirectory, "strict-review-"),
    );
    const stageRoot = resolve(temporaryDirectory, "repository");

    try {
      await this.#git.run(this.#reviewsDirectory, [
        "clone",
        "--no-local",
        "--no-checkout",
        "--no-tags",
        "--quiet",
        "--",
        request.repositoryRoot,
        stageRoot,
      ]);
      const disabledHooksPath =
        process.platform === "win32" ? "NUL" : "/dev/null";
      await this.#git.run(stageRoot, [
        "-c",
        `core.hooksPath=${disabledHooksPath}`,
        "checkout",
        "--detach",
        "--quiet",
        expectedRevision,
      ]);
      await this.#git.run(stageRoot, ["remote", "remove", "origin"]);
      await this.#git.run(stageRoot, [
        "config",
        "--local",
        "core.hooksPath",
        disabledHooksPath,
      ]);

      await this.#assertNoSubmodules(stageRoot);
      await this.#assertCloneMatchesSeal(stageRoot, expectedRevision, seal);

      // Clone creation is not an atomic operation. Recheck the source after the
      // isolated checkout so a concurrent commit or worktree edit fails closed.
      await this.#assertNoSubmodules(request.repositoryRoot);
      await this.#assertSourceCurrent(
        request.repositoryRoot,
        expectedRevision,
        seal,
      );

      const stagedRequest: ResolvedJobRequest = {
        ...request,
        executionRoot: stageRoot,
      };
      let cleanupPromise: Promise<void> | undefined;

      return {
        request: stagedRequest,
        cleanup: () => {
          cleanupPromise ??= this.#removeTemporaryDirectory(temporaryDirectory);
          return cleanupPromise;
        },
      };
    } catch (error) {
      await this.#removeTemporaryDirectory(temporaryDirectory);
      throw error;
    }
  }

  #strictSeal(request: ResolvedJobRequest): RevisionSeal {
    if (request.mode !== "analyze" || request.sddReview === undefined) {
      throw new WorkerError(
        ERROR_CODES.INVALID_REQUEST,
        "Only analyze jobs with prepared SDD review evidence can use a review workspace",
      );
    }
    if (
      resolve(request.sddReview.repositoryRoot) !==
      resolve(request.repositoryRoot)
    ) {
      throw new WorkerError(
        ERROR_CODES.INVALID_REQUEST,
        "The prepared SDD review belongs to a different repository",
      );
    }

    let seal: RevisionSeal;
    try {
      seal = validateRevisionSeal(request.sddReview.seal);
    } catch (error) {
      throw mapReviewError(error);
    }
    if (seal.mode !== "strict") {
      throw new WorkerError(
        ERROR_CODES.INVALID_REQUEST,
        "Draft SDD reviews remain source-based and cannot create an isolated strict review workspace",
      );
    }

    const expectedRevision = request.expectedRevision;
    if (
      expectedRevision === undefined ||
      !FULL_REVISION.test(expectedRevision)
    ) {
      throw new WorkerError(
        ERROR_CODES.INVALID_REQUEST,
        "Strict SDD reviews require expectedRevision as a full Git object ID",
      );
    }
    if (
      seal.revision === null ||
      seal.revision !== expectedRevision.toLowerCase()
    ) {
      throw new WorkerError(
        ERROR_CODES.REVISION_MISMATCH,
        "The strict review revision seal does not match expectedRevision",
      );
    }
    return seal;
  }

  async #assertSourceCurrent(
    repositoryRoot: string,
    expectedRevision: string,
    seal: RevisionSeal,
  ): Promise<void> {
    const snapshot = await this.#snapshot(repositoryRoot);
    if (snapshot.revision !== expectedRevision) {
      throw new WorkerError(
        ERROR_CODES.REVISION_MISMATCH,
        "The repository HEAD no longer matches the strict review revision",
      );
    }
    if (!snapshot.clean) {
      throw new WorkerError(
        ERROR_CODES.WORKTREE_DIRTY,
        "Strict SDD review isolation requires a clean source working tree",
      );
    }
    await this.#assertSealCurrent(repositoryRoot, snapshot, seal, "source");
  }

  async #assertCloneMatchesSeal(
    stageRoot: string,
    expectedRevision: string,
    seal: RevisionSeal,
  ): Promise<void> {
    const snapshot = await this.#snapshot(stageRoot);
    if (snapshot.revision !== expectedRevision) {
      throw new WorkerError(
        ERROR_CODES.REVISION_MISMATCH,
        "The isolated review checkout does not match expectedRevision",
      );
    }
    if (!snapshot.clean) {
      throw new WorkerError(
        ERROR_CODES.REVIEW_INVALID,
        "The isolated review checkout is not clean",
      );
    }
    await this.#assertSealCurrent(stageRoot, snapshot, seal, "clone");
  }

  async #assertSealCurrent(
    root: string,
    snapshot: ReviewWorkspaceSnapshot,
    seal: RevisionSeal,
    location: "source" | "clone",
  ): Promise<void> {
    try {
      const readArtifact = await createFileSystemArtifactReader(root);
      const freshness = await evaluateRevisionSealFreshness(seal, {
        snapshotWorkspace: async () => snapshot,
        readArtifact,
        compareRevision: async (baseRevision, currentRevision) =>
          await compareGitRevisions(
            this.#git,
            root,
            baseRevision,
            currentRevision,
          ),
      });
      if (!freshness.current) {
        throw new WorkerError(
          ERROR_CODES.REVIEW_INVALID,
          `The strict review ${location} does not match the sealed artifacts`,
        );
      }
    } catch (error) {
      throw mapReviewError(error);
    }
  }

  async #snapshot(directory: string): Promise<ReviewWorkspaceSnapshot> {
    const statusArgs = [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ] as const;
    const before = await this.#git.run(directory, statusArgs);
    const revision = await this.#git.run(directory, [
      "rev-parse",
      "--verify",
      "HEAD",
    ]);
    const after = await this.#git.run(directory, statusArgs);
    if (before.stdout !== after.stdout) {
      throw new WorkerError(
        ERROR_CODES.REVIEW_INVALID,
        "The review workspace changed while it was being verified",
      );
    }
    const normalizedRevision = revision.stdout.trim().toLowerCase();
    if (!FULL_REVISION.test(normalizedRevision)) {
      throw new WorkerError(
        ERROR_CODES.REVIEW_INVALID,
        "Git did not return a full revision for the review workspace",
      );
    }
    return {
      revision: normalizedRevision,
      clean: after.stdout === "",
      fingerprint: createHash("sha256")
        .update(
          JSON.stringify({
            revision: normalizedRevision,
            status: after.stdout,
          }),
        )
        .digest("hex"),
    };
  }

  async #assertNoSubmodules(repositoryRoot: string): Promise<void> {
    try {
      await lstat(resolve(repositoryRoot, ".gitmodules"));
      throw new WorkerError(
        ERROR_CODES.SUBMODULES_UNSUPPORTED,
        "Strict SDD review isolation does not support repositories with submodules",
      );
    } catch (error) {
      if (
        error instanceof WorkerError ||
        !(
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        )
      ) {
        throw error;
      }
    }
  }

  async #removeTemporaryDirectory(temporaryDirectory: string): Promise<void> {
    if (
      temporaryDirectory === this.#reviewsDirectory ||
      !isPathInside(this.#reviewsDirectory, temporaryDirectory)
    ) {
      throw new WorkerError(
        ERROR_CODES.INTERNAL_ERROR,
        "Refused to clean a path outside the review workspace directory",
      );
    }
    await rm(temporaryDirectory, REVIEW_CLEANUP_OPTIONS);
  }
}

function mapReviewError(error: unknown): WorkerError {
  if (error instanceof WorkerError) {
    return error;
  }
  if (error instanceof ReviewValidationError) {
    return new WorkerError(ERROR_CODES.REVIEW_INVALID, error.message);
  }
  return new WorkerError(
    ERROR_CODES.REVIEW_INVALID,
    "A sealed review artifact could not be verified",
  );
}
