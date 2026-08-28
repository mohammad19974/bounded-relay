import { isProtectedProposalPath } from "../../security/path-policy.js";
import { compareText, sha256CanonicalJson } from "./canonical.js";
import {
  SDD_EXECUTOR_DESCRIPTORS,
  executorIdForLane,
  type SddExecutorDescriptor,
} from "./executor-descriptors.js";
import { SDD_ROUTING_ERROR_CODES, SddRoutingError } from "./errors.js";
import {
  normalizeProjectProfile,
  projectProfileFingerprint,
  resolveCodexPolicy,
  resolveRequiredCheckProfiles,
  resolveTaskPolicy,
  type NormalizedSddCapabilityRequirement,
  type NormalizedSddCodexExecutionPolicy,
  type NormalizedSddProjectProfile,
  type SddProjectProfileInput,
} from "./project-profile.js";
import { routeSddTasks } from "./router.js";
import type {
  NormalizedSddRoutingTask,
  RoutingLane,
  SddRoutingInput,
  SddRoutingWave,
  TaskRisk,
} from "./types.js";

export const SDD_PROFILED_ROUTING_POLICY_VERSION = "sdd-routing-v3" as const;
export const SDD_CAPABILITY_FIT_POLICY_VERSION =
  "sdd-capability-fit-v1" as const;

export const PROFILED_ROUTING_SELECTION_ORDER = [
  "hard-eligibility",
  "capability-eligibility",
  "capability-fit",
  "preferred-lane-tie-break",
  "neutral-effort-balance",
  "neutral-task-count-balance",
  "odd-neutral-tie-to-codex",
  "lexical-task-id",
] as const;

export const PROFILED_ROUTE_REASON_CODES = [
  "HARD_ELIGIBILITY",
  "CAPABILITY_ELIGIBILITY",
  "CAPABILITY_FIT_SELECTED",
  "PREFERRED_LANE_TIE_BREAK",
  "PREFERRED_LANE_INELIGIBLE",
  "PREFERRED_LANE_OVERRIDDEN_BY_FIT",
  "NEUTRAL_EFFORT_BALANCE",
  "NEUTRAL_TASK_COUNT_BALANCE",
  "ODD_NEUTRAL_TIE_TO_CODEX",
  "LEXICAL_TIE_BREAK",
  "SINGLE_WRITER_WAVE",
  "REQUIRED_CHECK_PROFILES",
] as const;

export type ProfiledRouteReasonCode =
  (typeof PROFILED_ROUTE_REASON_CODES)[number];

export interface ProfiledRouteReason {
  readonly code: ProfiledRouteReasonCode;
  readonly message: string;
}

export const PROFILED_ROUTING_DECISION_STAGES = [
  "hard-eligibility",
  "capability-eligibility",
  "capability-fit",
  "preferred-lane-tie-break",
  "neutral-balance",
] as const;

export type ProfiledRoutingDecisionStage =
  (typeof PROFILED_ROUTING_DECISION_STAGES)[number];

export interface ProfiledSddRoutingInput extends SddRoutingInput {
  readonly projectProfile: SddProjectProfileInput;
}

export interface ProfiledCheckRequirement {
  readonly id: string;
  readonly cwd: string;
  readonly commandSha256: string;
}

export interface ProfiledCodexPolicy {
  readonly source: "project-profile";
  readonly purpose: "execution" | "cross-review";
  readonly model: string | null;
  readonly reasoningEffort:
    "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | null;
  readonly serverAllowlistRequired: boolean;
}

export interface ProfiledSddTaskAssignment {
  readonly taskId: string;
  readonly lane: RoutingLane;
  readonly executorId: SddExecutorDescriptor["id"];
  readonly wave: number;
  readonly selectedFitScore: number;
  readonly alternateFitScore?: number;
  readonly laneFit: Readonly<Record<RoutingLane, number>>;
  readonly decisionStage: ProfiledRoutingDecisionStage;
  readonly explicitEligibleLanes: readonly RoutingLane[];
  readonly effectiveEligibleLanes: readonly RoutingLane[];
  readonly capabilityRequirements: readonly NormalizedSddCapabilityRequirement[];
  readonly capabilityEligibility: Readonly<Record<RoutingLane, boolean>>;
  readonly requiredCheckProfiles: readonly ProfiledCheckRequirement[];
  readonly codexPolicy: ProfiledCodexPolicy;
  readonly reasons: readonly ProfiledRouteReason[];
}

