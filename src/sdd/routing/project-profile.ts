import { REASONING_EFFORTS, type ReasoningEffort } from "../../core/types.js";
import { compareText, sha256CanonicalJson } from "./canonical.js";
import { SDD_ROUTING_ERROR_CODES, SddRoutingError } from "./errors.js";
import {
  ROUTING_LANES,
  TASK_AUTHORITIES,
  TASK_KINDS,
  TASK_RISKS,
  type RoutingLane,
  type TaskAuthority,
  type TaskKind,
  type TaskRisk,
} from "./types.js";

export const SDD_PROJECT_PROFILE_SCHEMA_VERSION = 1 as const;
export const SDD_PROFILE_CAPABILITY_SCORE_MAX = 4 as const;

const MAX_PROFILE_ENTRIES = 64;
const MAX_ARGUMENTS = 32;
const MAX_ARGUMENT_CHARACTERS = 4_096;
const MAX_PROFILE_BYTES = 128 * 1024;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const PROFILE_KEYS = new Set([
  "schemaVersion",
  "profileId",
  "profileVersion",
  "laneCapabilities",
  "taskPolicies",
  "checkProfiles",
  "requiredChecks",
  "codexPolicy",
  "writePolicy",
]);
const CAPABILITY_KEYS = new Set(["id", "score"]);
const TASK_POLICY_KEYS = new Set(["kind", "requirements"]);
const REQUIREMENT_KEYS = new Set(["capabilityId", "minimumScore", "weight"]);
const CHECK_PROFILE_KEYS = new Set(["id", "cwd", "argv"]);
const REQUIRED_CHECKS_KEYS = new Set([
  "always",
  "byKind",
  "byRisk",
  "byAuthority",
]);
const CODEX_POLICY_KEYS = new Set(["default", "byKind", "byRisk"]);
const CODEX_EXECUTION_PROFILE_KEYS = new Set(["model", "reasoningEffort"]);
const WRITE_POLICY_KEYS = new Set(["allowedRoots", "additionalDeniedRoots"]);

export interface SddLaneCapabilityInput {
  readonly id: string;
  readonly score: number;
}

export interface SddCapabilityRequirementInput {
  readonly capabilityId: string;
  readonly minimumScore: number;
  readonly weight: number;
}

export interface SddTaskPolicyInput {
  readonly kind: TaskKind;
  readonly requirements: readonly SddCapabilityRequirementInput[];
}

export interface SddCheckProfileInput {
  readonly id: string;
  readonly cwd: string;
  readonly argv: readonly string[];
}

export interface SddRequiredChecksInput {
  readonly always?: readonly string[];
  readonly byKind?: Partial<Readonly<Record<TaskKind, readonly string[]>>>;
  readonly byRisk?: Partial<Readonly<Record<TaskRisk, readonly string[]>>>;
  readonly byAuthority?: Partial<
    Readonly<Record<TaskAuthority, readonly string[]>>
  >;
}

export interface SddCodexExecutionPolicyInput {
  readonly model: string | null;
  readonly reasoningEffort: ReasoningEffort | null;
}

export interface SddCodexPolicyInput {
  readonly default: SddCodexExecutionPolicyInput;
  readonly byKind?: Partial<
    Readonly<Record<TaskKind, SddCodexExecutionPolicyInput>>
  >;
  readonly byRisk?: Partial<
    Readonly<Record<TaskRisk, SddCodexExecutionPolicyInput>>
  >;
}

export interface SddWritePolicyInput {
  readonly allowedRoots: readonly string[];
  readonly additionalDeniedRoots?: readonly string[];
}

export interface SddProjectProfileInput {
  readonly schemaVersion: typeof SDD_PROJECT_PROFILE_SCHEMA_VERSION;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly laneCapabilities: Readonly<
    Record<RoutingLane, readonly SddLaneCapabilityInput[]>
  >;
  readonly taskPolicies: readonly SddTaskPolicyInput[];
  readonly checkProfiles: readonly SddCheckProfileInput[];
  readonly requiredChecks?: SddRequiredChecksInput;
  readonly codexPolicy: SddCodexPolicyInput;
  readonly writePolicy: SddWritePolicyInput;
}

