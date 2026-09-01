import { delimiter, resolve } from "node:path";
import { tmpdir } from "node:os";

import { ERROR_CODES, WorkerError } from "../core/errors.js";
import { REASONING_EFFORTS, type ReasoningEffort } from "../core/types.js";
import { BOUNDEDRELAY_VERSION } from "../version.js";

export interface WorkerConfig {
  readonly version: string;
  /** Canonical user-facing Codex command path selected by policy. */
  readonly codexExecutable: string;
  /** Actual shell-free launcher used when the selected command is a script. */
  readonly codexLauncherExecutable?: string;
  /** Immutable arguments placed before every server-owned Codex argument. */
  readonly codexLauncherArguments?: readonly string[];
  readonly gitExecutable: string;
  readonly allowedRoots: readonly string[];
  readonly allowedModels: readonly string[];
  /** Server-owned model applied when the caller omits one; must be allowlisted. */
  readonly defaultModel?: string;
  /** Server-owned reasoning effort applied when the caller omits one. */
  readonly defaultReasoningEffort?: ReasoningEffort;
  readonly enableProposals: boolean;
  readonly forwardAuthEnvironment: boolean;
  readonly forwardEnvironment: readonly string[];
  readonly maxConcurrent: number;
  readonly maxQueued: number;
  readonly maxHistory: number;
  /**
   * Literal headings a caller-authored task body must contain. It is a
   * structural input contract, not a quality judgement: it makes an
   * under-specified delegation fail closed instead of quietly producing a
   * weak result.
   */
  readonly requiredTaskSections: readonly string[];
  readonly maxTaskChars: number;
  readonly maxOutputBytes: number;
  /** Separate stderr byte budget so log noise cannot exhaust the stdout budget. */
  readonly maxStderrBytes: number;
  readonly maxPatchBytes: number;
  /**
   * Operator-declared argv run once inside a fresh proposal clone so Codex can
   * execute the project's checks there (e.g. an offline dependency install).
   * Server-owned configuration only; never derived from caller input.
   */
  readonly proposalBootstrap?: readonly string[];
  readonly proposalBootstrapTimeoutMs: number;
  readonly maxChangedFiles: number;
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly cancelGraceMs: number;
  readonly gitOperationTimeoutMs: number;
  readonly stateDirectory: string;
}

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

  const uniqueNames = [...new Set(names)];
  if (uniqueNames.length > 32) {
    throw new WorkerError(
      ERROR_CODES.CONFIG_INVALID,
      "CCW_FORWARD_ENV must contain at most 32 unique environment variable names",
    );
  }

  return uniqueNames;
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

const MODEL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function parseDefaultModel(
  value: string | undefined,
  allowedModels: readonly string[],
): string | undefined {
  const model = nonEmpty(value);
  if (model === undefined) {
    return undefined;
  }
  if (!MODEL_IDENTIFIER.test(model)) {
    throw new WorkerError(
      ERROR_CODES.CONFIG_INVALID,
      `CCW_DEFAULT_MODEL is not a valid model identifier: ${model}`,
    );
  }
  if (!allowedModels.includes(model)) {
    throw new WorkerError(
      ERROR_CODES.CONFIG_INVALID,
      "CCW_DEFAULT_MODEL must also be listed in CCW_ALLOWED_MODELS",
    );
  }
  return model;
}

function parseDefaultReasoningEffort(
  value: string | undefined,
): ReasoningEffort | undefined {
  const effort = nonEmpty(value);
  if (effort === undefined) {
    return undefined;
  }
  // The security model keeps the relaxed ultra delegation prompt an explicit
  // per-job opt-in; a server-wide ultra default would arm it silently.
  if (effort === "ultra") {
    throw new WorkerError(
      ERROR_CODES.CONFIG_INVALID,
      "CCW_DEFAULT_REASONING_EFFORT must not be ultra; ultra stays an explicit per-job opt-in",
    );
  }
  if (!(REASONING_EFFORTS as readonly string[]).includes(effort)) {
    throw new WorkerError(
      ERROR_CODES.CONFIG_INVALID,
      `CCW_DEFAULT_REASONING_EFFORT must be one of: ${REASONING_EFFORTS.join(", ")}`,
    );
  }
  return effort as ReasoningEffort;
}

function parseRequiredTaskSections(
  value: string | undefined,
): readonly string[] {
  const raw = nonEmpty(value);
  if (raw === undefined) {
    return [];
  }
  const sections = raw
    .split(",")
    .map((section) => section.trim())
    .filter(Boolean);
  for (const section of sections) {
    if (section.length > 64 || section.includes("\0")) {
      throw new WorkerError(
        ERROR_CODES.CONFIG_INVALID,
        "CCW_REQUIRE_TASK_SECTIONS entries must be 1-64 characters without a null byte",
      );
    }
  }
  const unique = [...new Set(sections)];
  if (unique.length > 16) {
    throw new WorkerError(
      ERROR_CODES.CONFIG_INVALID,
      "CCW_REQUIRE_TASK_SECTIONS must contain at most 16 unique headings",
    );
  }
  return unique;
}

