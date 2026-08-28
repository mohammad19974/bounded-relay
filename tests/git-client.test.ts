import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "vitest";

import { GitClient } from "../src/runtime/git-client.js";
import { createTestRepository, makeConfig } from "./helpers.js";

test("enables Windows long paths while preserving isolated Git configuration", async () => {
  const repository = await createTestRepository();
  try {
    const ambientGlobalConfig = join(repository.root, "ambient.gitconfig");
    await writeFile(
      ambientGlobalConfig,
      "[core]\n\tlongpaths = false\n",
      "utf8",
    );
    const config = makeConfig({ allowedRoots: [repository.root] });
    const git = new GitClient(
      config,
      {
        ...process.env,
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: ambientGlobalConfig,
        GIT_CONFIG_NOSYSTEM: "0",
      },
      "win32",
    );

    const effective = await git.run(repository.root, [
      "config",
      "--get",
      "core.longpaths",
    ]);
    expect(effective.stdout.trim()).toBe("true");
    expect(effective.exitCode).toBe(0);

    const isolatedGlobal = await git.run(
      repository.root,
      ["config", "--global", "--get", "core.longpaths"],
      [0, 1],
    );
    expect(isolatedGlobal.stdout).toBe("");
    expect(isolatedGlobal.exitCode).toBe(1);
  } finally {
    await repository.cleanup();
  }
});
