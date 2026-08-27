import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import type { WorkerConfig } from "../src/config/worker-config.js";
import type {
  PublicJobSnapshot,
  ResolvedJobRequest,
} from "../src/core/types.js";
import type { JobManager } from "../src/core/job-manager.js";

const execFileAsync = promisify(execFile);

export interface TestRepository {
  readonly root: string;
  readonly revision: string;
  cleanup(): Promise<void>;
}

export function makeConfig(
  overrides: Partial<WorkerConfig> = {},
): WorkerConfig {
  return {
    version: "0.1.0-test",
    codexExecutable: "codex",
    gitExecutable: "git",
    allowedRoots: [],
    allowedModels: [],
    enableProposals: false,
    forwardAuthEnvironment: false,
    forwardEnvironment: [],
    maxConcurrent: 2,
    maxQueued: 32,
    maxHistory: 100,
    maxTaskChars: 20_000,
    maxOutputBytes: 1_000_000,
    maxPatchBytes: 2_000_000,
    maxChangedFiles: 100,
    defaultTimeoutMs: 20_000,
    maxTimeoutMs: 60_000,
    cancelGraceMs: 50,
    gitOperationTimeoutMs: 30_000,
    stateDirectory: resolve(tmpdir(), `ccw-unused-${randomUUID()}`),
    ...overrides,
  };
}

export async function createTestRepository(): Promise<TestRepository> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ccw-repository-")));
  await runGit(root, ["init", "--quiet"]);
  await runGit(root, ["config", "user.email", "tests@example.invalid"]);
  await runGit(root, ["config", "user.name", "Worker Tests"]);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "README.md"), "baseline\n", "utf8");
  await writeFile(
    join(root, "src", "allowed.ts"),
    "export const value = 1;\n",
    "utf8",
  );
  await writeFile(
    join(root, "src", "stable.ts"),
    "export const stable = true;\n",
    "utf8",
  );
  await runGit(root, ["add", "--all"]);
  await runGit(root, ["commit", "--quiet", "-m", "test baseline"]);
  const revision = (await runGit(root, ["rev-parse", "HEAD"]))
    .trim()
    .toLowerCase();
  return {
    root,
    revision,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function makeStateDirectory(): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), "ccw-state-")));
}

export async function runGit(
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const result = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return result.stdout;
}

export function makeRequest(
  repositoryRoot: string,
  overrides: Partial<ResolvedJobRequest> = {},
): ResolvedJobRequest {
  return {
    task: "Inspect the repository",
    taskHash: "a".repeat(64),
    cwd: repositoryRoot,
    repositoryRoot,
    executionRoot: repositoryRoot,
    mode: "analyze",
    timeoutMs: 10_000,
    ...overrides,
  };
}

export async function waitForTerminal(
  manager: JobManager,
  id: string,
  timeoutMs = 3_000,
): Promise<PublicJobSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let snapshot = await manager.status(id);
  while (
    snapshot.status !== "completed" &&
    snapshot.status !== "failed" &&
    snapshot.status !== "cancelled"
  ) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for job ${id}`);
    }
    snapshot = await manager.status(id, 50);
  }
  return snapshot;
}

export async function ensureExecutable(path: string): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(path, 0o755);
  }
}

export async function writeNestedFile(
  path: string,
  value: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}
