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
import {
  resolveCodexLauncher,
  resolveExecutable,
} from "../src/security/executable-policy.js";

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
  test("builds shell-free Windows launchers for native, Node, and standard npm Codex installs", async () => {
    const root = await fixture();
    const nativeCodex = join(root, "codex.exe");
    const scriptCodex = join(root, "fake-codex.mjs");
    const globalBin = join(root, "npm-bin");
    const npmShim = join(globalBin, "codex.cmd");
    const npmEntrypoint = join(
      globalBin,
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    await mkdir(join(npmEntrypoint, ".."), { recursive: true });
    await writeFile(nativeCodex, "native fixture\n", "utf8");
    await writeFile(scriptCodex, "export {};\n", "utf8");
    await writeFile(npmShim, "@node codex.js %*\r\n", "utf8");
    await writeFile(npmEntrypoint, "export {};\n", "utf8");

    await expect(resolveCodexLauncher(nativeCodex, "win32")).resolves.toEqual({
      executable: nativeCodex,
      arguments: [],
    });
    await expect(resolveCodexLauncher(scriptCodex, "win32")).resolves.toEqual({
      executable: process.execPath,
      arguments: [scriptCodex],
    });
    await expect(resolveCodexLauncher(npmShim, "win32")).resolves.toEqual({
      executable: process.execPath,
      arguments: [await realpath(npmEntrypoint)],
    });
  });

  test("rejects arbitrary Windows shell shims instead of enabling a shell", async () => {
    const root = await fixture();
    const shim = join(root, "custom.cmd");
    await writeFile(shim, "@echo unsafe\r\n", "utf8");

    const rejection: unknown = await resolveCodexLauncher(shim, "win32").catch(
      (error: unknown) => error,
    );
    expect(rejection).toMatchObject({ code: ERROR_CODES.CODEX_NOT_FOUND });
    expect(rejection).toBeInstanceOf(Error);
    if (!(rejection instanceof Error)) {
      throw new Error("Expected resolveCodexLauncher to reject with an Error");
    }
    expect(rejection.message).toContain("CCW_CODEX_BIN to codex.exe");
  });

  test("prefers a native Windows executable over bare and shell shims", async () => {
    const root = await fixture();
    const bare = join(root, "codex");
    const shim = join(root, "codex.cmd");
    const native = join(root, "codex.exe");
    await Promise.all([executable(bare), executable(shim), executable(native)]);

    await expect(
      resolveExecutable("codex", root, "Codex", ".CMD;.EXE", "win32"),
    ).resolves.toBe(await realpath(native));
  });

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
