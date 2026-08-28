import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, parse } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { loadWorkerConfig } from "../src/config/worker-config.js";
import { ERROR_CODES } from "../src/core/errors.js";
import { initializeSecurityPolicy } from "../src/security/state-policy.js";
import { makeConfig } from "./helpers.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
});

describe("loadWorkerConfig", () => {
  test("uses safe defaults and resolves the project root", () => {
    const processDirectory = join(tmpdir(), "ccw-config-base");
    const config = loadWorkerConfig({}, processDirectory);

    expect(config.enableProposals).toBe(false);
    expect(config.forwardAuthEnvironment).toBe(false);
    expect(config.allowedModels).toEqual([]);
    expect(config.allowedRoots).toEqual([processDirectory]);
    expect(config.maxConcurrent).toBe(2);
    expect(config.defaultTimeoutMs).toBeLessThanOrEqual(config.maxTimeoutMs);
  });

  test("parses roots, booleans, model allowlist, and forwarded environment names", () => {
    const config = loadWorkerConfig(
      {
        CCW_ALLOWED_ROOTS: ["./one", "./two", "./one"].join(delimiter),
        CCW_ALLOWED_MODELS: "gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-sol",
        CCW_ENABLE_PROPOSALS: "yes",
        CCW_FORWARD_AUTH_ENV: "1",
        CCW_FORWARD_ENV: "CI,BUILD_ID,CI",
        CCW_MAX_CONCURRENT: "4",
        CCW_DEFAULT_TIMEOUT_MS: "5000",
        CCW_MAX_TIMEOUT_MS: "6000",
      },
      join(tmpdir(), "ccw-config-base"),
    );

    expect(config.allowedRoots).toHaveLength(2);
    expect(config.allowedModels).toEqual(["gpt-5.6-sol", "gpt-5.6-terra"]);
    expect(config.enableProposals).toBe(true);
    expect(config.forwardAuthEnvironment).toBe(true);
    expect(config.forwardEnvironment).toEqual(["CI", "BUILD_ID"]);
    expect(config.maxConcurrent).toBe(4);
  });

  test.each([
    [{ CCW_ENABLE_PROPOSALS: "perhaps" }, "boolean"],
    [{ CCW_ALLOWED_MODELS: "--dangerous model" }, "model identifier"],
    [{ CCW_FORWARD_ENV: "GOOD,NOT-VALID" }, "environment variable"],
    [
      {
        CCW_FORWARD_ENV: Array.from(
          { length: 33 },
          (_, index) => `FORWARDED_${index}`,
        ).join(","),
      },
      "at most 32 unique",
    ],
    [{ CCW_MAX_CONCURRENT: "0" }, "CCW_MAX_CONCURRENT"],
    [{ CCW_MAX_CONCURRENT: "1.5" }, "CCW_MAX_CONCURRENT"],
    [
      { CCW_DEFAULT_TIMEOUT_MS: "5000", CCW_MAX_TIMEOUT_MS: "4000" },
      "cannot exceed",
    ],
    [{ CCW_CODEX_BIN: "bad\0binary" }, "null byte"],
  ])("rejects invalid configuration %#", (environment, message) => {
    expect(() => loadWorkerConfig(environment, tmpdir())).toThrow(message);
  });
});

describe("initializeSecurityPolicy", () => {
  test("canonicalizes roots, creates a private state directory, and deduplicates roots", async () => {
    const base = await mkdtemp(join(tmpdir(), "ccw-security-"));
    cleanupPaths.push(base);
    const root = join(base, "repository");
    const state = join(base, "state");
    await mkdir(root);

    const secured = await initializeSecurityPolicy(
      makeConfig({ allowedRoots: [root, root], stateDirectory: state }),
    );

    expect(secured.allowedRoots).toEqual([await realpath(root)]);
    expect(secured.stateDirectory).toBe(await realpath(state));
  });

  test("rejects the filesystem root and home as broad security boundaries", async () => {
    const base = await mkdtemp(join(tmpdir(), "ccw-security-"));
    cleanupPaths.push(base);
    const state = join(base, "state");

    await expect(
      initializeSecurityPolicy(
        makeConfig({ allowedRoots: [parse(base).root], stateDirectory: state }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFIG_INVALID });

    await expect(
      initializeSecurityPolicy(
        makeConfig({ allowedRoots: [base], stateDirectory: homedir() }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFIG_INVALID });
  });

  test("rejects a state directory overlapping an allowed root", async () => {
    const base = await mkdtemp(join(tmpdir(), "ccw-security-"));
    cleanupPaths.push(base);
    const root = join(base, "repository");
    await mkdir(root);

    await expect(
      initializeSecurityPolicy(
        makeConfig({
          allowedRoots: [root],
          stateDirectory: join(root, ".state"),
        }),
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFIG_INVALID });
  });

  test.runIf(process.platform !== "win32")(
    "rejects symlink roots and symlink state directories",
    async () => {
      const base = await mkdtemp(join(tmpdir(), "ccw-security-"));
      cleanupPaths.push(base);
      const realRoot = join(base, "real-root");
      const rootLink = join(base, "root-link");
      const realState = join(base, "real-state");
      const stateLink = join(base, "state-link");
      await mkdir(realRoot);
      await mkdir(realState);
      await symlink(realRoot, rootLink, "dir");
      await symlink(realState, stateLink, "dir");

      await expect(
        initializeSecurityPolicy(
          makeConfig({
            allowedRoots: [rootLink],
            stateDirectory: join(base, "state"),
          }),
        ),
      ).rejects.toMatchObject({ code: ERROR_CODES.CONFIG_INVALID });
      await expect(
        initializeSecurityPolicy(
          makeConfig({ allowedRoots: [realRoot], stateDirectory: stateLink }),
        ),
      ).rejects.toMatchObject({ code: ERROR_CODES.CONFIG_INVALID });
    },
  );
});