export interface NormalizedSddCapability {
  readonly id: string;
  readonly scores: Readonly<Record<RoutingLane, number>>;
}

export interface NormalizedSddCapabilityRequirement {
  readonly capabilityId: string;
  readonly minimumScore: number;
  readonly weight: number;
}

export interface NormalizedSddTaskPolicy {
  readonly kind: TaskKind;
  readonly requirements: readonly NormalizedSddCapabilityRequirement[];
}

export interface NormalizedSddCheckProfile {
  readonly id: string;
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly commandSha256: string;
}

export interface NormalizedSddRequiredChecks {
  readonly always: readonly string[];
  readonly byKind: Readonly<Partial<Record<TaskKind, readonly string[]>>>;
  readonly byRisk: Readonly<Partial<Record<TaskRisk, readonly string[]>>>;
  readonly byAuthority: Readonly<
    Partial<Record<TaskAuthority, readonly string[]>>
  >;
}

export interface NormalizedSddCodexExecutionPolicy {
  readonly model: string | null;
  readonly reasoningEffort: ReasoningEffort | null;
}

export interface NormalizedSddCodexPolicy {
  readonly default: NormalizedSddCodexExecutionPolicy;
  readonly byKind: Readonly<
    Partial<Record<TaskKind, NormalizedSddCodexExecutionPolicy>>
  >;
  readonly byRisk: Readonly<
    Partial<Record<TaskRisk, NormalizedSddCodexExecutionPolicy>>
  >;
}

export interface NormalizedSddWritePolicy {
  readonly allowedRoots: readonly string[];
  readonly additionalDeniedRoots: readonly string[];
}

export interface NormalizedSddProjectProfile {
  readonly schemaVersion: typeof SDD_PROJECT_PROFILE_SCHEMA_VERSION;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly capabilities: readonly NormalizedSddCapability[];
  readonly taskPolicies: readonly NormalizedSddTaskPolicy[];
  readonly checkProfiles: readonly NormalizedSddCheckProfile[];
  readonly requiredChecks: NormalizedSddRequiredChecks;
  readonly codexPolicy: NormalizedSddCodexPolicy;
  readonly writePolicy: NormalizedSddWritePolicy;
}

/**
 * Returns a provider-neutral, read-only starting point. Write and critical
 * routing intentionally fail until the operator adds explicit project policy.
 */
export function createProjectProfileTemplate(): SddProjectProfileInput {
  const capabilities = TASK_KINDS.map((kind) => ({ id: kind, score: 3 }));
  return {
    schemaVersion: SDD_PROJECT_PROFILE_SCHEMA_VERSION,
    profileId: "portable-project-template",
    profileVersion: "1.0.0",
    laneCapabilities: {
      codex: capabilities.map((entry) => ({ ...entry })),
      "claude-host": capabilities.map((entry) => ({ ...entry })),
    },
    taskPolicies: TASK_KINDS.map((kind) => ({
      kind,
      requirements: [{ capabilityId: kind, minimumScore: 1, weight: 1 }],
    })),
    checkProfiles: [],
    codexPolicy: {
      default: { model: null, reasoningEffort: null },
    },
    writePolicy: {
      allowedRoots: [],
      additionalDeniedRoots: [],
    },
  };
}

