import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { createWorkerApplication } from "../src/worker-application.js";
import { loadWorkerConfig } from "../src/config/worker-config.js";
import { ERROR_CODES } from "../src/core/errors.js";
import { collectWorkerHealth } from "../src/runtime/doctor.js";
import { GitClient } from "../src/runtime/git-client.js";
import { WorkspaceInspector } from "../src/runtime/workspace-inspector.js";
import {
  createTestRepository,
  ensureExecutable,
  makeConfig,
  makeStateDirectory,
} from "./helpers.js";

const fakeCodex = fileURLToPath(
  new URL("./fixtures/fake-codex.mjs", import.meta.url),
);
const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
});

describe("GitClient and WorkspaceInspector", () => {
  test("reports a clean proposal-ready repository and then its blockers", async () => {
    const repository = await createTestRepository();
    cleanupPaths.push(repository.root);
    const config = makeConfig({
      allowedRoots: [repository.root],
      enableProposals: true,
    });
    const inspector = new WorkspaceInspector(config, new GitClient(config));

    await expect(inspector.inspect(repository.root)).resolves.toEqual({
      cwd: repository.root,
      repositoryRoot: repository.root,
      revision: repository.revision,
      clean: true,
      proposalReady: true,
      proposalBlockers: [],
    });

    await writeFile(join(repository.root, "README.md"), "dirty\n", "utf8");
    const dirty = await inspector.inspect();
    expect(dirty.clean).toBe(false);
    expect(dirty.proposalReady).toBe(false);
    expect(dirty.proposalBlockers).toContain(
      "The Git working tree is not clean",
    );
  });

  test("reports disabled proposals and submodule declarations", async () => {
    const repository = await createTestRepository();
    cleanupPaths.push(repository.root);
    await writeFile(
      join(repository.root, ".gitmodules"),
      '[submodule "demo"]\n',
      "utf8",
    );
    const config = makeConfig({
      allowedRoots: [repository.root],
      enableProposals: false,
    });
    const summary = await new WorkspaceInspector(
      config,
      new GitClient(config),
    ).inspect();
    expect(summary.proposalBlockers).toEqual([
      "Proposal mode is disabled at server startup",
      "The Git working tree is not clean",
      "Repositories with submodules are unsupported in proposal mode",
    ]);
  });

  test("turns a failed Git process into a bounded typed error", async () => {
    const repository = await createTestRepository();
    cleanupPaths.push(repository.root);
    const config = makeConfig({ allowedRoots: [repository.root] });
    const untrustedArgument = "not-a-real-subcommand-secret-value";
    const operation = new GitClient(config).run(repository.root, [
      untrustedArgument,
    ]);
    await expect(operation).rejects.toMatchObject({
      code: ERROR_CODES.RUNTIME_FAILED,
      message: "A required Git command failed",
    });
    await expect(operation).rejects.not.toThrow(untrustedArgument);
  });
});

describe("doctor capability detection", () => {
  test("checks bounded raw help before redacting forwarded environment values", async () => {
    const parsedConfig = loadWorkerConfig(
      { CCW_FORWARD_ENV: "FOO,FAKE_ECHO_FORWARD" },
      process.cwd(),
    );
    const config = makeConfig({
      codexExecutable: "/canonical/npm/codex.cmd",
      codexLauncherExecutable: process.execPath,
      codexLauncherArguments: [fakeCodex],
      gitExecutable: process.execPath,
      forwardEnvironment: parsedConfig.forwardEnvironment,
    });
    const health = await collectWorkerHealth(config, {
      ...process.env,
      FOO: "--json",
      FAKE_ECHO_FORWARD: "1",
    });

    expect(health).toMatchObject({
      ok: true,
      authenticated: true,
      compatible: true,
      codexVersion: "codex-cli [REDACTED]",
    });
    expect(health.warnings).not.toContain(
      "This Codex CLI does not advertise every flag required by the worker",
    );
    expect(JSON.stringify(health)).not.toContain("--json");
  }, 15_000);
});

