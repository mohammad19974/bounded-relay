import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { ERROR_CODES } from "../src/core/errors.js";
import { resolveExecutable } from "../src/security/executable-policy.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    cleanupPaths.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "boundedrelay-executable-policy-"));
  cleanupPaths.push(root);
  return root;
}

async function executable(path: string): Promise<void> {
  await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(path, 0o755);
}

describe("executable policy error coverage", () => {
  test.runIf(process.platform !== "win32")(
    "rejects directories and non-executable files with label-specific errors",
    async () => {
      const root = await fixture();
      const directory = join(root, "directory");
      const file = join(root, "not-executable");
      await mkdir(directory);
      await writeFile(file, "not executable\n", "utf8");
      await chmod(file, 0o600);

      await expect(
        resolveExecutable(directory, undefined, "Codex"),
      ).rejects.toMatchObject({ code: ERROR_CODES.CODEX_NOT_FOUND });
      await expect(
        resolveExecutable(file, undefined, "Git"),
      ).rejects.toMatchObject({ code: ERROR_CODES.CONFIG_INVALID });
    },
  );

  test.runIf(process.platform !== "win32")(
    "skips empty and unusable PATH entries before accepting a later executable",
    async () => {
      const root = await fixture();
      const unusableBin = join(root, "unusable");
      const validBin = join(root, "valid");
      await mkdir(unusableBin);
      await mkdir(validBin);
      await mkdir(join(unusableBin, "relay-tool"));
      await executable(join(validBin, "relay-tool"));

      await expect(
        resolveExecutable(
          "relay-tool",
          ["", unusableBin, " ", validBin, ""].join(delimiter),
          "Codex",
        ),
      ).resolves.toBe(await realpath(resolve(validBin, "relay-tool")));
    },
  );

  test("uses configuration errors for a missing non-Codex PATH executable", async () => {
    await expect(
      resolveExecutable("missing-git", undefined, "Git"),
    ).rejects.toMatchObject({
      code: ERROR_CODES.CONFIG_INVALID,
      message: "Git executable was not found on PATH",
    });
  });

  test.runIf(process.platform !== "win32")(
    "expands normalized PATHEXT candidates on Windows and preserves explicit extensions",
    async () => {
      const root = await fixture();
      const withExtension = join(root, "relay-tool.exe");
      const withDefaultExtension = join(root, "default-tool.cmd");
      await executable(withExtension);
      await executable(withDefaultExtension);
      const platform = vi
        .spyOn(process, "platform", "get")
        .mockReturnValue("win32");
      const originalPathExtensions = process.env.PATHEXT;
      delete process.env.PATHEXT;

      try {
        await expect(
          resolveExecutable("relay-tool", root, "Codex", " ; .EXE ; ; .CMD "),
        ).resolves.toBe(await realpath(withExtension));
        await expect(
          resolveExecutable("relay-tool.exe", root, "Codex", ".CMD"),
        ).resolves.toBe(await realpath(withExtension));
        await expect(
          resolveExecutable("default-tool", root, "Codex", undefined),
        ).resolves.toBe(await realpath(withDefaultExtension));
      } finally {
        if (originalPathExtensions === undefined) {
          delete process.env.PATHEXT;
        } else {
          process.env.PATHEXT = originalPathExtensions;
        }
        platform.mockRestore();
      }
    },
  );
});