export function normalizeProjectProfile(
  input: SddProjectProfileInput,
): NormalizedSddProjectProfile {
  assertBoundedJson(input);
  const profile = requireRecord(input, "projectProfile");
  assertKnownKeys(profile, PROFILE_KEYS, "projectProfile");
  if (profile.schemaVersion !== SDD_PROJECT_PROFILE_SCHEMA_VERSION) {
    invalidProfile("projectProfile.schemaVersion must be 1");
  }
  const profileId = safeIdentifier(
    profile.profileId,
    "projectProfile.profileId",
  );
  const profileVersion = safeVersion(
    profile.profileVersion,
    "projectProfile.profileVersion",
  );
  const capabilities = normalizeCapabilities(profile.laneCapabilities);
  const taskPolicies = normalizeTaskPolicies(
    profile.taskPolicies,
    capabilities,
  );
  const checkProfiles = normalizeCheckProfiles(profile.checkProfiles);
  const checkIds = new Set(checkProfiles.map((entry) => entry.id));
  const requiredChecks = normalizeRequiredChecks(
    profile.requiredChecks,
    checkIds,
  );
  const codexPolicy = normalizeCodexPolicy(profile.codexPolicy);
  const writePolicy = normalizeWritePolicy(profile.writePolicy);

  return {
    schemaVersion: SDD_PROJECT_PROFILE_SCHEMA_VERSION,
    profileId,
    profileVersion,
    capabilities,
    taskPolicies,
    checkProfiles,
    requiredChecks,
    codexPolicy,
    writePolicy,
  };
}

export function projectProfileFingerprint(
  profile: NormalizedSddProjectProfile,
): string {
  return sha256CanonicalJson(profile);
}

export function resolveTaskPolicy(
  profile: NormalizedSddProjectProfile,
  kind: TaskKind,
): NormalizedSddTaskPolicy {
  const policy = profile.taskPolicies.find((entry) => entry.kind === kind);
  if (policy === undefined) {
    invalidProfile(`projectProfile has no task policy for kind ${kind}`);
  }
  return policy;
}

export function resolveRequiredCheckProfiles(
  profile: NormalizedSddProjectProfile,
  input: {
    readonly kind: TaskKind;
    readonly risk: TaskRisk;
    readonly authority: TaskAuthority;
  },
): readonly NormalizedSddCheckProfile[] {
  if (input.authority !== "write") {
    return [];
  }
  const ids = new Set([
    ...profile.requiredChecks.always,
    ...(profile.requiredChecks.byKind[input.kind] ?? []),
    ...(profile.requiredChecks.byRisk[input.risk] ?? []),
    ...(profile.requiredChecks.byAuthority[input.authority] ?? []),
  ]);
  const byId = new Map(profile.checkProfiles.map((entry) => [entry.id, entry]));
  return [...ids].sort(compareText).map((id) => {
    const check = byId.get(id);
    if (check === undefined) {
      invalidProfile(`projectProfile references unknown check profile ${id}`);
    }
    return check;
  });
}

export function resolveCodexPolicy(
  profile: NormalizedSddProjectProfile,
  input: { readonly kind: TaskKind; readonly risk: TaskRisk },
): NormalizedSddCodexExecutionPolicy {
  if (input.risk === "critical") {
    const critical = profile.codexPolicy.byRisk.critical;
    if (!critical?.model || critical.reasoningEffort === null) {
      throw new SddRoutingError(
        SDD_ROUTING_ERROR_CODES.CRITICAL_CODEX_POLICY_REQUIRED,
        "Critical tasks require an explicit Codex model and reasoning effort in projectProfile.codexPolicy.byRisk.critical",
      );
    }
    return critical;
  }
  return (
    profile.codexPolicy.byRisk[input.risk] ??
    profile.codexPolicy.byKind[input.kind] ??
    profile.codexPolicy.default
  );
}

