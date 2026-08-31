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

  test("parses server-owned model defaults and the separate stderr budget", () => {
    const config = loadWorkerConfig(
      {
        CCW_ALLOWED_MODELS: "gpt-5.6-sol,gpt-5.6-terra",
        CCW_DEFAULT_MODEL: "gpt-5.6-sol",
        CCW_DEFAULT_REASONING_EFFORT: "xhigh",
        CCW_MAX_STDERR_BYTES: "32768",
      },
      tmpdir(),
    );

    expect(config.defaultModel).toBe("gpt-5.6-sol");
    expect(config.defaultReasoningEffort).toBe("xhigh");
    expect(config.maxStderrBytes).toBe(32_768);
  });

  test("parses the proposal bootstrap argv and timeout", () => {
    const config = loadWorkerConfig(
      {
        CCW_PROPOSAL_BOOTSTRAP:
          '["pnpm","install","--offline","--frozen-lockfile","--ignore-scripts"]',
        CCW_PROPOSAL_BOOTSTRAP_TIMEOUT_MS: "60000",
      },
      tmpdir(),
    );

    expect(config.proposalBootstrap).toEqual([
      "pnpm",
      "install",
      "--offline",
      "--frozen-lockfile",
      "--ignore-scripts",
    ]);
    expect(config.proposalBootstrapTimeoutMs).toBe(60_000);
  });

  test("leaves the proposal bootstrap unset by default", () => {
    const config = loadWorkerConfig({}, tmpdir());

    expect(config.proposalBootstrap).toBeUndefined();
    expect(config.proposalBootstrapTimeoutMs).toBe(300_000);
  });

  test.each([
    ["not-json"],
    ['"pnpm install"'],
    ["[]"],
    ['["pnpm", ""]'],
    ['["pnpm", 42]'],
  ])("rejects an invalid proposal bootstrap declaration %j", (value) => {
    expect(() =>
      loadWorkerConfig({ CCW_PROPOSAL_BOOTSTRAP: value }, tmpdir()),
    ).toThrow("CCW_PROPOSAL_BOOTSTRAP");
  });

  test("leaves model defaults unset and uses the raised output budgets by default", () => {
    const config = loadWorkerConfig({}, tmpdir());

    expect(config.defaultModel).toBeUndefined();
    expect(config.defaultReasoningEffort).toBeUndefined();
    expect(config.maxOutputBytes).toBe(5_000_000);
    expect(config.maxStderrBytes).toBe(10_000_000);
  });

  test.each([
    [{ CCW_ENABLE_PROPOSALS: "perhaps" }, "boolean"],
    [{ CCW_ALLOWED_MODELS: "--dangerous model" }, "model identifier"],
    [{ CCW_DEFAULT_MODEL: "gpt-5.6-sol" }, "CCW_ALLOWED_MODELS"],
    [
      {
        CCW_ALLOWED_MODELS: "gpt-5.6-sol",
        CCW_DEFAULT_MODEL: "gpt-5.6-luna",
      },
      "CCW_ALLOWED_MODELS",
    ],
    [
      {
        CCW_ALLOWED_MODELS: "ok-model",
        CCW_DEFAULT_MODEL: "--dangerous",
      },
      "model identifier",
    ],
    [
      { CCW_DEFAULT_REASONING_EFFORT: "infinite" },
      "CCW_DEFAULT_REASONING_EFFORT",
    ],
    // The security model keeps the relaxed ultra delegation prompt an explicit
    // per-job opt-in, so a server-wide ultra default must fail closed.
    [{ CCW_DEFAULT_REASONING_EFFORT: "ultra" }, "explicit per-job"],
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
