import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { GitClient, type GitResult } from "../src/runtime/git-client.js";
import { compareGitRevisions } from "../src/runtime/review-comparison.js";
import {
  createTestRepository,
  makeConfig,
  runGit,
  type TestRepository,
} from "./helpers.js";

const repositories: TestRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map(async (repo) => repo.cleanup()));
});

describe("compareGitRevisions", () => {
  test("returns a canonical path list and binary diff digest", async () => {
    const repository = await createTestRepository();
    repositories.push(repository);
    await writeFile(join(repository.root, "README.md"), "changed\n", "utf8");
    await writeFile(join(repository.root, "src/z.ts"), "export const z = 1;\n");
    await runGit(repository.root, ["add", "--all"]);
    await runGit(repository.root, ["commit", "--quiet", "-m", "change files"]);
    const current = (
      await runGit(repository.root, ["rev-parse", "HEAD"])
    ).trim();
    const config = makeConfig({ allowedRoots: [repository.root] });

    const comparison = await compareGitRevisions(
      new GitClient(config),
      repository.root,
      repository.revision.toUpperCase(),
      current.toUpperCase(),
    );
    const diff = await runGit(repository.root, [
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-renames",
      `${repository.revision}..${current}`,
      "--",
    ]);
    expect(comparison).toEqual({
      baseRevision: repository.revision,
      changedPaths: ["README.md", "src/z.ts"],
      diffSha256: createHash("sha256").update(diff).digest("hex"),
    });

    await expect(
      compareGitRevisions(
        new GitClient(config),
        repository.root,
        current,
        repository.revision,
      ),
    ).rejects.toThrow(/must be an ancestor/iu);
  });

  test("rejects abbreviated revisions and malformed Git path output", async () => {
    const revisionA = "a".repeat(40);
    const revisionB = "b".repeat(40);
    const fakeGit = (names: string): GitClient =>
      ({
        run: async (
          _cwd: string,
          args: readonly string[],
        ): Promise<GitResult> => ({
          stdout: args.includes("--name-only") ? names : "",
          stderr: "",
          exitCode: 0,
        }),
      }) as unknown as GitClient;

    await expect(
      compareGitRevisions(fakeGit(""), ".", "abc123", revisionB),
    ).rejects.toThrow(/base revision must be a full Git object id/iu);
    await expect(
      compareGitRevisions(fakeGit(""), ".", revisionA, "abc123"),
    ).rejects.toThrow(/current revision must be a full Git object id/iu);
    await expect(
      compareGitRevisions(
        fakeGit("src/a.ts\0src/a.ts\0"),
        ".",
        revisionA,
        revisionB,
      ),
    ).rejects.toThrow(/unique paths/iu);
    await expect(
      compareGitRevisions(fakeGit("../escape.ts\0"), ".", revisionA, revisionB),
    ).rejects.toThrow(/safe repository-relative path/iu);
    await expect(
      compareGitRevisions(
        fakeGit(
          Array.from(
            { length: 257 },
            (_, index) => `src/${String(index)}.ts`,
          ).join("\0") + "\0",
        ),
        ".",
        revisionA,
        revisionB,
      ),
    ).rejects.toThrow(/exceeds 256 unique paths/iu);
  });
});