function parseProposalBootstrap(
  value: string | undefined,
): readonly string[] | undefined {
  const raw = nonEmpty(value);
  if (raw === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WorkerError(
      ERROR_CODES.CONFIG_INVALID,
      "CCW_PROPOSAL_BOOTSTRAP must be a JSON array of command arguments",
    );
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.length > 32 ||
    parsed.some(
      (argument) =>
        typeof argument !== "string" ||
        argument === "" ||
        argument.length > 4_096 ||
        argument.includes("\0"),
    )
  ) {
    throw new WorkerError(
      ERROR_CODES.CONFIG_INVALID,
      "CCW_PROPOSAL_BOOTSTRAP must be a JSON array of 1-32 non-empty strings without null bytes",
    );
  }
  return parsed as readonly string[];
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

  const allowedModels = parseAllowedModels(environment.CCW_ALLOWED_MODELS);
  const defaultModel = parseDefaultModel(
    environment.CCW_DEFAULT_MODEL,
    allowedModels,
  );
  const defaultReasoningEffort = parseDefaultReasoningEffort(
    environment.CCW_DEFAULT_REASONING_EFFORT,
  );
  const proposalBootstrap = parseProposalBootstrap(
    environment.CCW_PROPOSAL_BOOTSTRAP,
  );

  return {
    version: BOUNDEDRELAY_VERSION,
    codexExecutable,
    gitExecutable,
    allowedRoots: parseAllowedRoots(
      environment.CCW_ALLOWED_ROOTS,
      environment.CLAUDE_PROJECT_DIR,
      processDirectory,
    ),
    allowedModels,
    ...(defaultModel === undefined ? {} : { defaultModel }),
    ...(defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort }),
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
    requiredTaskSections: parseRequiredTaskSections(
      environment.CCW_REQUIRE_TASK_SECTIONS,
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
      5_000_000,
      16_384,
      10_000_000,
    ),
    maxStderrBytes: parseInteger(
      "CCW_MAX_STDERR_BYTES",
      environment.CCW_MAX_STDERR_BYTES,
      10_000_000,
      16_384,
      100_000_000,
    ),
    ...(proposalBootstrap === undefined ? {} : { proposalBootstrap }),
    proposalBootstrapTimeoutMs: parseInteger(
      "CCW_PROPOSAL_BOOTSTRAP_TIMEOUT_MS",
      environment.CCW_PROPOSAL_BOOTSTRAP_TIMEOUT_MS,
      300_000,
      1_000,
      1_800_000,
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

/**
 * The complete non-secret effective configuration, as printed by the CLI
 * `config` command. Every operator-tunable policy knob must appear here so
 * the effective policy is verifiable without reading source.
 */
export function presentEffectiveConfig(
  config: WorkerConfig,
): Record<string, unknown> {
  return {
    version: config.version,
    codexExecutable: config.codexExecutable,
    gitExecutable: config.gitExecutable,
    allowedRoots: config.allowedRoots,
    allowedModels: config.allowedModels,
    ...(config.defaultModel === undefined
      ? {}
      : { defaultModel: config.defaultModel }),
    ...(config.defaultReasoningEffort === undefined
      ? {}
      : { defaultReasoningEffort: config.defaultReasoningEffort }),
    proposalsEnabled: config.enableProposals,
    ...(config.proposalBootstrap === undefined
      ? {}
      : { proposalBootstrap: config.proposalBootstrap }),
    authEnvironmentForwarding: config.forwardAuthEnvironment,
    forwardedEnvironmentNames: config.forwardEnvironment,
    ...(config.requiredTaskSections.length === 0
      ? {}
      : { requiredTaskSections: config.requiredTaskSections }),
    limits: {
      maxConcurrent: config.maxConcurrent,
      maxQueued: config.maxQueued,
      maxHistory: config.maxHistory,
      maxTaskChars: config.maxTaskChars,
      maxOutputBytes: config.maxOutputBytes,
      maxStderrBytes: config.maxStderrBytes,
      maxPatchBytes: config.maxPatchBytes,
      maxChangedFiles: config.maxChangedFiles,
      defaultTimeoutMs: config.defaultTimeoutMs,
      maxTimeoutMs: config.maxTimeoutMs,
      proposalBootstrapTimeoutMs: config.proposalBootstrapTimeoutMs,
    },
    stateDirectory: config.stateDirectory,
  };
}