export const PROFILED_ROUTING_DEVIATION_CODES = [
  "HARD_ELIGIBILITY",
  "CAPABILITY_ELIGIBILITY",
  "CAPABILITY_FIT_POLICY",
  "EFFORT_GRANULARITY",
] as const;

export type ProfiledRoutingDeviationCode =
  (typeof PROFILED_ROUTING_DEVIATION_CODES)[number];

export interface ProfiledRoutingDeviation {
  readonly code: ProfiledRoutingDeviationCode;
  readonly message: string;
}

export interface ProfiledRoutingBalance {
  readonly neutralCodexShareBps: number;
  readonly actualCodexShareBps: number;
  readonly absoluteEffortDeviationBps: number;
  readonly totalEffortPoints: number;
  readonly effortPoints: Readonly<Record<RoutingLane, number>>;
  readonly taskCount: Readonly<Record<RoutingLane, number>>;
  readonly totalWeightedFitScore: number;
  readonly decisionCounts: Readonly<
    Record<ProfiledRoutingDecisionStage, number>
  >;
  readonly deviations: readonly ProfiledRoutingDeviation[];
}

export interface ProfiledSddRoutingPlan {
  readonly schemaVersion: 2;
  readonly routingPolicyVersion: typeof SDD_PROFILED_ROUTING_POLICY_VERSION;
  readonly fitPolicyVersion: typeof SDD_CAPABILITY_FIT_POLICY_VERSION;
  readonly selectionOrder: typeof PROFILED_ROUTING_SELECTION_ORDER;
  readonly projectProfile: {
    readonly schemaVersion: 1;
    readonly profileId: string;
    readonly profileVersion: string;
    readonly profileFingerprint: string;
  };
  readonly executors: readonly SddExecutorDescriptor[];
  readonly crossReviewPolicy: ProfiledCodexPolicy;
  readonly planFingerprint: string;
  readonly reasons: readonly ProfiledRouteReason[];
  readonly tasks: readonly NormalizedSddRoutingTask[];
  readonly assignments: readonly ProfiledSddTaskAssignment[];
  readonly waves: readonly SddRoutingWave[];
  readonly balance: ProfiledRoutingBalance;
}

interface EvaluatedTask {
  readonly task: NormalizedSddRoutingTask;
  readonly requirements: readonly NormalizedSddCapabilityRequirement[];
  readonly fit: Readonly<Record<RoutingLane, number>>;
  readonly capabilityEligibility: Readonly<Record<RoutingLane, boolean>>;
  readonly effectiveEligibleLanes: readonly RoutingLane[];
  readonly requiredChecks: readonly ProfiledCheckRequirement[];
  readonly codexPolicy: NormalizedSddCodexExecutionPolicy;
}

interface RoutingState {
  readonly codexEffort: number;
  readonly codexCount: number;
  readonly fitScore: number;
  readonly codexMask: bigint;
}

interface RoutingSelection {
  readonly state: RoutingState;
  readonly stages: readonly ProfiledRoutingDecisionStage[];
  readonly oddTieToCodex: boolean;
}

const INPUT_KEYS = new Set(["tasks", "neutralCodexShareBps", "projectProfile"]);

const REASON_MESSAGES: Readonly<Record<ProfiledRouteReasonCode, string>> = {
  HARD_ELIGIBILITY: "The task declares only one eligible lane.",
  CAPABILITY_ELIGIBILITY:
    "Declared capability minimums leave only one eligible lane.",
  CAPABILITY_FIT_SELECTED:
    "The selected lane has the stronger weighted capability fit.",
  PREFERRED_LANE_TIE_BREAK:
    "The eligible preferred lane resolves an equal capability fit.",
  PREFERRED_LANE_INELIGIBLE:
    "The preferred lane is excluded by explicit or capability eligibility.",
  PREFERRED_LANE_OVERRIDDEN_BY_FIT:
    "The stronger weighted capability fit overrides the soft lane preference.",
  NEUTRAL_EFFORT_BALANCE:
    "The task is capability-fit neutral, so the soft effort share is used.",
  NEUTRAL_TASK_COUNT_BALANCE:
    "Task-count share resolves a remaining capability-neutral tie.",
  ODD_NEUTRAL_TIE_TO_CODEX:
    "A true 50/50 odd neutral tie gives the extra task to Codex.",
  LEXICAL_TIE_BREAK:
    "Canonical task-id order is the final deterministic tie-break.",
  SINGLE_WRITER_WAVE:
    "Write tasks are serialized so each dependency wave has at most one writer.",
  REQUIRED_CHECK_PROFILES:
    "The project profile binds required checks to canonical command digests.",
};

