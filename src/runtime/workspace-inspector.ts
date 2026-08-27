import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

import type { WorkerConfig } from "../config/worker-config.js";
import type { WorkspaceSummary } from "../core/types.js";
import { resolveWorkingSet } from "../security/path-policy.js";
import type { GitClient } from "./git-client.js";

export class WorkspaceInspector {
  readonly #config: WorkerConfig;
  readonly #git: GitClient;

  public constructor(config: WorkerConfig, git: GitClient) {
    this.#config = config;
    this.#git = git;
  }

  public async inspect(cwd?: string): Promise<WorkspaceSummary> {
    const workingSet = await resolveWorkingSet({
      cwd: cwd ?? this.#config.allowedRoots[0] ?? process.cwd(),
      mode: "analyze",
      allowedRoots: this.#config.allowedRoots,
    });
    const [revisionResult, statusResult, hasSubmodules] = await Promise.all([
      this.#git.run(workingSet.repositoryRoot, [
        "rev-parse",
        "--verify",
        "HEAD",
      ]),
      this.#git.run(workingSet.repositoryRoot, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]),
      pathExists(resolve(workingSet.repositoryRoot, ".gitmodules")),
    ]);
    const clean = statusResult.stdout === "";
    const proposalBlockers = [
      ...(this.#config.enableProposals
        ? []
        : ["Proposal mode is disabled at server startup"]),
      ...(clean ? [] : ["The Git working tree is not clean"]),
      ...(hasSubmodules
        ? ["Repositories with submodules are unsupported in proposal mode"]
        : []),
    ];

    return {
      cwd: workingSet.cwd,
      repositoryRoot: workingSet.repositoryRoot,
      revision: revisionResult.stdout.trim().toLowerCase(),
      clean,
      proposalReady: proposalBlockers.length === 0,
      proposalBlockers,
    };
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    );
  }
}
