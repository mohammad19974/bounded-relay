import { compareText, sha256CanonicalJson } from "./canonical.js";
import { SDD_ROUTING_ERROR_CODES, SddRoutingError } from "./errors.js";
import {
  SDD_ROUTING_POLICY_VERSION,
  SDD_FIT_POLICY_VERSION,
  type NormalizedSddRoutingTask,
  type RouteReason,
  type RouteReasonCode,
  type RoutingBalance,
  type RoutingDeviation,
  type RoutingDecisionStage,
  type RoutingLane,
  type SddRoutingInput,
  type SddRoutingPlan,
  type SddRoutingWave,
  type SddTaskAssignment,
  type TaskKind,
  type TaskLaneFit,
} from "./types.js";
import { normalizeRoutingInput } from "./validation.js";

interface RoutingState {
  readonly codexEffort: number;
  readonly codexCount: number;
  readonly fitScore: number;
  readonly codexMask: bigint;
}

interface RoutingSelection {
  readonly state: RoutingState;
  readonly fits: readonly TaskLaneFit[];
  readonly decisionStages: readonly RoutingDecisionStage[];
  readonly oddTieToCodex: boolean;
}

const SELECTION_ORDER = [
  "hard-eligibility",
  "quality-fit",
  "preferred-lane-tie-break",
  "neutral-effort-balance",
  "neutral-task-count-balance",
  "odd-neutral-tie-to-codex",
  "lexical-task-id",
] as const;

const KIND_FIT: Readonly<Record<TaskKind, TaskLaneFit>> = {
  analysis: { codex: 3, claudeHost: 3 },
  planning: { codex: 1, claudeHost: 4 },
  architecture: { codex: 2, claudeHost: 4 },
  implementation: { codex: 4, claudeHost: 2 },
  debugging: { codex: 4, claudeHost: 2 },
  testing: { codex: 4, claudeHost: 2 },
  refactor: { codex: 4, claudeHost: 2 },
  review: { codex: 3, claudeHost: 3 },
  "security-review": { codex: 3, claudeHost: 3 },
  documentation: { codex: 2, claudeHost: 4 },
  integration: { codex: 3, claudeHost: 3 },
};

const REASON_MESSAGES: Readonly<Record<RouteReasonCode, string>> = {
  HARD_ELIGIBILITY: "The task can run on only one eligible lane.",
  QUALITY_FIT_SELECTED:
    "The selected lane has the stronger versioned task-kind fit score.",
  PREFERRED_LANE_TIE_BREAK:
    "The eligible preferred lane resolves an otherwise equal task-kind fit.",
  PREFERRED_LANE_INELIGIBLE:
    "The preferred lane is ineligible, so hard eligibility overrides it.",
  PREFERRED_LANE_OVERRIDDEN_BY_FIT:
    "The stronger versioned task-kind fit overrides the soft lane preference.",
  NEUTRAL_EFFORT_BALANCE:
    "The task is fit-neutral, so the soft estimated-effort share is used.",
  NEUTRAL_TASK_COUNT_BALANCE:
    "Task-count share resolves a remaining tie between fit-neutral plans.",
  ODD_NEUTRAL_TIE_TO_CODEX:
    "A true 50/50 odd neutral tie gives the extra task to Codex.",
  LEXICAL_TIE_BREAK:
    "Canonical task-id order is the final deterministic tie-break.",
  SINGLE_WRITER_WAVE:
    "Write tasks are serialized so each dependency wave has at most one writer.",
};