export function routeProfiledSddTasks(
  input: ProfiledSddRoutingInput,
): ProfiledSddRoutingPlan {
  const inputRecord = requireRecord(input, "profiled routing input");
  assertKnownKeys(inputRecord, INPUT_KEYS, "profiled routing input");
  if (inputRecord.projectProfile === undefined) {
    throw new SddRoutingError(
      SDD_ROUTING_ERROR_CODES.INVALID_INPUT,
      "profiled routing input requires projectProfile",
    );
  }

  // The legacy router remains the authoritative validator and normalizer for
  // the established task graph. Passing only legacy keys preserves its public
  // behavior and fingerprint contract.
  const legacy = routeSddTasks({
    tasks: input.tasks,
    ...(input.neutralCodexShareBps === undefined
      ? {}
      : { neutralCodexShareBps: input.neutralCodexShareBps }),
  });
  const profile = normalizeProjectProfile(input.projectProfile);
  const profileFingerprint = projectProfileFingerprint(profile);
  const evaluated = legacy.tasks.map((task) => evaluateTask(task, profile));
  const selection = selectAssignments(
    evaluated,
    legacy.balance.neutralCodexShareBps,
  );
  const waveByTask = new Map(
    legacy.waves.flatMap((wave) =>
      wave.taskIds.map((taskId) => [taskId, wave.wave] as const),
    ),
  );
  const assignments = evaluated.map((evaluatedTask, index) => {
    const lane = laneAt(selection.state.codexMask, index);
    const wave = waveByTask.get(evaluatedTask.task.id);
    const stage = selection.stages[index];
    if (wave === undefined || stage === undefined) {
      throw new SddRoutingError(
        SDD_ROUTING_ERROR_CODES.INVALID_TASK,
        `Task ${evaluatedTask.task.id} has incomplete profiled routing evidence`,
      );
    }
    return makeAssignment(evaluatedTask, lane, wave, stage);
  });
  const balance = makeBalance(
    evaluated,
    selection.state,
    legacy.balance.neutralCodexShareBps,
    selection.stages,
  );
  const reasons = makePlanReasons(
    evaluated,
    selection.stages,
    selection.oddTieToCodex,
  );
  const projectProfile = {
    schemaVersion: 1 as const,
    profileId: profile.profileId,
    profileVersion: profile.profileVersion,
    profileFingerprint,
  };
  const crossReviewPolicy = makeProfiledCodexPolicy(
    resolveCodexPolicy(profile, {
      kind: "review",
      risk: highestTaskRisk(legacy.tasks),
    }),
    "cross-review",
  );
  const fingerprintPayload = {
    schemaVersion: 2,
    routingPolicyVersion: SDD_PROFILED_ROUTING_POLICY_VERSION,
    fitPolicyVersion: SDD_CAPABILITY_FIT_POLICY_VERSION,
    selectionOrder: PROFILED_ROUTING_SELECTION_ORDER,
    projectProfile,
    executors: SDD_EXECUTOR_DESCRIPTORS,
    crossReviewPolicy,
    neutralCodexShareBps: legacy.balance.neutralCodexShareBps,
    tasks: legacy.tasks,
    assignments: assignments.map((assignment) => ({
      taskId: assignment.taskId,
      lane: assignment.lane,
      executorId: assignment.executorId,
      wave: assignment.wave,
      laneFit: assignment.laneFit,
      decisionStage: assignment.decisionStage,
      explicitEligibleLanes: assignment.explicitEligibleLanes,
      effectiveEligibleLanes: assignment.effectiveEligibleLanes,
      capabilityRequirements: assignment.capabilityRequirements,
      capabilityEligibility: assignment.capabilityEligibility,
      requiredCheckProfiles: assignment.requiredCheckProfiles,
      codexPolicy: assignment.codexPolicy,
      reasonCodes: assignment.reasons.map((entry) => entry.code),
    })),
    waves: legacy.waves,
    reasonCodes: reasons.map((entry) => entry.code),
  };

  return {
    schemaVersion: 2,
    routingPolicyVersion: SDD_PROFILED_ROUTING_POLICY_VERSION,
    fitPolicyVersion: SDD_CAPABILITY_FIT_POLICY_VERSION,
    selectionOrder: PROFILED_ROUTING_SELECTION_ORDER,
    projectProfile,
    executors: SDD_EXECUTOR_DESCRIPTORS,
    crossReviewPolicy,
    planFingerprint: sha256CanonicalJson(fingerprintPayload),
    reasons,
    tasks: legacy.tasks,
    assignments,
    waves: legacy.waves,
    balance,
  };
}