function normalizeCapabilities(
  value: unknown,
): readonly NormalizedSddCapability[] {
  const lanes = requireRecord(value, "projectProfile.laneCapabilities");
  assertKnownKeys(
    lanes,
    new Set(ROUTING_LANES),
    "projectProfile.laneCapabilities",
  );
  for (const lane of ROUTING_LANES) {
    if (!(lane in lanes)) {
      invalidProfile(`projectProfile.laneCapabilities.${lane} is required`);
    }
  }
  const scores = new Map<string, Record<RoutingLane, number>>();
  for (const lane of ROUTING_LANES) {
    const entries = lanes[lane];
    if (!Array.isArray(entries) || entries.length > MAX_PROFILE_ENTRIES) {
      invalidProfile(
        `projectProfile.laneCapabilities.${lane} must contain at most ${MAX_PROFILE_ENTRIES} entries`,
      );
    }
    const seen = new Set<string>();
    for (const [index, entryValue] of entries.entries()) {
      const entry = requireRecord(
        entryValue,
        `projectProfile.laneCapabilities.${lane}[${index}]`,
      );
      assertKnownKeys(
        entry,
        CAPABILITY_KEYS,
        `projectProfile.laneCapabilities.${lane}[${index}]`,
      );
      const id = safeIdentifier(
        entry.id,
        `projectProfile.laneCapabilities.${lane}[${index}].id`,
      );
      if (seen.has(id)) {
        invalidProfile(`projectProfile repeats capability ${id} for ${lane}`);
      }
      seen.add(id);
      const score = boundedInteger(
        entry.score,
        0,
        SDD_PROFILE_CAPABILITY_SCORE_MAX,
        `projectProfile capability ${id} score`,
      );
      const current = scores.get(id) ?? { codex: 0, "claude-host": 0 };
      current[lane] = score;
      scores.set(id, current);
    }
  }
  if (scores.size === 0 || scores.size > MAX_PROFILE_ENTRIES) {
    invalidProfile(
      `projectProfile must declare 1-${MAX_PROFILE_ENTRIES} capabilities`,
    );
  }
  return [...scores.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([id, laneScores]) => ({
      id,
      scores: {
        codex: laneScores.codex,
        "claude-host": laneScores["claude-host"],
      },
    }));
}

function normalizeTaskPolicies(
  value: unknown,
  capabilities: readonly NormalizedSddCapability[],
): readonly NormalizedSddTaskPolicy[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > TASK_KINDS.length
  ) {
    invalidProfile(
      `projectProfile.taskPolicies must contain 1-${TASK_KINDS.length} entries`,
    );
  }
  const knownCapabilities = new Set(capabilities.map((entry) => entry.id));
  const seenKinds = new Set<TaskKind>();
  const policies = value.map((policyValue, policyIndex) => {
    const policy = requireRecord(
      policyValue,
      `projectProfile.taskPolicies[${policyIndex}]`,
    );
    assertKnownKeys(
      policy,
      TASK_POLICY_KEYS,
      `projectProfile.taskPolicies[${policyIndex}]`,
    );
    const kind = policy.kind;
    if (!isMember(TASK_KINDS, kind)) {
      invalidProfile(
        `projectProfile.taskPolicies[${policyIndex}].kind is invalid`,
      );
    }
    if (seenKinds.has(kind)) {
      invalidProfile(`projectProfile repeats task policy ${kind}`);
    }
    seenKinds.add(kind);
    if (
      !Array.isArray(policy.requirements) ||
      policy.requirements.length < 1 ||
      policy.requirements.length > MAX_PROFILE_ENTRIES
    ) {
      invalidProfile(
        `projectProfile task policy ${kind} must contain 1-${MAX_PROFILE_ENTRIES} requirements`,
      );
    }
    const seenCapabilities = new Set<string>();
    const requirements = policy.requirements.map(
      (requirementValue, requirementIndex) => {
        const requirement = requireRecord(
          requirementValue,
          `projectProfile task policy ${kind} requirements[${requirementIndex}]`,
        );
        assertKnownKeys(
          requirement,
          REQUIREMENT_KEYS,
          `projectProfile task policy ${kind} requirements[${requirementIndex}]`,
        );
        const capabilityId = safeIdentifier(
          requirement.capabilityId,
          `projectProfile task policy ${kind} capabilityId`,
        );
        if (!knownCapabilities.has(capabilityId)) {
          throw new SddRoutingError(
            SDD_ROUTING_ERROR_CODES.UNKNOWN_CAPABILITY,
            `Project profile task kind ${kind} references unknown capability ${capabilityId}`,
          );
        }
        if (seenCapabilities.has(capabilityId)) {
          invalidProfile(
            `projectProfile task policy ${kind} repeats capability ${capabilityId}`,
          );
        }
        seenCapabilities.add(capabilityId);
        return {
          capabilityId,
          minimumScore: boundedInteger(
            requirement.minimumScore,
            1,
            SDD_PROFILE_CAPABILITY_SCORE_MAX,
            `projectProfile task policy ${kind} minimumScore`,
          ),
          weight: boundedInteger(
            requirement.weight,
            1,
            100,
            `projectProfile task policy ${kind} weight`,
          ),
        };
      },
    );
    requirements.sort((left, right) =>
      compareText(left.capabilityId, right.capabilityId),
    );
    return { kind, requirements };
  });
  return policies.sort(
    (left, right) =>
      TASK_KINDS.indexOf(left.kind) - TASK_KINDS.indexOf(right.kind),
  );
}

