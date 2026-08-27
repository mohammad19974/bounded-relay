import { execFile } from "node:child_process";

import type { WorkerConfig } from "../config/worker-config.js";
import { ERROR_CODES, WorkerError, toErrorMessage } from "../core/errors.js";
import { buildChildEnvironment } from "../security/environment-policy.js";

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export class GitClient {
  readonly #config: WorkerConfig;
  readonly #environment: NodeJS.ProcessEnv;

  public constructor(
    config: WorkerConfig,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.#config = config;
    this.#environment = environment;
  }

  public async run(
    cwd: string,
    args: readonly string[],
    acceptedExitCodes: readonly number[] = [0],
  ): Promise<GitResult> {
    const environment = {
      ...buildChildEnvironment(this.#environment, this.#config),
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    };

    return await new Promise<GitResult>((resolvePromise, reject) => {
      execFile(
        this.#config.gitExecutable,
        [...args],
        {
          cwd,
          encoding: "utf8",
          env: environment,
          maxBuffer: Math.max(this.#config.maxPatchBytes * 2, 4_000_000),
          timeout: this.#config.gitOperationTimeoutMs,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const exitCode = error?.code;
          const numericExitCode =
            typeof exitCode === "number" ? exitCode : error === null ? 0 : -1;
          if (error !== null && !acceptedExitCodes.includes(numericExitCode)) {
            reject(
              new WorkerError(
                ERROR_CODES.RUNTIME_FAILED,
                `Git command failed: ${sanitizeGitError(stderr || toErrorMessage(error))}`,
              ),
            );
            return;
          }
          resolvePromise({ stdout, stderr, exitCode: numericExitCode });
        },
      );
    });
  }
}

function sanitizeGitError(message: string): string {
  const normalized = message.replaceAll(/\s+/g, " ").trim();
  return normalized.slice(0, 500) || "unknown Git error";
}
