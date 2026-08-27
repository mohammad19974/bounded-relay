import { compareText } from "./canonical.js";
import { SDD_ROUTING_ERROR_CODES, SddRoutingError } from "./errors.js";
import {
  ROUTING_LANES,
  TASK_AUTHORITIES,
  TASK_KINDS,
  TASK_RISKS,
  type NormalizedSddRoutingTask,
  type RoutingLane,
  type SddRoutingInput,
} from "./types.js";

const MAX_TASKS = 64;
const MAX_COLLECTION_ITEMS = 64;
const MAX_IDENTIFIER_CHARACTERS = 64;
const MAX_WRITE_SCOPE_CHARACTERS = 4_096;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

const INPUT_KEYS = new Set(["tasks", "neutralCodexShareBps"]);
const TASK_KEYS = new Set([
  "id",
  "effortPoints",
  "risk",
  "authority",
  "kind",
  "dependencies",
  "writeScopes",
  "eligibleLanes",
  "preferredLane",
]);

export interface NormalizedRoutingInput {
  readonly tasks: readonly NormalizedSddRoutingTask[];
  readonly neutralCodexShareBps: number;
}

export function normalizeRoutingInput(
  input: SddRoutingInput,
): NormalizedRoutingInput {
  const value = requireRecord(input, "routing input");
  assertKnownKeys(value, INPUT_KEYS, "routing input");
  if (!Array.isArray(value.tasks)) {
    invalidInput("tasks must be an array");
  }
  if (value.tasks.length < 1 || value.tasks.length > MAX_TASKS) {
    invalidInput(`tasks must contain 1-${MAX_TASKS} entries`);
  }

  const neutralCodexShareBps =
    value.neutralCodexShareBps === undefined
      ? 5_000
      : value.neutralCodexShareBps;
  if (
    !Number.isInteger(neutralCodexShareBps) ||
    Number(neutralCodexShareBps) < 0 ||
    Number(neutralCodexShareBps) > 10_000
  ) {
    invalidInput("neutralCodexShareBps must be an integer from 0 to 10000");
  }

  const tasks = value.tasks.map((task, index) => normalizeTask(task, index));
  tasks.sort((left, right) => compareText(left.id, right.id));
  const taskIds = new Set<string>();
  for (const task of tasks) {
    if (taskIds.has(task.id)) {
      throw new SddRoutingError(
        SDD_ROUTING_ERROR_CODES.DUPLICATE_TASK_ID,
        `Duplicate task id: ${task.id}`,
      );
    }
    taskIds.add(task.id);
  }

  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!taskIds.has(dependency)) {
        throw new SddRoutingError(
          SDD_ROUTING_ERROR_CODES.UNKNOWN_DEPENDENCY,
          `Task ${task.id} depends on unknown task ${dependency}`,
        );
      }
      if (dependency === task.id) {
        throw new SddRoutingError(
          SDD_ROUTING_ERROR_CODES.DEPENDENCY_CYCLE,
          `Task ${task.id} cannot depend on itself`,
        );
      }
    }
  }
  assertAcyclic(tasks);

  return {
    tasks,
    neutralCodexShareBps: Number(neutralCodexShareBps),
  };
}

function normalizeTask(
  input: unknown,
  index: number,
): NormalizedSddRoutingTask {
  const task = requireRecord(input, `tasks[${index}]`);
  assertKnownKeys(task, TASK_KEYS, `tasks[${index}]`);
  if (typeof task.id !== "string" || !SAFE_IDENTIFIER.test(task.id)) {
    throw new SddRoutingError(
      SDD_ROUTING_ERROR_CODES.INVALID_TASK,
      `tasks[${index}].id must contain 1-${MAX_IDENTIFIER_CHARACTERS} safe identifier characters`,
    );
  }
  if (
    !Number.isInteger(task.effortPoints) ||
    Number(task.effortPoints) < 1 ||
    Number(task.effortPoints) > 100
  ) {
    invalidTask(task.id, "effortPoints must be an integer from 1 to 100");
  }
  if (!isMember(TASK_RISKS, task.risk)) {
    invalidTask(task.id, "risk is invalid");
  }
  if (!isMember(TASK_AUTHORITIES, task.authority)) {
    invalidTask(task.id, "authority is invalid");
  }
  if (!isMember(TASK_KINDS, task.kind)) {
    invalidTask(task.id, "kind is invalid");
  }

  const dependencies = normalizeIdentifiers(
    task.dependencies,
    `Task ${task.id} dependencies`,
  );
  const writeScopes = normalizeWriteScopes(task.writeScopes, task.id);
  if (task.authority === "read-only" && writeScopes.length > 0) {
    throw new SddRoutingError(
      SDD_ROUTING_ERROR_CODES.INVALID_WRITE_SCOPE,
      `Read-only task ${task.id} must not declare write scopes`,
    );
  }
  if (task.authority === "write" && writeScopes.length === 0) {
    throw new SddRoutingError(
      SDD_ROUTING_ERROR_CODES.INVALID_WRITE_SCOPE,
      `Write task ${task.id} requires at least one explicit write scope`,
    );
  }

  const eligibleLanes = normalizeEligibleLanes(task.eligibleLanes, task.id);
  if (
    task.preferredLane !== undefined &&
    !isMember(ROUTING_LANES, task.preferredLane)
  ) {
    invalidTask(task.id, "preferredLane is invalid");
  }

  return {
    id: task.id,
    effortPoints: Number(task.effortPoints),
    risk: task.risk,
    authority: task.authority,
    kind: task.kind,
    dependencies,
    writeScopes,
    eligibleLanes,
    ...(task.preferredLane === undefined
      ? {}
      : { preferredLane: task.preferredLane }),
  };
}