describe.runIf(process.platform !== "win32")(
  "health and application composition",
  () => {
    test("collects sanitized versions and capability warnings", async () => {
      await ensureExecutable(fakeCodex);
      const config = makeConfig({
        codexExecutable: "/canonical/npm/codex.cmd",
        codexLauncherExecutable: process.execPath,
        codexLauncherArguments: [fakeCodex],
        gitExecutable: fakeCodex,
        allowedRoots: ["/safe/repository"],
        allowedModels: ["gpt-5.6-sol"],
        enableProposals: true,
        forwardAuthEnvironment: true,
        forwardEnvironment: [
          "FAKE_LOGIN_FAIL",
          "FAKE_INCOMPATIBLE",
          "FAKE_ECHO_AUTH",
        ],
      });
      const healthy = await collectWorkerHealth(config, {
        PATH: process.env.PATH,
        FAKE_LOGIN_FAIL: "0",
      });
      expect(healthy).toMatchObject({
        ok: true,
        authenticated: true,
        compatible: true,
        codexVersion: "codex-cli 99.0.0-test",
        codexExecutable: "/canonical/npm/codex.cmd",
        gitVersion: "codex-cli 99.0.0-test",
        proposalsEnabled: true,
        authEnvironmentForwarding: true,
      });
      expect(healthy.warnings).toEqual([
        "Proposal mode is enabled; only validated patches are returned and never applied",
        "Explicit authentication environment forwarding is enabled",
      ]);

      const unhealthy = await collectWorkerHealth(config, {
        PATH: process.env.PATH,
        FAKE_LOGIN_FAIL: "1",
      });
      expect(unhealthy.ok).toBe(false);
      expect(unhealthy.authenticated).toBe(false);
      expect(unhealthy.warnings[0]).toContain(
        "Codex authentication is not ready",
      );

      const incompatible = await collectWorkerHealth(config, {
        PATH: process.env.PATH,
        FAKE_LOGIN_FAIL: "0",
        FAKE_INCOMPATIBLE: "1",
      });
      expect(incompatible).toMatchObject({ ok: false, compatible: false });
      expect(incompatible.warnings).toContain(
        "This Codex CLI does not advertise every flag required by the worker",
      );

      const secret = "doctor-forwarded-secret-value";
      const redacted = await collectWorkerHealth(config, {
        PATH: process.env.PATH,
        FAKE_LOGIN_FAIL: "0",
        FAKE_ECHO_AUTH: "1",
        OPENAI_API_KEY: secret,
      });
      expect(redacted.codexVersion).toContain("[REDACTED]");
      expect(JSON.stringify(redacted)).not.toContain(secret);
    }, 15_000);

    test("composes a worker with canonical executables and initialized managers", async () => {
      await ensureExecutable(fakeCodex);
      const repository = await createTestRepository();
      cleanupPaths.push(repository.root);
      const stateDirectory = await makeStateDirectory();
      cleanupPaths.push(stateDirectory);
      const application = await createWorkerApplication({
        processDirectory: repository.root,
        environment: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          CCW_ALLOWED_ROOTS: repository.root,
          CCW_STATE_DIR: stateDirectory,
          CCW_CODEX_BIN: fakeCodex,
          CCW_GIT_BIN: "git",
        },
      });

      expect(application.config.codexExecutable).toBe(fakeCodex);
      expect(application.config.gitExecutable).not.toBe("git");
      await expect(application.workspaces.inspect()).resolves.toMatchObject({
        repositoryRoot: repository.root,
        revision: repository.revision,
      });
      await expect(application.health()).resolves.toMatchObject({
        authenticated: true,
        proposalsEnabled: false,
      });
      await application.jobs.shutdown();
    }, 15_000);

    test("does not multiply probe subprocesses for concurrent health calls", async () => {
      await ensureExecutable(fakeCodex);
      const repository = await createTestRepository();
      cleanupPaths.push(repository.root);
      const stateDirectory = await makeStateDirectory();
      cleanupPaths.push(stateDirectory);
      const counterPath = join(stateDirectory, "probe-count.log");
      await writeFile(counterPath, "", "utf8");
      const application = await createWorkerApplication({
        processDirectory: repository.root,
        environment: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          CCW_ALLOWED_ROOTS: repository.root,
          CCW_STATE_DIR: stateDirectory,
          CCW_CODEX_BIN: fakeCodex,
          CCW_GIT_BIN: "git",
          CCW_FORWARD_ENV: "FAKE_PROBE_COUNT_PATH",
          FAKE_PROBE_COUNT_PATH: counterPath,
        },
      });

      await Promise.all([
        application.health(),
        application.health(),
        application.health(),
      ]);

      // One concurrent burst must resolve from a single probe round.
      const invocations = (await readFile(counterPath, "utf8"))
        .split("\n")
        .filter((line) => line !== "");
      expect(invocations.length).toBeLessThanOrEqual(4);
      await application.jobs.shutdown();
    }, 15_000);
  },
);