function normalizeCheckProfiles(
  value: unknown,
): readonly NormalizedSddCheckProfile[] {
  if (!Array.isArray(value) || value.length > MAX_PROFILE_ENTRIES) {
    invalidProfile(
      `projectProfile.checkProfiles must contain at most ${MAX_PROFILE_ENTRIES} entries`,
    );
  }
  const seen = new Set<string>();
  const profiles = value.map((profileValue, index) => {
    const profile = requireRecord(
      profileValue,
      `projectProfile.checkProfiles[${index}]`,
    );
    assertKnownKeys(
      profile,
      CHECK_PROFILE_KEYS,
      `projectProfile.checkProfiles[${index}]`,
    );
    const id = safeIdentifier(
      profile.id,
      `projectProfile.checkProfiles[${index}].id`,
    );
    if (seen.has(id)) {
      invalidProfile(`projectProfile repeats check profile ${id}`);
    }
    seen.add(id);
    const cwd = normalizeRepositoryPath(
      profile.cwd,
      `projectProfile check profile ${id} cwd`,
      true,
    );
    if (
      !Array.isArray(profile.argv) ||
      profile.argv.length < 1 ||
      profile.argv.length > MAX_ARGUMENTS
    ) {
      invalidProfile(
        `projectProfile check profile ${id} argv must contain 1-${MAX_ARGUMENTS} entries`,
      );
    }
    const argv = profile.argv.map((argument, argumentIndex) => {
      if (
        typeof argument !== "string" ||
        argument.length < 1 ||
        argument.length > MAX_ARGUMENT_CHARACTERS ||
        // Commands are data only, but control characters make review ambiguous.
        hasControlCharacters(argument)
      ) {
        invalidProfile(
          `projectProfile check profile ${id} argv[${argumentIndex}] is invalid`,
        );
      }
      return argument;
    });
    return {
      id,
      cwd,
      argv,
      commandSha256: sha256CanonicalJson({ argv, cwd }),
    };
  });
  return profiles.sort((left, right) => compareText(left.id, right.id));
}

function normalizeRequiredChecks(
  value: unknown,
  checkIds: ReadonlySet<string>,
): NormalizedSddRequiredChecks {
  if (value === undefined) {
    return { always: [], byKind: {}, byRisk: {}, byAuthority: {} };
  }
  const required = requireRecord(value, "projectProfile.requiredChecks");
  assertKnownKeys(
    required,
    REQUIRED_CHECKS_KEYS,
    "projectProfile.requiredChecks",
  );
  return {
    always: normalizeCheckIds(required.always, checkIds, "always"),
    byKind: normalizeCheckMap(required.byKind, TASK_KINDS, checkIds, "byKind"),
    byRisk: normalizeCheckMap(required.byRisk, TASK_RISKS, checkIds, "byRisk"),
    byAuthority: normalizeCheckMap(
      required.byAuthority,
      TASK_AUTHORITIES,
      checkIds,
      "byAuthority",
    ),
  };
}