function evaluateTask(
  task: NormalizedSddRoutingTask,
  profile: NormalizedSddProjectProfile,
): EvaluatedTask {
  const policy = resolveTaskPolicy(profile, task.kind);
  const capabilities = new Map(
    profile.capabilities.map((entry) => [entry.id, entry]),
  );
  const fit: Record<RoutingLane, number> = { codex: 0, "claude-host": 0 };
  const capabilityEligibility: Record<RoutingLane, boolean> = {
    codex: true,
    "claude-host": true,
  };
  for (const lane of ["codex", "claude-host"] as const) {
    for (const requirement of policy.requirements) {
      const capability = capabilities.get(requirement.capabilityId);
      if (capability === undefined) {
        throw new SddRoutingError(
          SDD_ROUTING_ERROR_CODES.UNKNOWN_CAPABILITY,
          `Task ${task.id} references unknown capability ${requirement.capabilityId}`,
        );
      }
      const score = capability.scores[lane];
      fit[lane] += score * requirement.weight;
      if (score < requirement.minimumScore) {
        capabilityEligibility[lane] = false;
      }
    }
  }
  const effectiveEligibleLanes = task.eligibleLanes.filter(
    (lane) => capabilityEligibility[lane],
  );
  if (effectiveEligibleLanes.length === 0) {
    throw new SddRoutingError(
      SDD_ROUTING_ERROR_CODES.NO_ELIGIBLE_LANE,
      `Task ${task.id} has no lane satisfying explicit eligibility and capability minimums`,
    );
  }
  validateWritePolicy(task, profile);
  return {
    task,
    requirements: policy.requirements,
    fit,
    capabilityEligibility,
    effectiveEligibleLanes,
    requiredChecks:
      task.authority === "write"
        ? resolveRequiredCheckProfiles(profile, task).map(
            ({ id, cwd, commandSha256 }) => ({ id, cwd, commandSha256 }),
          )
        : [],
    codexPolicy: resolveCodexPolicy(profile, task),
  };
}

function validateWritePolicy(
  task: NormalizedSddRoutingTask,
  profile: NormalizedSddProjectProfile,
): void {
  if (task.authority !== "write") {
    return;
  }
  if (profile.writePolicy.allowedRoots.length === 0) {
    throw new SddRoutingError(
      SDD_ROUTING_ERROR_CODES.WRITE_POLICY_VIOLATION,
      `Write task ${task.id} cannot run because the project profile has no allowed write roots`,
    );
  }
  for (const scope of task.writeScopes) {
    if (isProtectedProposalPath(scope)) {
      throw new SddRoutingError(
        SDD_ROUTING_ERROR_CODES.WRITE_POLICY_VIOLATION,
        `Write task ${task.id} targets a BoundedRelay-protected path: ${scope}`,
      );
    }
    if (
      !profile.writePolicy.allowedRoots.some((root) => pathInside(root, scope))
    ) {
      throw new SddRoutingError(
        SDD_ROUTING_ERROR_CODES.WRITE_POLICY_VIOLATION,
        `Write task ${task.id} scope is outside projectProfile allowed roots: ${scope}`,
      );
    }
    if (
      profile.writePolicy.additionalDeniedRoots.some((root) =>
        pathsOverlap(root, scope),
      )
    ) {
      throw new SddRoutingError(
        SDD_ROUTING_ERROR_CODES.WRITE_POLICY_VIOLATION,
        `Write task ${task.id} scope overlaps a projectProfile denied root: ${scope}`,
      );
    }
  }
}