export function routeSddTasks(input: SddRoutingInput): SddRoutingPlan {
  const normalized = normalizeRoutingInput(input);
  const selection = selectAssignments(
    normalized.tasks,
    normalized.neutralCodexShareBps,
  );
  const waves = buildWaves(normalized.tasks);
  const waveByTask = new Map(
    waves.flatMap((wave) =>
      wave.taskIds.map((taskId) => [taskId, wave.wave] as const),
    ),
  );
  const assignments = normalized.tasks.map((task, index) => {
    const lane = laneAt(selection.state.codexMask, index);
    const wave = waveByTask.get(task.id);
    if (wave === undefined) {
      throw new SddRoutingError(
        SDD_ROUTING_ERROR_CODES.DEPENDENCY_CYCLE,
        `Task ${task.id} was not scheduled`,
      );
    }
    return makeAssignment(
      task,
      lane,
      wave,
      selection.fits[index],
      selection.decisionStages[index],
    );
  });
  const balance = makeBalance(
    normalized.tasks,
    selection.state,
    normalized.neutralCodexShareBps,
    selection.decisionStages,
  );
  const reasons = makePlanReasons(
    normalized.tasks,
    selection.decisionStages,
    selection.oddTieToCodex,
  );
  const fingerprintPayload = {
    schemaVersion: 1,
    routingPolicyVersion: SDD_ROUTING_POLICY_VERSION,
    fitPolicyVersion: SDD_FIT_POLICY_VERSION,
    neutralCodexShareBps: normalized.neutralCodexShareBps,
    selectionOrder: SELECTION_ORDER,
    tasks: normalized.tasks,
    assignments: assignments.map((assignment) => ({
      taskId: assignment.taskId,
      lane: assignment.lane,
      wave: assignment.wave,
      decisionStage: assignment.decisionStage,
      laneFit: assignment.laneFit,
      reasonCodes: assignment.reasons.map((reason) => reason.code),
    })),
    waves,
    reasonCodes: reasons.map((reason) => reason.code),
  };

  return {
    schemaVersion: 1,
    routingPolicyVersion: SDD_ROUTING_POLICY_VERSION,
    fitPolicyVersion: SDD_FIT_POLICY_VERSION,
    selectionOrder: SELECTION_ORDER,
    planFingerprint: sha256CanonicalJson(fingerprintPayload),
    reasons,
    tasks: normalized.tasks,
    assignments,
    waves,
    balance,
  };
}

function selectAssignments(
  tasks: readonly NormalizedSddRoutingTask[],
  neutralCodexShareBps: number,
): RoutingSelection {
  const fits = tasks.map(taskFit);
  const decisionStages: RoutingDecisionStage[] = [];
  let initial: RoutingState = {
    codexEffort: 0,
    codexCount: 0,
    fitScore: 0,
    codexMask: 0n,
  };
  const neutralIndexes: number[] = [];

  tasks.forEach((task, index) => {
    const fit = fits[index];
    if (fit === undefined) {
      throw new SddRoutingError(
        SDD_ROUTING_ERROR_CODES.INVALID_TASK,
        `Task ${task.id} has no fit score`,
      );
    }
    if (task.eligibleLanes.length === 1) {
      const lane = task.eligibleLanes[0];
      if (lane === undefined) {
        throw new SddRoutingError(
          SDD_ROUTING_ERROR_CODES.INVALID_TASK,
          `Task ${task.id} has no eligible lane`,
        );
      }
      initial = assignLane(initial, task, fit, lane, index);
      decisionStages[index] = "hard-eligibility";
    } else if (fit.codex !== fit.claudeHost) {
      const lane = fit.codex > fit.claudeHost ? "codex" : "claude-host";
      initial = assignLane(initial, task, fit, lane, index);
      decisionStages[index] = "quality-fit";
    } else if (task.preferredLane !== undefined) {
      initial = assignLane(initial, task, fit, task.preferredLane, index);
      decisionStages[index] = "preferred-lane-tie-break";
    } else {
      neutralIndexes.push(index);
      decisionStages[index] = "neutral-balance";
    }
  });

  let states = new Map<number, RoutingState>([
    [stateKey(initial.codexEffort, initial.codexCount), initial],
  ]);
  for (const index of neutralIndexes) {
    const task = tasks[index];
    const fit = fits[index];
    if (task === undefined || fit === undefined) {
      throw new SddRoutingError(
        SDD_ROUTING_ERROR_CODES.INVALID_TASK,
        "Routing state referenced a missing task",
      );
    }
    const next = new Map<number, RoutingState>();
    for (const state of states.values()) {
      setBestEquivalentState(
        next,
        assignLane(state, task, fit, "claude-host", index),
        tasks.length,
      );
      setBestEquivalentState(
        next,
        assignLane(state, task, fit, "codex", index),
        tasks.length,
      );
    }
    states = next;
  }

  const totalEffort = tasks.reduce(
    (total, task) => total + task.effortPoints,
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
      SDD_ROUTING_ERROR_CODES.INVALID_TASK,
      "No valid task assignment exists",
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
  return {
    state: selected,
    fits,
    decisionStages,
    oddTieToCodex,
  };
}

function assignLane(
  state: RoutingState,
  task: NormalizedSddRoutingTask,
  fit: TaskLaneFit | undefined,
  lane: RoutingLane,
  index: number,
): RoutingState {
  if (fit === undefined) {
    throw new SddRoutingError(
      SDD_ROUTING_ERROR_CODES.INVALID_TASK,
      `Task ${task.id} has no fit score`,
    );
  }
  const codex = lane === "codex";
  return {
    codexEffort: state.codexEffort + (codex ? task.effortPoints : 0),
    codexCount: state.codexCount + (codex ? 1 : 0),
    fitScore: state.fitScore + laneFit(fit, lane) * task.effortPoints,
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
      // `claude-host` sorts before `codex`; task ids are already canonical.
      return leftCodex ? 1 : -1;
    }
  }
  return 0;
}