function normalizeIdentifiers(
  value: unknown,
  label: string,
): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_COLLECTION_ITEMS) {
    invalidInput(
      `${label} must be an array with at most ${MAX_COLLECTION_ITEMS} entries`,
    );
  }
  const identifiers = value.map((entry) => {
    if (typeof entry !== "string" || !SAFE_IDENTIFIER.test(entry)) {
      invalidInput(`${label} contains an unsafe identifier`);
    }
    return entry;
  });
  if (new Set(identifiers).size !== identifiers.length) {
    invalidInput(`${label} must not contain duplicates`);
  }
  return identifiers.sort(compareText);
}

function normalizeWriteScopes(
  value: unknown,
  taskId: string,
): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_COLLECTION_ITEMS) {
    throw new SddRoutingError(
      SDD_ROUTING_ERROR_CODES.INVALID_WRITE_SCOPE,
      `Task ${taskId} writeScopes must be an array with at most ${MAX_COLLECTION_ITEMS} entries`,
    );
  }
  const scopes = value.map((entry) => normalizeWriteScope(entry, taskId));
  if (new Set(scopes).size !== scopes.length) {
    throw new SddRoutingError(
      SDD_ROUTING_ERROR_CODES.INVALID_WRITE_SCOPE,
      `Task ${taskId} writeScopes must not contain duplicates`,
    );
  }
  return scopes.sort(compareText);
}

function normalizeWriteScope(value: unknown, taskId: string): string {
  if (typeof value !== "string") {
    invalidWriteScope(taskId, "must be a string");
  }
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized === "" ||
    normalized === "." ||
    normalized.length > MAX_WRITE_SCOPE_CHARACTERS ||
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
    invalidWriteScope(taskId, "must be a safe repository-relative path");
  }
  return normalized;
}

function normalizeEligibleLanes(
  value: unknown,
  taskId: string,
): readonly RoutingLane[] {
  if (value === undefined) {
    return [...ROUTING_LANES];
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
    invalidTask(taskId, "eligibleLanes must contain one or two lanes");
  }
  if (!value.every((entry) => isMember(ROUTING_LANES, entry))) {
    invalidTask(taskId, "eligibleLanes contains an invalid lane");
  }
  const lanes = value;
  if (new Set(lanes).size !== lanes.length) {
    invalidTask(taskId, "eligibleLanes must not contain duplicates");
  }
  return ROUTING_LANES.filter((lane) => lanes.includes(lane));
}

function assertAcyclic(tasks: readonly NormalizedSddRoutingTask[]): void {
  const remainingDependencies = new Map(
    tasks.map((task) => [task.id, new Set(task.dependencies)] as const),
  );
  const completed = new Set<string>();

  while (completed.size < tasks.length) {
    const ready = tasks
      .filter(
        (task) =>
          !completed.has(task.id) &&
          [...(remainingDependencies.get(task.id) ?? [])].every((dependency) =>
            completed.has(dependency),
          ),
      )
      .map((task) => task.id);
    if (ready.length === 0) {
      const cyclic = tasks
        .map((task) => task.id)
        .filter((id) => !completed.has(id))
        .sort(compareText);
      throw new SddRoutingError(
        SDD_ROUTING_ERROR_CODES.DEPENDENCY_CYCLE,
        `Task dependency cycle detected among: ${cyclic.join(", ")}`,
      );
    }
    ready.forEach((id) => completed.add(id));
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
    invalidInput(`${label} contains unsupported fields: ${unknown.join(", ")}`);
  }
}

function requireRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidInput(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function isMember<const T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === "string" && values.some((entry) => entry === value);
}

function invalidInput(message: string): never {
  throw new SddRoutingError(SDD_ROUTING_ERROR_CODES.INVALID_INPUT, message);
}

function invalidTask(taskId: string, message: string): never {
  throw new SddRoutingError(
    SDD_ROUTING_ERROR_CODES.INVALID_TASK,
    `Task ${taskId} ${message}`,
  );
}

function invalidWriteScope(taskId: string, message: string): never {
  throw new SddRoutingError(
    SDD_ROUTING_ERROR_CODES.INVALID_WRITE_SCOPE,
    `Task ${taskId} write scope ${message}`,
  );
}