function selectAssignments(
  tasks: readonly EvaluatedTask[],
  neutralCodexShareBps: number,
): RoutingSelection {
  const stages: ProfiledRoutingDecisionStage[] = [];
  let initial: RoutingState = {
    codexEffort: 0,
    codexCount: 0,
    fitScore: 0,
    codexMask: 0n,
  };
  const neutralIndexes: number[] = [];

  tasks.forEach((entry, index) => {
    let lane: RoutingLane | undefined;
    if (entry.task.eligibleLanes.length === 1) {
      lane = requiredLane(entry.effectiveEligibleLanes, entry.task.id);
      stages[index] = "hard-eligibility";
    } else if (entry.effectiveEligibleLanes.length === 1) {
      lane = requiredLane(entry.effectiveEligibleLanes, entry.task.id);
      stages[index] = "capability-eligibility";
    } else if (entry.fit.codex !== entry.fit["claude-host"]) {
      lane =
        entry.fit.codex > entry.fit["claude-host"] ? "codex" : "claude-host";
      stages[index] = "capability-fit";
    } else if (
      entry.task.preferredLane !== undefined &&
      entry.effectiveEligibleLanes.includes(entry.task.preferredLane)
    ) {
      lane = entry.task.preferredLane;
      stages[index] = "preferred-lane-tie-break";
    } else {
      neutralIndexes.push(index);
      stages[index] = "neutral-balance";
    }
    if (lane !== undefined) {
      initial = assignLane(initial, entry, lane, index);
    }
  });

  let states = new Map<number, RoutingState>([
    [stateKey(initial.codexEffort, initial.codexCount), initial],
  ]);
  for (const index of neutralIndexes) {
    const entry = tasks[index];
    if (entry === undefined) {
      throw new SddRoutingError(
        SDD_ROUTING_ERROR_CODES.INVALID_TASK,
        "Profiled routing referenced a missing task",
      );
    }
    const next = new Map<number, RoutingState>();
    for (const state of states.values()) {
      for (const lane of entry.effectiveEligibleLanes) {
        setBestEquivalentState(
          next,
          assignLane(state, entry, lane, index),
          tasks.length,
        );
      }
    }
    states = next;
  }

  const totalEffort = tasks.reduce(
    (total, entry) => total + entry.task.effortPoints,
    0,
  );
  let selected: RoutingState | undefined;
  for (const candidate of states.values()) {
    if (
      selected === undefined ||
      compareFinalStates(
        candidate,
        selected,
        totalEffort,
        tasks.length,
        neutralCodexShareBps,
      ) < 0
    ) {
      selected = candidate;
    }
  }
  if (selected === undefined) {
    throw new SddRoutingError(
      SDD_ROUTING_ERROR_CODES.NO_ELIGIBLE_LANE,
      "No valid profiled task assignment exists",
    );
  }
  const selectedEffortError = balanceError(
    selected.codexEffort,
    totalEffort,
    neutralCodexShareBps,
  );
  const selectedCountError = balanceError(
    selected.codexCount,
    tasks.length,
    neutralCodexShareBps,
  );
  const oddTieToCodex =
    neutralCodexShareBps === 5_000 &&
    tasks.length % 2 === 1 &&
    states.size > 1 &&
    [...states.values()].some(
      (candidate) =>
        candidate.codexCount < selected.codexCount &&
        balanceError(
          candidate.codexEffort,
          totalEffort,
          neutralCodexShareBps,
        ) === selectedEffortError &&
        balanceError(
          candidate.codexCount,
          tasks.length,
          neutralCodexShareBps,
        ) === selectedCountError,
    );
  return { state: selected, stages, oddTieToCodex };
}

function assignLane(
  state: RoutingState,
  entry: EvaluatedTask,
  lane: RoutingLane,
  index: number,
): RoutingState {
  const codex = lane === "codex";
  return {
    codexEffort: state.codexEffort + (codex ? entry.task.effortPoints : 0),
    codexCount: state.codexCount + (codex ? 1 : 0),
    fitScore: state.fitScore + entry.fit[lane] * entry.task.effortPoints,
    codexMask: codex
      ? state.codexMask | (1n << BigInt(index))
      : state.codexMask,
  };
}