function normalizeCheckMap<const T extends readonly string[]>(
  value: unknown,
  keys: T,
  checkIds: ReadonlySet<string>,
  label: string,
): Readonly<Partial<Record<T[number], readonly string[]>>> {
  if (value === undefined) {
    return {} as Readonly<Partial<Record<T[number], readonly string[]>>>;
  }
  const map = requireRecord(value, `projectProfile.requiredChecks.${label}`);
  assertKnownKeys(map, new Set(keys), `projectProfile.requiredChecks.${label}`);
  const normalized: Record<string, readonly string[]> = {};
  for (const key of keys) {
    if (map[key] !== undefined) {
      normalized[key] = normalizeCheckIds(
        map[key],
        checkIds,
        `${label}.${key}`,
      );
    }
  }
  return normalized as Readonly<Partial<Record<T[number], readonly string[]>>>;
}

function normalizeCheckIds(
  value: unknown,
  checkIds: ReadonlySet<string>,
  label: string,
): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_PROFILE_ENTRIES) {
    invalidProfile(
      `projectProfile.requiredChecks.${label} must contain at most ${MAX_PROFILE_ENTRIES} entries`,
    );
  }
  const ids = value.map((entry, index) =>
    safeIdentifier(entry, `projectProfile.requiredChecks.${label}[${index}]`),
  );
  if (new Set(ids).size !== ids.length) {
    invalidProfile(`projectProfile.requiredChecks.${label} has duplicates`);
  }
  for (const id of ids) {
    if (!checkIds.has(id)) {
      invalidProfile(
        `projectProfile.requiredChecks.${label} references unknown check profile ${id}`,
      );
    }
  }
  return ids.sort(compareText);
}

function normalizeCodexPolicy(value: unknown): NormalizedSddCodexPolicy {
  const policy = requireRecord(value, "projectProfile.codexPolicy");
  assertKnownKeys(policy, CODEX_POLICY_KEYS, "projectProfile.codexPolicy");
  return {
    default: normalizeCodexExecutionPolicy(
      policy.default,
      "projectProfile.codexPolicy.default",
    ),
    byKind: normalizeCodexPolicyMap(
      policy.byKind,
      TASK_KINDS,
      "projectProfile.codexPolicy.byKind",
    ),
    byRisk: normalizeCodexPolicyMap(
      policy.byRisk,
      TASK_RISKS,
      "projectProfile.codexPolicy.byRisk",
    ),
  };
}

function normalizeCodexPolicyMap<const T extends readonly string[]>(
  value: unknown,
  keys: T,
  label: string,
): Readonly<Partial<Record<T[number], NormalizedSddCodexExecutionPolicy>>> {
  if (value === undefined) {
    return {} as Readonly<
      Partial<Record<T[number], NormalizedSddCodexExecutionPolicy>>
    >;
  }
  const map = requireRecord(value, label);
  assertKnownKeys(map, new Set(keys), label);
  const normalized: Record<string, NormalizedSddCodexExecutionPolicy> = {};
  for (const key of keys) {
    if (map[key] !== undefined) {
      normalized[key] = normalizeCodexExecutionPolicy(
        map[key],
        `${label}.${key}`,
      );
    }
  }
  return normalized as Readonly<
    Partial<Record<T[number], NormalizedSddCodexExecutionPolicy>>
  >;
}

function normalizeCodexExecutionPolicy(
  value: unknown,
  label: string,
): NormalizedSddCodexExecutionPolicy {
  const policy = requireRecord(value, label);
  assertKnownKeys(policy, CODEX_EXECUTION_PROFILE_KEYS, label);
  if (policy.model !== null && !isSafeModel(policy.model)) {
    invalidProfile(`${label}.model is invalid`);
  }
  if (
    policy.reasoningEffort !== null &&
    !isMember(REASONING_EFFORTS, policy.reasoningEffort)
  ) {
    invalidProfile(`${label}.reasoningEffort is invalid`);
  }
  return {
    model: policy.model,
    reasoningEffort: policy.reasoningEffort,
  };
}

