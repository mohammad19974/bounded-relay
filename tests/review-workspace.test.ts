import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { WorkerConfig } from "../src/config/worker-config.js";
import { ERROR_CODES } from "../src/core/errors.js";
import type { ResolvedJobRequest } from "../src/core/types.js";
import { GitClient, type GitResult } from "../src/runtime/git-client.js";
import { ReviewWorkspace } from "../src/runtime/review-workspace.js";
import {
  SddReviewService,
  type PreparedSddReview,
} from "../src/sdd/review-job.js";
import {
  createTestRepository,
  makeConfig,
  makeRequest,
  makeStateDirectory,
  runGit,
} from "./helpers.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
});

interface Harness {
  readonly config: WorkerConfig;
  readonly repository: Awaited<ReturnType<typeof createTestRepository>>;
  readonly request: ResolvedJobRequest;
  readonly stateDirectory: string;
  readonly workspace: ReviewWorkspace;
}

async function makeHarness(
  gitFactory: (config: WorkerConfig, sourceRoot: string) => GitClient = (
    config,
  ) => new GitClient(config),
): Promise<Harness> {
  const repository = await createTestRepository();
  cleanupPaths.push(repository.root);
  const stateDirectory = await makeStateDirectory();
  cleanupPaths.push(stateDirectory);
  const config = makeConfig({
    allowedRoots: [repository.root],
    stateDirectory,
  });
  const git = gitFactory(config, repository.root);
  const review = await prepareReview(config, git, repository.root, "strict");
  const request = makeRequest(repository.root, {
    expectedRevision: repository.revision,
    sddReview: review,
  });
  const workspace = new ReviewWorkspace(config, git);
  await workspace.initialize();
  return { config, repository, request, stateDirectory, workspace };
}

async function prepareReview(
  config: WorkerConfig,
  git: GitClient,
  repositoryRoot: string,
  mode: "strict" | "draft",
): Promise<PreparedSddReview> {
  const revision = (await runGit(repositoryRoot, ["rev-parse", "HEAD"]))
    .trim()
    .toLowerCase();
  return await new SddReviewService(config, git).prepare(
    {
      phase: "plan",
      mode,
      artifactPaths: ["README.md", "src/allowed.ts"],
      ...(mode === "strict" ? { expectedRevision: revision } : {}),
      hostReview: {
        reviewId: `${mode}-host-review`,
        verdict: "approved",
        summary: `The host approved the ${mode} review artifacts.`,
        findings: [],
      },
    },
    repositoryRoot,
  );
}