function setBestEquivalentState(
  states: Map<number, RoutingState>,
  candidate: RoutingState,
  taskCount: number,
): void {
  const key = stateKey(candidate.codexEffort, candidate.codexCount);
  const current = states.get(key);
  if (
    current === undefined ||
    candidate.fitScore > current.fitScore ||
    (candidate.fitScore === current.fitScore &&
      compareMasks(candidate.codexMask, current.codexMask, taskCount) < 0)
  ) {
    states.set(key, candidate);
  }
}

function compareFinalStates(
  left: RoutingState,
  right: RoutingState,
  totalEffort: number,
  totalTasks: number,
  neutralCodexShareBps: number,
): number {
  const effortDifference =
    balanceError(left.codexEffort, totalEffort, neutralCodexShareBps) -
    balanceError(right.codexEffort, totalEffort, neutralCodexShareBps);
  if (effortDifference !== 0) {
    return effortDifference;
  }
  const countDifference =
    balanceError(left.codexCount, totalTasks, neutralCodexShareBps) -
    balanceError(right.codexCount, totalTasks, neutralCodexShareBps);
  if (countDifference !== 0) {
    return countDifference;
  }
  if (
    neutralCodexShareBps === 5_000 &&
    totalTasks % 2 === 1 &&
    left.codexCount !== right.codexCount
  ) {
    return right.codexCount - left.codexCount;
  }
  return compareMasks(left.codexMask, right.codexMask, totalTasks);
}

function compareMasks(left: bigint, right: bigint, taskCount: number): number {
  for (let index = 0; index < taskCount; index += 1) {
    const leftCodex = hasBit(left, index);
    const rightCodex = hasBit(right, index);
    if (leftCodex !== rightCodex) {
      return leftCodex ? 1 : -1;
    }
  }
  return 0;
}

function makeAssignment(
  entry: EvaluatedTask,
  lane: RoutingLane,
  wave: number,
  decisionStage: ProfiledRoutingDecisionStage,
): ProfiledSddTaskAssignment {
  const reasons: ProfiledRouteReason[] = [];
  if (decisionStage === "hard-eligibility") {
    reasons.push(reason("HARD_ELIGIBILITY"));
  } else if (decisionStage === "capability-eligibility") {
    reasons.push(reason("CAPABILITY_ELIGIBILITY"));
  } else if (decisionStage === "capability-fit") {
    reasons.push(reason("CAPABILITY_FIT_SELECTED"));
  } else if (decisionStage === "preferred-lane-tie-break") {
    reasons.push(reason("PREFERRED_LANE_TIE_BREAK"));
  } else {
    reasons.push(reason("NEUTRAL_EFFORT_BALANCE"));
    reasons.push(reason("NEUTRAL_TASK_COUNT_BALANCE"));
  }
  if (
    entry.task.preferredLane !== undefined &&
    !entry.effectiveEligibleLanes.includes(entry.task.preferredLane)
  ) {
    reasons.push(reason("PREFERRED_LANE_INELIGIBLE"));
  } else if (
    decisionStage === "capability-fit" &&
    entry.task.preferredLane !== undefined &&
    entry.task.preferredLane !== lane
  ) {
    reasons.push(reason("PREFERRED_LANE_OVERRIDDEN_BY_FIT"));
  }
  if (entry.task.authority === "write") {
    reasons.push(reason("SINGLE_WRITER_WAVE"));
  }
  if (entry.requiredChecks.length > 0) {
    reasons.push(reason("REQUIRED_CHECK_PROFILES"));
  }
  return {
    taskId: entry.task.id,
    lane,
    executorId: executorIdForLane(lane),
    wave,
    selectedFitScore: entry.fit[lane],
    ...(entry.effectiveEligibleLanes.length === 2
      ? {
          alternateFitScore:
            entry.fit[lane === "codex" ? "claude-host" : "codex"],
        }
      : {}),
    laneFit: {
      codex: entry.fit.codex,
      "claude-host": entry.fit["claude-host"],
    },
    decisionStage,
    explicitEligibleLanes: entry.task.eligibleLanes,
    effectiveEligibleLanes: entry.effectiveEligibleLanes,
    capabilityRequirements: entry.requirements,
    capabilityEligibility: {
      codex: entry.capabilityEligibility.codex,
      "claude-host": entry.capabilityEligibility["claude-host"],
    },
    requiredCheckProfiles: entry.requiredChecks,
    codexPolicy: makeProfiledCodexPolicy(
      entry.codexPolicy,
      lane === "codex" ? "execution" : "cross-review",
    ),
    reasons,
  };
}

