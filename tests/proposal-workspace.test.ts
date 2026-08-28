import { link, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ERROR_CODES } from "../src/core/errors.js";
import type { ProposalArtifact } from "../src/core/types.js";
import { GitClient, type GitResult } from "../src/runtime/git-client.js";
import { ProposalWorkspace } from "../src/runtime/proposal-workspace.js";
import {
  createTestRepository,
  makeConfig,
  makeRequest,
  makeStateDirectory,
  runGit,
} from "./helpers.js";

const cleanupPaths: string[] = [];

class RecordingGitClient extends GitClient {
  readonly calls: { readonly cwd: string; readonly args: readonly string[] }[] =
    [];

  public override async run(
    cwd: string,
    args: readonly string[],
    acceptedExitCodes: readonly number[] = [0],
  ): Promise<GitResult> {
    this.calls.push({ cwd, args: [...args] });
    return await super.run(cwd, args, acceptedExitCodes);
  }
}

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
});

async function makeHarness(
  options: {
    readonly maxPatchBytes?: number;
    readonly maxChangedFiles?: number;
  } = {},
): Promise<{
  readonly repository: Awaited<ReturnType<typeof createTestRepository>>;
  readonly workspace: ProposalWorkspace;
}> {
  const repository = await createTestRepository();
  cleanupPaths.push(repository.root);
  const stateDirectory = await makeStateDirectory();
  cleanupPaths.push(stateDirectory);
  const config = makeConfig({
    allowedRoots: [repository.root],
    enableProposals: true,
    stateDirectory,
    maxPatchBytes: options.maxPatchBytes ?? 2_000_000,
    maxChangedFiles: options.maxChangedFiles ?? 100,
  });
  const workspace = new ProposalWorkspace(config, new GitClient(config));
  await workspace.initialize();
  return { repository, workspace };
}