function makeAssignment(
  task: NormalizedSddRoutingTask,
  lane: RoutingLane,
  wave: number,
  fit: TaskLaneFit | undefined,
  decisionStage: RoutingDecisionStage | undefined,
): SddTaskAssignment {
  if (fit === undefined || decisionStage === undefined) {
    throw new SddRoutingError(
      SDD_ROUTING_ERROR_CODES.INVALID_TASK,
      `Task ${task.id} has incomplete routing evidence`,
    );
  }
  const alternateLane: RoutingLane = lane === "codex" ? "claude-host" : "codex";
  const reasons: RouteReason[] = [];
  if (decisionStage === "hard-eligibility") {
    reasons.push(reason("HARD_ELIGIBILITY"));
  } else if (decisionStage === "quality-fit") {
    reasons.push(reason("QUALITY_FIT_SELECTED"));
  } else if (decisionStage === "preferred-lane-tie-break") {
    reasons.push(reason("PREFERRED_LANE_TIE_BREAK"));
  } else {
    reasons.push(reason("NEUTRAL_EFFORT_BALANCE"));
    reasons.push(reason("NEUTRAL_TASK_COUNT_BALANCE"));
  }
  if (task.preferredLane !== undefined) {
    if (!task.eligibleLanes.includes(task.preferredLane)) {
      reasons.push(reason("PREFERRED_LANE_INELIGIBLE"));
    } else if (decisionStage === "quality-fit" && task.preferredLane !== lane) {
      reasons.push(reason("PREFERRED_LANE_OVERRIDDEN_BY_FIT"));
    }
  }
  if (task.authority === "write") {
    reasons.push(reason("SINGLE_WRITER_WAVE"));
  }
  return {
    taskId: task.id,
    lane,
    wave,
    selectedFitScore: laneFit(fit, lane),
    ...(task.eligibleLanes.length === 1
      ? {}
      : { alternateFitScore: laneFit(fit, alternateLane) }),
    laneFit: {
      codex: fit.codex,
      "claude-host": fit.claudeHost,
    },
    decisionStage,
    reasons,
  };
}

