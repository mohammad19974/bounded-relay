import { delimiter, resolve } from "node:path";
import { tmpdir } from "node:os";

import { ERROR_CODES, WorkerError } from "../core/errors.js";

export interface WorkerConfig {
  readonly version: string;
  readonly codexExecutable: string;
  readonly gitExecutable: string;
  readonly allowedRoots: readonly string[];
  readonly allowedModels: readonly string[];
  readonly enableProposals: boolean;
  readonly forwardAuthEnvironment: boolean;
  readonly forwardEnvironment: readonly string[];
  readonly maxConcurrent: number;
  readonly maxQueued: number;
  readonly maxHistory: number;
  readonly maxTaskChars: number;
  readonly maxOutputBytes: number;
  readonly maxPatchBytes: number;
  readonly maxChangedFiles: number;
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly cancelGraceMs: number;
  readonly gitOperationTimeoutMs: number;
  readonly stateDirectory: string;
}

const VERSION = "0.1.0";

function parseBoolean(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }

  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(value.toLowerCase())) {
    return false;
  }

  throw new WorkerError(
    ERROR_CODES.CONFIG_INVALID,
    `Expected a boolean value, received ${JSON.stringify(value)}`,
  );
}

function parseInteger(
  name: string,
  value: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const parsed =
    value === undefined || value === "" ? defaultValue : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new WorkerError(
      ERROR_CODES.CONFIG_INVALID,
      `${name} must be an integer from ${minimum} to ${maximum}`,
    );
  }

  return parsed;
}

function parseEnvironmentNames(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") {
    return [];
  }

  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  for (const name of names) {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(name)) {
      throw new WorkerError(
        ERROR_CODES.CONFIG_INVALID,
        `CCW_FORWARD_ENV contains an invalid environment variable name: ${name}`,
      );
    }
  }

  return [...new Set(names)];
}

function parseAllowedModels(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") {
    return [];
  }

  const models = value
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  for (const model of models) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model)) {
      throw new WorkerError(
        ERROR_CODES.CONFIG_INVALID,
        `CCW_ALLOWED_MODELS contains an invalid model identifier: ${model}`,
      );
    }
  }
  return [...new Set(models)];
}

function parseAllowedRoots(
  value: string | undefined,
  projectDirectory: string | undefined,
  processDirectory: string,
): readonly string[] {
  const rawRoots = value
    ?.split(delimiter)
    .map((root) => root.trim())
    .filter(Boolean);
  const roots = rawRoots?.length
    ? rawRoots
    : [nonEmpty(projectDirectory) ?? processDirectory];

  return [...new Set(roots.map((root) => resolve(root)))];
}

export function loadWorkerConfig(
  environment: NodeJS.ProcessEnv = process.env,
  processDirectory = process.cwd(),
): WorkerConfig {
  const codexExecutable = nonEmpty(environment.CCW_CODEX_BIN) ?? "codex";
  const gitExecutable = nonEmpty(environment.CCW_GIT_BIN) ?? "git";
  if (codexExecutable.includes("\0") || gitExecutable.includes("\0")) {
    throw new WorkerError(
      ERROR_CODES.CONFIG_INVALID,
      "CCW_CODEX_BIN and CCW_GIT_BIN must not contain a null byte",
    );
  }

  const defaultTimeoutMs = parseInteger(
    "CCW_DEFAULT_TIMEOUT_MS",
    environment.CCW_DEFAULT_TIMEOUT_MS,
    20 * 60 * 1000,
    1_000,
    60 * 60 * 1000,
  );
  const maxTimeoutMs = parseInteger(
    "CCW_MAX_TIMEOUT_MS",
    environment.CCW_MAX_TIMEOUT_MS,
    30 * 60 * 1000,
    1_000,
    2 * 60 * 60 * 1000,
  );
  if (defaultTimeoutMs > maxTimeoutMs) {
    throw new WorkerError(
      ERROR_CODES.CONFIG_INVALID,
      "CCW_DEFAULT_TIMEOUT_MS cannot exceed CCW_MAX_TIMEOUT_MS",
    );
  }

  return {
    version: VERSION,
    codexExecutable,
    gitExecutable,
    allowedRoots: parseAllowedRoots(
      environment.CCW_ALLOWED_ROOTS,
      environment.CLAUDE_PROJECT_DIR,
      processDirectory,
    ),
    allowedModels: parseAllowedModels(environment.CCW_ALLOWED_MODELS),
    enableProposals: parseBoolean(environment.CCW_ENABLE_PROPOSALS, false),
    forwardAuthEnvironment: parseBoolean(
      environment.CCW_FORWARD_AUTH_ENV,
      false,
    ),
    forwardEnvironment: parseEnvironmentNames(environment.CCW_FORWARD_ENV),
    maxConcurrent: parseInteger(
      "CCW_MAX_CONCURRENT",
      environment.CCW_MAX_CONCURRENT,
      2,
      1,
      8,
    ),
    maxQueued: parseInteger(
      "CCW_MAX_QUEUED",
      environment.CCW_MAX_QUEUED,
      32,
      1,
      256,
    ),
    maxHistory: parseInteger(
      "CCW_MAX_HISTORY",
      environment.CCW_MAX_HISTORY,
      100,
      10,
      1_000,
    ),
    maxTaskChars: parseInteger(
      "CCW_MAX_TASK_CHARS",
      environment.CCW_MAX_TASK_CHARS,
      20_000,
      100,
      100_000,
    ),
    maxOutputBytes: parseInteger(
      "CCW_MAX_OUTPUT_BYTES",
      environment.CCW_MAX_OUTPUT_BYTES,
      1_000_000,
      16_384,
      10_000_000,
    ),
    maxPatchBytes: parseInteger(
      "CCW_MAX_PATCH_BYTES",
      environment.CCW_MAX_PATCH_BYTES,
      2_000_000,
      16_384,
      20_000_000,
    ),
    maxChangedFiles: parseInteger(
      "CCW_MAX_CHANGED_FILES",
      environment.CCW_MAX_CHANGED_FILES,
      100,
      1,
      1_000,
    ),
    defaultTimeoutMs,
    maxTimeoutMs,
    cancelGraceMs: parseInteger(
      "CCW_CANCEL_GRACE_MS",
      environment.CCW_CANCEL_GRACE_MS,
      3_000,
      100,
      30_000,
    ),
    gitOperationTimeoutMs: parseInteger(
      "CCW_GIT_TIMEOUT_MS",
      environment.CCW_GIT_TIMEOUT_MS,
      30_000,
      1_000,
      5 * 60 * 1000,
    ),
    stateDirectory: resolve(
      nonEmpty(environment.CCW_STATE_DIR) ??
        resolve(
          nonEmpty(environment.XDG_RUNTIME_DIR) ?? tmpdir(),
          `boundedrelay-${process.getuid?.() ?? "user"}`,
        ),
    ),
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}