function normalizeWritePolicy(value: unknown): NormalizedSddWritePolicy {
  const policy = requireRecord(value, "projectProfile.writePolicy");
  assertKnownKeys(policy, WRITE_POLICY_KEYS, "projectProfile.writePolicy");
  return {
    allowedRoots: normalizePathList(
      policy.allowedRoots,
      "projectProfile.writePolicy.allowedRoots",
    ),
    additionalDeniedRoots: normalizePathList(
      policy.additionalDeniedRoots,
      "projectProfile.writePolicy.additionalDeniedRoots",
      true,
    ),
  };
}

function normalizePathList(
  value: unknown,
  label: string,
  optional = false,
): readonly string[] {
  if (value === undefined && optional) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_PROFILE_ENTRIES) {
    invalidProfile(
      `${label} must contain at most ${MAX_PROFILE_ENTRIES} entries`,
    );
  }
  const paths = value.map((entry, index) =>
    normalizeRepositoryPath(entry, `${label}[${index}]`, false),
  );
  if (new Set(paths).size !== paths.length) {
    invalidProfile(`${label} must not contain duplicates`);
  }
  paths.sort(compareText);
  for (let index = 0; index < paths.length; index += 1) {
    const root = paths[index];
    if (
      root !== undefined &&
      paths
        .slice(index + 1)
        .some((candidate) => candidate.startsWith(`${root}/`))
    ) {
      invalidProfile(`${label} must not contain overlapping paths`);
    }
  }
  return paths;
}

function normalizeRepositoryPath(
  value: unknown,
  label: string,
  allowDot: boolean,
): string {
  if (typeof value !== "string") {
    invalidProfile(`${label} must be a string`);
  }
  if (value.includes("\\")) {
    invalidProfile(`${label} must use forward-slash repository paths`);
  }
  const normalized = value;
  if (allowDot && normalized === ".") {
    return normalized;
  }
  const segments = normalized.split("/");
  if (
    normalized.length < 1 ||
    normalized.length > 4_096 ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    /^[A-Za-z]:/.test(normalized) ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment.toLowerCase() === ".git",
    )
  ) {
    invalidProfile(`${label} must be a safe repository-relative path`);
  }
  return normalized.replace(/\/$/u, "");
}

function assertBoundedJson(value: unknown): void {
  let serialized: unknown;
  try {
    serialized = JSON.stringify(value);
  } catch {
    invalidProfile("projectProfile must be JSON-serializable");
  }
  if (typeof serialized !== "string") {
    invalidProfile("projectProfile must be a JSON object");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_PROFILE_BYTES) {
    invalidProfile(`projectProfile exceeds ${MAX_PROFILE_BYTES} bytes`);
  }
}

function assertKnownKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value)
    .filter((key) => !allowed.has(key))
    .sort(compareText);
  if (unknown.length > 0) {
    invalidProfile(
      `${label} contains unsupported fields: ${unknown.join(", ")}`,
    );
  }
}

function requireRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidProfile(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function safeIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value)) {
    invalidProfile(`${label} is invalid`);
  }
  return value;
}

function safeVersion(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_VERSION.test(value)) {
    invalidProfile(`${label} is invalid`);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    !Number.isInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    invalidProfile(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return Number(value);
}

function isSafeModel(value: unknown): value is string {
  return typeof value === "string" && SAFE_MODEL.test(value);
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
}

function isMember<const T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === "string" && values.some((entry) => entry === value);
}

function invalidProfile(message: string): never {
  throw new SddRoutingError(
    SDD_ROUTING_ERROR_CODES.INVALID_PROJECT_PROFILE,
    message,
  );
}