function makeBalance(
  tasks: readonly NormalizedSddRoutingTask[],
  selected: RoutingState,
  neutralCodexShareBps: number,
  decisionStages: readonly RoutingDecisionStage[],
): RoutingBalance {
  const totalEffortPoints = tasks.reduce(
    (total, task) => total + task.effortPoints,
    0,
  );
  const exactError = balanceError(
    selected.codexEffort,
    totalEffortPoints,
    neutralCodexShareBps,
  );
  const eligibleError = minimumEligibleError(tasks, neutralCodexShareBps);
  const unconstrainedError = minimumUnconstrainedError(
    tasks,
    neutralCodexShareBps,
  );
  const deviations: RoutingDeviation[] = [];
  if (eligibleError > unconstrainedError) {
    deviations.push({
      code: "HARD_ELIGIBILITY",
      message:
        "Hard lane eligibility prevents the closest unconstrained neutral-share split.",
    });
  }
  if (exactError > eligibleError) {
    deviations.push({
      code: "ADAPTIVE_FIT_POLICY",
      message:
        "Quality fit or an explicit fit-tie preference takes priority over the soft neutral-share target.",
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
    decisionCounts: countDecisionStages(decisionStages),
    deviations,
  };
}

function minimumEligibleError(
  tasks: readonly NormalizedSddRoutingTask[],
  neutralCodexShareBps: number,
): number {
  let reachable = new Set([0]);
  for (const task of tasks) {
    const next = new Set<number>();
    for (const effort of reachable) {
      if (task.eligibleLanes.includes("claude-host")) {
        next.add(effort);
      }
      if (task.eligibleLanes.includes("codex")) {
        next.add(effort + task.effortPoints);
      }
    }
    reachable = next;
  }
  const totalEffort = tasks.reduce(
    (total, task) => total + task.effortPoints,
    0,
  );
  return Math.min(
    ...[...reachable].map((effort) =>
      balanceError(effort, totalEffort, neutralCodexShareBps),
    ),
  );
}

function minimumUnconstrainedError(
  tasks: readonly NormalizedSddRoutingTask[],
  neutralCodexShareBps: number,
): number {
  let reachable = new Set([0]);
  for (const task of tasks) {
    const next = new Set(reachable);
    for (const effort of reachable) {
      next.add(effort + task.effortPoints);
    }
    reachable = next;
  }
  const totalEffort = tasks.reduce(
    (total, task) => total + task.effortPoints,
    0,
  );
  return Math.min(
    ...[...reachable].map((effort) =>
      balanceError(effort, totalEffort, neutralCodexShareBps),
    ),
  );
}

function makePlanReasons(
  tasks: readonly NormalizedSddRoutingTask[],
  decisionStages: readonly RoutingDecisionStage[],
  oddTieToCodex: boolean,
): readonly RouteReason[] {
  const reasons: RouteReason[] = [];
  if (decisionStages.includes("hard-eligibility")) {
    reasons.push(reason("HARD_ELIGIBILITY"));
  }
  if (decisionStages.includes("quality-fit")) {
    reasons.push(reason("QUALITY_FIT_SELECTED"));
  }
  if (decisionStages.includes("preferred-lane-tie-break")) {
    reasons.push(reason("PREFERRED_LANE_TIE_BREAK"));
  }
  if (decisionStages.includes("neutral-balance")) {
    reasons.push(reason("NEUTRAL_EFFORT_BALANCE"));
    reasons.push(reason("NEUTRAL_TASK_COUNT_BALANCE"));
  }
  if (oddTieToCodex) {
    reasons.push(reason("ODD_NEUTRAL_TIE_TO_CODEX"));
  }
  reasons.push(reason("LEXICAL_TIE_BREAK"));
  if (tasks.some((task) => task.authority === "write")) {
    reasons.push(reason("SINGLE_WRITER_WAVE"));
  }
  return reasons;
}

function buildWaves(
  tasks: readonly NormalizedSddRoutingTask[],
): readonly SddRoutingWave[] {
  const completed = new Set<string>();
  const waves: SddRoutingWave[] = [];
  while (completed.size < tasks.length) {
    const ready = tasks.filter(
      (task) =>
        !completed.has(task.id) &&
        task.dependencies.every((dependency) => completed.has(dependency)),
    );
    if (ready.length === 0) {
      throw new SddRoutingError(
        SDD_ROUTING_ERROR_CODES.DEPENDENCY_CYCLE,
        "No dependency-safe routing wave can be produced",
      );
    }
    const readOnlyTasks = ready.filter(
      (task) => task.authority === "read-only",
    );
    const writer = ready.find((task) => task.authority === "write");
    const selected = [
      ...readOnlyTasks,
      ...(writer === undefined ? [] : [writer]),
    ].sort((left, right) => compareText(left.id, right.id));
    const waveNumber = waves.length + 1;
    waves.push({
      wave: waveNumber,
      taskIds: selected.map((task) => task.id),
      ...(writer === undefined ? {} : { writerTaskId: writer.id }),
    });
    selected.forEach((task) => completed.add(task.id));
  }
  return waves;
}

function taskFit(task: NormalizedSddRoutingTask): TaskLaneFit {
  const kind = KIND_FIT[task.kind];
  return {
    codex: kind.codex,
    claudeHost: kind.claudeHost,
  };
}

function countDecisionStages(
  stages: readonly RoutingDecisionStage[],
): Readonly<Record<RoutingDecisionStage, number>> {
  return {
    "hard-eligibility": stages.filter((stage) => stage === "hard-eligibility")
      .length,
    "quality-fit": stages.filter((stage) => stage === "quality-fit").length,
    "preferred-lane-tie-break": stages.filter(
      (stage) => stage === "preferred-lane-tie-break",
    ).length,
    "neutral-balance": stages.filter((stage) => stage === "neutral-balance")
      .length,
  };
}

function laneFit(fit: TaskLaneFit, lane: RoutingLane): number {
  return lane === "codex" ? fit.codex : fit.claudeHost;
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

function reason(code: RouteReasonCode): RouteReason {
  return { code, message: REASON_MESSAGES[code] };
}
