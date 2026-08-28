import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, posix, resolve } from "node:path";

import type { WorkerConfig } from "../config/worker-config.js";
import type { ProposalArtifact, ResolvedJobRequest } from "../core/types.js";
import { ERROR_CODES, WorkerError } from "../core/errors.js";
import {
  isPathInside,
  isProtectedProposalPath,
} from "../security/path-policy.js";
import type { GitClient } from "./git-client.js";

export interface PreparedProposal {
  readonly request: ResolvedJobRequest;
  finalize(): Promise<ProposalArtifact>;
  cleanup(): Promise<void>;
}

export class ProposalWorkspace {
  readonly #config: WorkerConfig;
  readonly #git: GitClient;
  readonly #nullDevice: "NUL" | "/dev/null";
  readonly #workspacesDirectory: string;

  public constructor(
    config: WorkerConfig,
    git: GitClient,
    platform: NodeJS.Platform = process.platform,
  ) {
    this.#config = config;
    this.#git = git;
    this.#nullDevice = platform === "win32" ? "NUL" : "/dev/null";
    this.#workspacesDirectory = resolve(config.stateDirectory, "workspaces");
  }

  public async initialize(): Promise<void> {
    await mkdir(this.#workspacesDirectory, { recursive: true, mode: 0o700 });
  }

  public async prepare(request: ResolvedJobRequest): Promise<PreparedProposal> {
    if (request.mode !== "proposal") {
      throw new WorkerError(
        ERROR_CODES.INVALID_REQUEST,
        "Only proposal jobs can create an isolated workspace",
      );
    }
    if (request.expectedRevision === undefined) {
      throw new WorkerError(
        ERROR_CODES.INVALID_REQUEST,
        "Proposal jobs require expectedRevision",
      );
    }
    if (
      !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(request.expectedRevision)
    ) {
      throw new WorkerError(
        ERROR_CODES.INVALID_REQUEST,
        "expectedRevision must be a full Git object ID",
      );
    }

    await this.#assertCleanSource(request);
    const temporaryDirectory = await mkdtemp(
      join(this.#workspacesDirectory, "proposal-"),
    );
    const stageRoot = resolve(temporaryDirectory, "repository");

    try {
      await this.#git.run(this.#workspacesDirectory, [
        "clone",
        "--no-local",
        "--no-checkout",
        "--no-tags",
        "--quiet",
        "--",
        request.repositoryRoot,
        stageRoot,
      ]);
      await this.#git.run(stageRoot, [
        "-c",
        `core.hooksPath=${this.#nullDevice}`,
        "checkout",
        "--detach",
        "--quiet",
        request.expectedRevision,
      ]);
      await this.#git.run(stageRoot, ["remote", "remove", "origin"]);
      await this.#git.run(stageRoot, [
        "config",
        "--local",
        "core.hooksPath",
        this.#nullDevice,
      ]);

      const baselineRevision = await this.#revision(stageRoot);
      if (baselineRevision !== request.expectedRevision.toLowerCase()) {
        throw new WorkerError(
          ERROR_CODES.REVISION_MISMATCH,
          "The isolated checkout does not match expectedRevision",
        );
      }
      const baselineRefs = await this.#refsDigest(stageRoot);
      const stagedRequest: ResolvedJobRequest = {
        ...request,
        executionRoot: stageRoot,
      };
      let cleaned = false;

      return {
        request: stagedRequest,
        finalize: async () =>
          await this.#finalize(stagedRequest, baselineRevision, baselineRefs),
        cleanup: async () => {
          if (cleaned) {
            return;
          }
          cleaned = true;
          if (!isPathInside(this.#workspacesDirectory, temporaryDirectory)) {
            throw new WorkerError(
              ERROR_CODES.INTERNAL_ERROR,
              "Refused to clean a path outside the worker workspace directory",
            );
          }
          await rm(temporaryDirectory, { recursive: true, force: true });
        },
      };
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  async #assertCleanSource(request: ResolvedJobRequest): Promise<void> {
    try {
      await lstat(resolve(request.repositoryRoot, ".gitmodules"));
      throw new WorkerError(
        ERROR_CODES.SUBMODULES_UNSUPPORTED,
        "Proposal mode does not support repositories with submodules in v0.1",
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

    const [revision, status] = await Promise.all([
      this.#revision(request.repositoryRoot),
      this.#git.run(request.repositoryRoot, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]),
    ]);
    if (revision !== request.expectedRevision?.toLowerCase()) {
      throw new WorkerError(
        ERROR_CODES.REVISION_MISMATCH,
        "The repository HEAD no longer matches expectedRevision",
      );
    }
    if (status.stdout !== "") {
      throw new WorkerError(
        ERROR_CODES.WORKTREE_DIRTY,
        "Proposal mode requires a clean working tree so its isolated baseline is exact",
      );
    }
  }

  async #revision(directory: string): Promise<string> {
    const result = await this.#git.run(directory, ["rev-parse", "HEAD"]);
    return result.stdout.trim().toLowerCase();
  }

  async #refsDigest(directory: string): Promise<string> {
    const result = await this.#git.run(
      directory,
      ["show-ref", "--head"],
      [0, 1],
    );
    return createHash("sha256").update(result.stdout).digest("hex");
  }

  async #finalize(
    request: ResolvedJobRequest,
    baselineRevision: string,
    baselineRefs: string,
  ): Promise<ProposalArtifact> {
    if ((await this.#revision(request.executionRoot)) !== baselineRevision) {
      throw new WorkerError(
        ERROR_CODES.RUNTIME_FAILED,
        "Codex changed Git HEAD inside the isolated workspace; the proposal was rejected",
      );
    }
    if ((await this.#refsDigest(request.executionRoot)) !== baselineRefs) {
      throw new WorkerError(
        ERROR_CODES.RUNTIME_FAILED,
        "Codex changed Git refs inside the isolated workspace; the proposal was rejected",
      );
    }

    const changedFiles = await this.#changedFiles(request.executionRoot);
    if (changedFiles.length > this.#config.maxChangedFiles) {
      throw new WorkerError(
        ERROR_CODES.PATCH_LIMIT_EXCEEDED,
        `Proposal changed ${changedFiles.length} files; the limit is ${this.#config.maxChangedFiles}`,
      );
    }

    for (const changedFile of changedFiles) {
      if (isProtectedProposalPath(changedFile)) {
        throw new WorkerError(
          ERROR_CODES.INVALID_PATH,
          `Proposal changed a protected path: ${changedFile}`,
        );
      }
      if (!isAllowedPath(request.writePaths ?? [], changedFile)) {
        throw new WorkerError(
          ERROR_CODES.INVALID_PATH,
          `Proposal changed a path outside its allowlist: ${changedFile}`,
        );
      }
      await this.#assertRegularChangedPath(request.executionRoot, changedFile);
    }

    if (changedFiles.length === 0) {
      return {
        effect: "none",
        baselineRevision,
        changedFiles: [],
        patchBytes: 0,
      };
    }

    await this.#git.run(request.executionRoot, ["add", "--all", "--", "."]);
    const patchResult = await this.#git.run(request.executionRoot, [
      "diff",
      "--cached",
      "--binary",
      "--full-index",
      "--no-renames",
      baselineRevision,
      "--",
    ]);
    const patchBytes = Buffer.byteLength(patchResult.stdout);
    if (patchBytes === 0) {
      throw new WorkerError(
        ERROR_CODES.PROTOCOL_ERROR,
        "Git reported changed files but produced an empty patch",
      );
    }
    if (patchBytes > this.#config.maxPatchBytes) {
      throw new WorkerError(
        ERROR_CODES.PATCH_LIMIT_EXCEEDED,
        `Proposal patch is ${patchBytes} bytes; the limit is ${this.#config.maxPatchBytes}`,
      );
    }

    return {
      effect: "proposal",
      baselineRevision,
      changedFiles,
      patch: patchResult.stdout,
      patchBytes,
      patchSha256: createHash("sha256")
        .update(patchResult.stdout)
        .digest("hex"),
    };
  }

  async #changedFiles(directory: string): Promise<readonly string[]> {
    const [tracked, untracked] = await Promise.all([
      this.#git.run(directory, [
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        "HEAD",
        "--",
      ]),
      this.#git.run(directory, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ]),
    ]);
    return [
      ...new Set([
        ...parseNullList(tracked.stdout),
        ...parseNullList(untracked.stdout),
      ]),
    ].sort();
  }

  async #assertRegularChangedPath(
    directory: string,
    path: string,
  ): Promise<void> {
    const baseline = await this.#git.run(
      directory,
      ["ls-tree", "-z", "HEAD", "--", path],
      [0],
    );
    if (baseline.stdout.startsWith("120000 ")) {
      throw new WorkerError(
        ERROR_CODES.INVALID_PATH,
        `Proposal may not modify a symbolic link: ${path}`,
      );
    }

    try {
      const metadata = await lstat(resolve(directory, ...path.split("/")));
      if (
        metadata.isSymbolicLink() ||
        (!metadata.isFile() && !metadata.isDirectory()) ||
        (metadata.isFile() && metadata.nlink > 1)
      ) {
        throw new WorkerError(
          ERROR_CODES.INVALID_PATH,
          `Proposal contains a non-regular path: ${path}`,
        );
      }
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
      // A missing path represents a regular-file deletion and is safe to patch.
    }
  }
}

function parseNullList(value: string): readonly string[] {
  return value.split("\0").filter(Boolean);
}

function isAllowedPath(scopes: readonly string[], candidate: string): boolean {
  return scopes.some((scope) => {
    const relativePath = posix.relative(scope, candidate);
    return (
      relativePath === "" ||
      (relativePath !== ".." && !relativePath.startsWith("../"))
    );
  });
}