describe("ReviewWorkspace", () => {
  test("creates a detached revision-pinned clone with no origin or active hooks", async () => {
    const { repository, request, workspace } = await makeHarness();
    const prepared = await workspace.prepare(request);

    expect(prepared.request.executionRoot).not.toBe(repository.root);
    expect(
      (await runGit(prepared.request.executionRoot, ["rev-parse", "HEAD"]))
        .trim()
        .toLowerCase(),
    ).toBe(repository.revision);
    expect(
      (
        await runGit(prepared.request.executionRoot, [
          "rev-parse",
          "--abbrev-ref",
          "HEAD",
        ])
      ).trim(),
    ).toBe("HEAD");
    expect(
      (await runGit(prepared.request.executionRoot, ["remote"])).trim(),
    ).toBe("");
    expect(
      (
        await runGit(prepared.request.executionRoot, [
          "config",
          "--local",
          "--get",
          "core.hooksPath",
        ])
      ).trim(),
    ).toBe(process.platform === "win32" ? "NUL" : "/dev/null");
    expect(
      await runGit(prepared.request.executionRoot, ["status", "--porcelain"]),
    ).toBe("");
    expect(await runGit(repository.root, ["status", "--porcelain"])).toBe("");

    const executionRoot = prepared.request.executionRoot;
    await prepared.cleanup();
    await prepared.cleanup();
    await expect(
      writeFile(join(executionRoot, "after-cleanup"), "x"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects non-review, draft, missing, partial, and mismatched revisions", async () => {
    const { config, repository, request, workspace } = await makeHarness();
    await expect(
      workspace.prepare(makeRequest(repository.root)),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_REQUEST });

    const draft = await prepareReview(
      config,
      new GitClient(config),
      repository.root,
      "draft",
    );
    await expect(
      workspace.prepare(
        makeRequest(repository.root, {
          sddReview: draft,
        }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_REQUEST });
    const missingRevision = { ...request };
    Reflect.deleteProperty(missingRevision, "expectedRevision");
    await expect(workspace.prepare(missingRevision)).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_REQUEST,
    });
    await expect(
      workspace.prepare({ ...request, expectedRevision: "abc123" }),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_REQUEST });
    await expect(
      workspace.prepare({ ...request, expectedRevision: "b".repeat(40) }),
    ).rejects.toMatchObject({ code: ERROR_CODES.REVISION_MISMATCH });
  });

  test("rejects dirty, revision-drifted, and submodule source repositories", async () => {
    const dirtyHarness = await makeHarness();
    await writeFile(
      join(dirtyHarness.repository.root, "README.md"),
      "dirty source\n",
      "utf8",
    );
    await expect(
      dirtyHarness.workspace.prepare(dirtyHarness.request),
    ).rejects.toMatchObject({ code: ERROR_CODES.WORKTREE_DIRTY });

    const revisionHarness = await makeHarness();
    await writeFile(
      join(revisionHarness.repository.root, "README.md"),
      "new revision\n",
      "utf8",
    );
    await runGit(revisionHarness.repository.root, ["add", "README.md"]);
    await runGit(revisionHarness.repository.root, [
      "commit",
      "--quiet",
      "-m",
      "move head",
    ]);
    await expect(
      revisionHarness.workspace.prepare(revisionHarness.request),
    ).rejects.toMatchObject({ code: ERROR_CODES.REVISION_MISMATCH });

    const submoduleHarness = await makeHarness();
    await writeFile(
      join(submoduleHarness.repository.root, ".gitmodules"),
      '[submodule "unsafe"]\n',
      "utf8",
    );
    await expect(
      submoduleHarness.workspace.prepare(submoduleHarness.request),
    ).rejects.toMatchObject({ code: ERROR_CODES.SUBMODULES_UNSUPPORTED });
  });

  test("rejects sealed source artifact drift even when Git status hides the file", async () => {
    const { repository, request, workspace } = await makeHarness();
    await writeFile(
      join(repository.root, "README.md"),
      "hidden drift\n",
      "utf8",
    );
    await runGit(repository.root, [
      "update-index",
      "--assume-unchanged",
      "README.md",
    ]);
    expect(await runGit(repository.root, ["status", "--porcelain"])).toBe("");

    await expect(workspace.prepare(request)).rejects.toMatchObject({
      code: ERROR_CODES.REVIEW_INVALID,
    });
  });

  test("rejects source drift that occurs while the clone is being prepared", async () => {
    const { request, workspace } = await makeHarness(
      (config, sourceRoot) => new SourceDriftAfterCloneGit(config, sourceRoot),
    );
    await expect(workspace.prepare(request)).rejects.toMatchObject({
      code: ERROR_CODES.WORKTREE_DIRTY,
    });
  });

  test("rejects a clone whose artifact bytes do not match the revision seal", async () => {
    const { request, stateDirectory, workspace } = await makeHarness(
      (config, sourceRoot) => new CloneArtifactDriftGit(config, sourceRoot),
    );
    await expect(workspace.prepare(request)).rejects.toMatchObject({
      code: ERROR_CODES.REVIEW_INVALID,
    });
    expect(await readdir(join(stateDirectory, "reviews"))).toEqual([]);
  });
});

class SourceDriftAfterCloneGit extends GitClient {
  readonly #sourceRoot: string;
  #drifted = false;

  public constructor(config: WorkerConfig, sourceRoot: string) {
    super(config);
    this.#sourceRoot = sourceRoot;
  }

  public override async run(
    cwd: string,
    args: readonly string[],
    acceptedExitCodes?: readonly number[],
  ): Promise<GitResult> {
    const result = await super.run(cwd, args, acceptedExitCodes);
    if (!this.#drifted && args[0] === "clone") {
      this.#drifted = true;
      await writeFile(
        join(this.#sourceRoot, "README.md"),
        "concurrent drift\n",
      );
    }
    return result;
  }
}

class CloneArtifactDriftGit extends GitClient {
  readonly #sourceRoot: string;
  #cloneStatusCount = 0;

  public constructor(config: WorkerConfig, sourceRoot: string) {
    super(config);
    this.#sourceRoot = sourceRoot;
  }

  public override async run(
    cwd: string,
    args: readonly string[],
    acceptedExitCodes?: readonly number[],
  ): Promise<GitResult> {
    const result = await super.run(cwd, args, acceptedExitCodes);
    if (cwd !== this.#sourceRoot && args[0] === "status") {
      this.#cloneStatusCount += 1;
      if (this.#cloneStatusCount === 2) {
        await writeFile(join(cwd, "README.md"), "clone artifact drift\n");
      }
    }
    return result;
  }
}