function makeBalance(
  tasks: readonly EvaluatedTask[],
  selected: RoutingState,
  neutralCodexShareBps: number,
  stages: readonly ProfiledRoutingDecisionStage[],
): ProfiledRoutingBalance {
  const totalEffortPoints = tasks.reduce(
    (total, entry) => total + entry.task.effortPoints,
    0,
  );
  const exactError = balanceError(
    selected.codexEffort,
    totalEffortPoints,
    neutralCodexShareBps,
  );
  const unconstrainedError = minimumError(
    tasks,
    () => ["codex", "claude-host"],
    neutralCodexShareBps,
  );
  const explicitError = minimumError(
    tasks,
    (entry) => entry.task.eligibleLanes,
    neutralCodexShareBps,
  );
  const capableError = minimumError(
    tasks,
    (entry) => entry.effectiveEligibleLanes,
    neutralCodexShareBps,
  );
  const deviations: ProfiledRoutingDeviation[] = [];
  if (explicitError > unconstrainedError) {
    deviations.push({
      code: "HARD_ELIGIBILITY",
      message:
        "Explicit lane eligibility prevents the closest unconstrained neutral split.",
    });
  }
  if (capableError > explicitError) {
    deviations.push({
      code: "CAPABILITY_ELIGIBILITY",
      message:
        "Capability minimums prevent the closest explicitly eligible neutral split.",
    });
  }
  if (exactError > capableError) {
    deviations.push({
      code: "CAPABILITY_FIT_POLICY",
      message:
        "Weighted capability fit or a fit-tie preference takes priority over the soft neutral target.",
    });
  }
  if (unconstrainedError > 0) {
    deviations.push({
      code: "EFFORT_GRANULARITY",
      message:
        "Integer task effort cannot represent the configured target exactly.",
    });
  }
  return {
    neutralCodexShareBps,
    actualCodexShareBps: Math.round(
      (selected.codexEffort * 10_000) / totalEffortPoints,
    ),
    absoluteEffortDeviationBps: Math.round(exactError / totalEffortPoints),
    totalEffortPoints,
    effortPoints: {
      codex: selected.codexEffort,
      "claude-host": totalEffortPoints - selected.codexEffort,
    },
    taskCount: {
      codex: selected.codexCount,
      "claude-host": tasks.length - selected.codexCount,
    },
    totalWeightedFitScore: selected.fitScore,
    decisionCounts: countStages(stages),
    deviations,
  };
}

function minimumError(
  tasks: readonly EvaluatedTask[],
  lanesFor: (entry: EvaluatedTask) => readonly RoutingLane[],
  neutralCodexShareBps: number,
): number {
  let reachable = new Set([0]);
  for (const entry of tasks) {
    const next = new Set<number>();
    for (const effort of reachable) {
      for (const lane of lanesFor(entry)) {
        next.add(effort + (lane === "codex" ? entry.task.effortPoints : 0));
      }
    }
    reachable = next;
  }
  const total = tasks.reduce((sum, entry) => sum + entry.task.effortPoints, 0);
  return Math.min(
    ...[...reachable].map((effort) =>
      balanceError(effort, total, neutralCodexShareBps),
    ),
  );
}