describe("ProposalWorkspace", () => {
  test("uses the Windows null device for checkout and persisted hook isolation", async () => {
    const repository = await createTestRepository();
    cleanupPaths.push(repository.root);
    const stateDirectory = await makeStateDirectory();
    cleanupPaths.push(stateDirectory);
    const config = makeConfig({
      allowedRoots: [repository.root],
      enableProposals: true,
      stateDirectory,
    });
    const git = new RecordingGitClient(config);
    const workspace = new ProposalWorkspace(config, git, "win32");
    await workspace.initialize();

    const prepared = await workspace.prepare(
      makeRequest(repository.root, {
        mode: "proposal",
        expectedRevision: repository.revision,
        writePaths: ["src"],
      }),
    );

    const checkout = git.calls.find((call) => call.args.includes("checkout"));
    expect(checkout?.args).toContain("core.hooksPath=NUL");
    expect(git.calls.map((call) => call.args)).toContainEqual([
      "config",
      "--local",
      "core.hooksPath",
      "NUL",
    ]);
    expect(
      (
        await runGit(prepared.request.executionRoot, [
          "config",
          "--local",
          "--get",
          "core.hooksPath",
        ])
      ).trim(),
    ).toBe("NUL");
    await prepared.cleanup();
  });

  test("never returns a path that appeared after changed-path validation", async () => {
    const repository = await createTestRepository();
    cleanupPaths.push(repository.root);
    const stateDirectory = await makeStateDirectory();
    cleanupPaths.push(stateDirectory);
    const config = makeConfig({
      allowedRoots: [repository.root],
      enableProposals: true,
      stateDirectory,
    });
    // Stands in for a descendant that survived the run and keeps writing into
    // the clone while the proposal is being validated.
    class LateWriterGitClient extends GitClient {
      public override async run(
        cwd: string,
        args: readonly string[],
        acceptedExitCodes: readonly number[] = [0],
      ): Promise<GitResult> {
        const result = await super.run(cwd, args, acceptedExitCodes);
        if (args[0] === "ls-files" && args[1] === "--others") {
          await writeFile(join(cwd, "smuggled.txt"), "not validated\n", "utf8");
        }
        return result;
      }
    }
    const workspace = new ProposalWorkspace(
      config,
      new LateWriterGitClient(config),
    );
    await workspace.initialize();

    const prepared = await workspace.prepare(
      makeRequest(repository.root, {
        mode: "proposal",
        expectedRevision: repository.revision,
        writePaths: ["src"],
      }),
    );
    await writeFile(
      join(prepared.request.executionRoot, "src", "allowed.ts"),
      "export const value = 2;\n",
      "utf8",
    );

    // Refusing the proposal outright is also correct; smuggling the path into
    // a returned patch is not.
    let artifact: ProposalArtifact | undefined;
    try {
      artifact = await prepared.finalize();
    } catch {
      return;
    }
    expect(artifact.changedFiles).not.toContain("smuggled.txt");
    expect(artifact.patch ?? "").not.toContain("smuggled.txt");
  });

  test("creates a clean revision-pinned clone and returns a validated allowed patch", async () => {
    const { repository, workspace } = await makeHarness();
    const prepared = await workspace.prepare(
      makeRequest(repository.root, {
        mode: "proposal",
        expectedRevision: repository.revision,
        writePaths: ["src"],
      }),
    );

    expect(prepared.request.executionRoot).not.toBe(repository.root);
    expect(
      await runGit(prepared.request.executionRoot, ["rev-parse", "HEAD"]),
    ).toContain(repository.revision);
    await writeFile(
      join(prepared.request.executionRoot, "src", "allowed.ts"),
      "export const value = 2;\n",
      "utf8",
    );

    const artifact = await prepared.finalize();
    expect(artifact.effect).toBe("proposal");
    expect(artifact.baselineRevision).toBe(repository.revision);
    expect(artifact.changedFiles).toEqual(["src/allowed.ts"]);
    expect(artifact.patch).toContain("export const value = 2");
    expect(artifact.patchSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await runGit(repository.root, ["status", "--porcelain"])).toBe("");
    await prepared.cleanup();
    await prepared.cleanup();
  });

  test("returns an explicit no-effect artifact when the clone is unchanged", async () => {
    const { repository, workspace } = await makeHarness();
    const prepared = await workspace.prepare(
      makeRequest(repository.root, {
        mode: "proposal",
        expectedRevision: repository.revision,
        writePaths: ["src"],
      }),
    );
    await expect(prepared.finalize()).resolves.toEqual({
      effect: "none",
      baselineRevision: repository.revision,
      changedFiles: [],
      patchBytes: 0,
    });
    await prepared.cleanup();
  });

  test("rejects any changed file outside the requested scope", async () => {
    const { repository, workspace } = await makeHarness();
    const prepared = await workspace.prepare(
      makeRequest(repository.root, {
        mode: "proposal",
        expectedRevision: repository.revision,
        writePaths: ["src"],
      }),
    );
    await writeFile(
      join(prepared.request.executionRoot, "README.md"),
      "escaped\n",
      "utf8",
    );
    await expect(prepared.finalize()).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_PATH,
    });
    await prepared.cleanup();
  });

  test("rejects a protected file even when its parent directory is allowed", async () => {
    const { repository, workspace } = await makeHarness();
    const prepared = await workspace.prepare(
      makeRequest(repository.root, {
        mode: "proposal",
        expectedRevision: repository.revision,
        writePaths: ["config"],
      }),
    );
    await mkdir(join(prepared.request.executionRoot, "config"), {
      recursive: true,
    });
    await writeFile(
      join(prepared.request.executionRoot, "config", ".env.production"),
      "SECRET=value\n",
      "utf8",
    );
    await expect(prepared.finalize()).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_PATH,
    });
    await prepared.cleanup();
  });

  test("requires proposal mode, a full expected revision, a matching HEAD, and a clean source", async () => {
    const { repository, workspace } = await makeHarness();
    await expect(
      workspace.prepare(makeRequest(repository.root)),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_REQUEST,
    });
    await expect(
      workspace.prepare(
        makeRequest(repository.root, {
          mode: "proposal",
          writePaths: ["src"],
        }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_REQUEST });
    await expect(
      workspace.prepare(
        makeRequest(repository.root, {
          mode: "proposal",
          expectedRevision: "short",
          writePaths: ["src"],
        }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_REQUEST });
    await expect(
      workspace.prepare(
        makeRequest(repository.root, {
          mode: "proposal",
          expectedRevision: "b".repeat(40),
          writePaths: ["src"],
        }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.REVISION_MISMATCH });

    await writeFile(join(repository.root, "README.md"), "dirty\n", "utf8");
    await expect(
      workspace.prepare(
        makeRequest(repository.root, {
          mode: "proposal",
          expectedRevision: repository.revision,
          writePaths: ["src"],
        }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.WORKTREE_DIRTY });
  });

  test("rejects repositories declaring submodules", async () => {
    const { repository, workspace } = await makeHarness();
    await writeFile(
      join(repository.root, ".gitmodules"),
      '[submodule "x"]\n',
      "utf8",
    );
    await expect(
      workspace.prepare(
        makeRequest(repository.root, {
          mode: "proposal",
          expectedRevision: repository.revision,
          writePaths: ["src"],
        }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.SUBMODULES_UNSUPPORTED });
  });

  test("rejects changed Git refs even when files are within scope", async () => {
    const { repository, workspace } = await makeHarness();
    const prepared = await workspace.prepare(
      makeRequest(repository.root, {
        mode: "proposal",
        expectedRevision: repository.revision,
        writePaths: ["src"],
      }),
    );
    await runGit(prepared.request.executionRoot, ["branch", "forbidden-ref"]);
    await expect(prepared.finalize()).rejects.toMatchObject({
      code: ERROR_CODES.RUNTIME_FAILED,
    });
    await prepared.cleanup();
  });

  test.runIf(process.platform !== "win32")(
    "rejects a new symbolic link even inside the allowed scope",
    async () => {
      const { repository, workspace } = await makeHarness();
      const prepared = await workspace.prepare(
        makeRequest(repository.root, {
          mode: "proposal",
          expectedRevision: repository.revision,
          writePaths: ["src"],
        }),
      );
      await symlink(
        "../README.md",
        join(prepared.request.executionRoot, "src", "link"),
      );
      await expect(prepared.finalize()).rejects.toMatchObject({
        code: ERROR_CODES.INVALID_PATH,
      });
      await prepared.cleanup();
    },
  );

  test.runIf(process.platform !== "win32")(
    "rejects a hardlinked file even inside the allowed scope",
    async () => {
      const { repository, workspace } = await makeHarness();
      const prepared = await workspace.prepare(
        makeRequest(repository.root, {
          mode: "proposal",
          expectedRevision: repository.revision,
          writePaths: ["src"],
        }),
      );
      await link(
        join(prepared.request.executionRoot, "README.md"),
        join(prepared.request.executionRoot, "src", "hardlink.txt"),
      );
      await expect(prepared.finalize()).rejects.toMatchObject({
        code: ERROR_CODES.INVALID_PATH,
      });
      await prepared.cleanup();
    },
  );

  test("enforces changed-file and patch-size limits", async () => {
    const changedLimitHarness = await makeHarness({ maxChangedFiles: 1 });
    const changedPrepared = await changedLimitHarness.workspace.prepare(
      makeRequest(changedLimitHarness.repository.root, {
        mode: "proposal",
        expectedRevision: changedLimitHarness.repository.revision,
        writePaths: ["src"],
      }),
    );
    await writeFile(
      join(changedPrepared.request.executionRoot, "src", "one.ts"),
      "1\n",
    );
    await writeFile(
      join(changedPrepared.request.executionRoot, "src", "two.ts"),
      "2\n",
    );
    await expect(changedPrepared.finalize()).rejects.toMatchObject({
      code: ERROR_CODES.PATCH_LIMIT_EXCEEDED,
    });
    await changedPrepared.cleanup();

    const patchLimitHarness = await makeHarness({ maxPatchBytes: 64 });
    const patchPrepared = await patchLimitHarness.workspace.prepare(
      makeRequest(patchLimitHarness.repository.root, {
        mode: "proposal",
        expectedRevision: patchLimitHarness.repository.revision,
        writePaths: ["src"],
      }),
    );
    await mkdir(join(patchPrepared.request.executionRoot, "src"), {
      recursive: true,
    });
    await writeFile(
      join(patchPrepared.request.executionRoot, "src", "large.txt"),
      "large-content\n".repeat(100),
    );
    await expect(patchPrepared.finalize()).rejects.toMatchObject({
      code: ERROR_CODES.PATCH_LIMIT_EXCEEDED,
    });
    await patchPrepared.cleanup();
  }, 30_000);
});