function makePlanReasons(
  tasks: readonly EvaluatedTask[],
  stages: readonly ProfiledRoutingDecisionStage[],
  oddTieToCodex: boolean,
): readonly ProfiledRouteReason[] {
  const reasons: ProfiledRouteReason[] = [];
  if (stages.includes("hard-eligibility")) {
    reasons.push(reason("HARD_ELIGIBILITY"));
  }
  if (stages.includes("capability-eligibility")) {
    reasons.push(reason("CAPABILITY_ELIGIBILITY"));
  }
  if (stages.includes("capability-fit")) {
    reasons.push(reason("CAPABILITY_FIT_SELECTED"));
  }
  if (stages.includes("preferred-lane-tie-break")) {
    reasons.push(reason("PREFERRED_LANE_TIE_BREAK"));
  }
  if (stages.includes("neutral-balance")) {
    reasons.push(reason("NEUTRAL_EFFORT_BALANCE"));
    reasons.push(reason("NEUTRAL_TASK_COUNT_BALANCE"));
  }
  if (oddTieToCodex) {
    reasons.push(reason("ODD_NEUTRAL_TIE_TO_CODEX"));
  }
  reasons.push(reason("LEXICAL_TIE_BREAK"));
  if (tasks.some((entry) => entry.task.authority === "write")) {
    reasons.push(reason("SINGLE_WRITER_WAVE"));
  }
  if (tasks.some((entry) => entry.requiredChecks.length > 0)) {
    reasons.push(reason("REQUIRED_CHECK_PROFILES"));
  }
  return reasons;
}

function countStages(
  stages: readonly ProfiledRoutingDecisionStage[],
): Readonly<Record<ProfiledRoutingDecisionStage, number>> {
  return {
    "hard-eligibility": stages.filter((stage) => stage === "hard-eligibility")
      .length,
    "capability-eligibility": stages.filter(
      (stage) => stage === "capability-eligibility",
    ).length,
    "capability-fit": stages.filter((stage) => stage === "capability-fit")
      .length,
    "preferred-lane-tie-break": stages.filter(
      (stage) => stage === "preferred-lane-tie-break",
    ).length,
    "neutral-balance": stages.filter((stage) => stage === "neutral-balance")
      .length,
  };
}

function requiredLane(
  lanes: readonly RoutingLane[],
  taskId: string,
): RoutingLane {
  const lane = lanes[0];
  if (lane === undefined) {
    throw new SddRoutingError(
      SDD_ROUTING_ERROR_CODES.NO_ELIGIBLE_LANE,
      `Task ${taskId} has no eligible lane`,
    );
  }
  return lane;
}

function pathInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function pathsOverlap(left: string, right: string): boolean {
  return pathInside(left, right) || pathInside(right, left);
}

function makeProfiledCodexPolicy(
  policy: NormalizedSddCodexExecutionPolicy,
  purpose: ProfiledCodexPolicy["purpose"],
): ProfiledCodexPolicy {
  return {
    source: "project-profile",
    purpose,
    model: policy.model,
    reasoningEffort: policy.reasoningEffort,
    serverAllowlistRequired: policy.model !== null,
  };
}

function highestTaskRisk(tasks: readonly NormalizedSddRoutingTask[]): TaskRisk {
  const priority: Readonly<Record<TaskRisk, number>> = {
    low: 0,
    medium: 1,
    high: 2,
    critical: 3,
  };
  return tasks.reduce<TaskRisk>(
    (highest, task) =>
      priority[task.risk] > priority[highest] ? task.risk : highest,
    "low",
  );
}

function laneAt(mask: bigint, index: number): RoutingLane {
  return hasBit(mask, index) ? "codex" : "claude-host";
}

function hasBit(mask: bigint, index: number): boolean {
  return (mask & (1n << BigInt(index))) !== 0n;
}

function stateKey(codexEffort: number, codexCount: number): number {
  return codexEffort * 65 + codexCount;
}

function balanceError(
  codexEffort: number,
  totalEffort: number,
  neutralCodexShareBps: number,
): number {
  return Math.abs(codexEffort * 10_000 - totalEffort * neutralCodexShareBps);
}

function reason(code: ProfiledRouteReasonCode): ProfiledRouteReason {
  return { code, message: REASON_MESSAGES[code] };
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
    throw new SddRoutingError(
      SDD_ROUTING_ERROR_CODES.INVALID_INPUT,
      `${label} contains unsupported fields: ${unknown.join(", ")}`,
    );
  }
}

function requireRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SddRoutingError(
      SDD_ROUTING_ERROR_CODES.INVALID_INPUT,
      `${label} must be an object`,
    );
  }
  return value as Readonly<Record<string, unknown>>;
}
