export const SDD_ROUTING_POLICY_VERSION = "sdd-routing-v2" as const;
export const SDD_FIT_POLICY_VERSION = "sdd-task-fit-v1" as const;

export const ROUTING_LANES = ["codex", "claude-host"] as const;

export type RoutingLane = (typeof ROUTING_LANES)[number];

export const TASK_RISKS = ["low", "medium", "high", "critical"] as const;

export type TaskRisk = (typeof TASK_RISKS)[number];

export const TASK_AUTHORITIES = ["read-only", "write"] as const;

export type TaskAuthority = (typeof TASK_AUTHORITIES)[number];

export const TASK_KINDS = [
  "analysis",
  "planning",
  "architecture",
  "implementation",
  "debugging",
  "testing",
  "refactor",
  "review",
  "security-review",
  "documentation",
  "integration",
] as const;

export type TaskKind = (typeof TASK_KINDS)[number];

export interface SddRoutingTaskInput {
  readonly id: string;
  readonly effortPoints: number;
  readonly risk: TaskRisk;
  readonly authority: TaskAuthority;
  readonly kind: TaskKind;
  readonly dependencies?: readonly string[];
  readonly writeScopes?: readonly string[];
  readonly eligibleLanes?: readonly RoutingLane[];
  readonly preferredLane?: RoutingLane;
}

export interface SddRoutingInput {
  readonly tasks: readonly SddRoutingTaskInput[];
  /**
   * Soft Codex share used only for tasks that remain neutral after eligibility,
   * versioned fit, and an eligible preferred-lane tie-break.
   */
  readonly neutralCodexShareBps?: number;
}

export interface NormalizedSddRoutingTask {
  readonly id: string;
  readonly effortPoints: number;
  readonly risk: TaskRisk;
  readonly authority: TaskAuthority;
  readonly kind: TaskKind;
  readonly dependencies: readonly string[];
  readonly writeScopes: readonly string[];
  readonly eligibleLanes: readonly RoutingLane[];
  readonly preferredLane?: RoutingLane;
}

export const ROUTE_REASON_CODES = [
  "HARD_ELIGIBILITY",
  "QUALITY_FIT_SELECTED",
  "PREFERRED_LANE_TIE_BREAK",
  "PREFERRED_LANE_INELIGIBLE",
  "PREFERRED_LANE_OVERRIDDEN_BY_FIT",
  "NEUTRAL_EFFORT_BALANCE",
  "NEUTRAL_TASK_COUNT_BALANCE",
  "ODD_NEUTRAL_TIE_TO_CODEX",
  "LEXICAL_TIE_BREAK",
  "SINGLE_WRITER_WAVE",
] as const;

export type RouteReasonCode = (typeof ROUTE_REASON_CODES)[number];

export interface RouteReason {
  readonly code: RouteReasonCode;
  readonly message: string;
}

export interface TaskLaneFit {
  readonly codex: number;
  readonly claudeHost: number;
}

export const ROUTING_DECISION_STAGES = [
  "hard-eligibility",
  "quality-fit",
  "preferred-lane-tie-break",
  "neutral-balance",
] as const;

export type RoutingDecisionStage = (typeof ROUTING_DECISION_STAGES)[number];

export interface SddTaskAssignment {
  readonly taskId: string;
  readonly lane: RoutingLane;
  readonly wave: number;
  readonly selectedFitScore: number;
  readonly alternateFitScore?: number;
  readonly laneFit: Readonly<Record<RoutingLane, number>>;
  readonly decisionStage: RoutingDecisionStage;
  readonly reasons: readonly RouteReason[];
}

export const ROUTING_DEVIATION_CODES = [
  "HARD_ELIGIBILITY",
  "ADAPTIVE_FIT_POLICY",
  "EFFORT_GRANULARITY",
] as const;

export type RoutingDeviationCode = (typeof ROUTING_DEVIATION_CODES)[number];

export interface RoutingDeviation {
  readonly code: RoutingDeviationCode;
  readonly message: string;
}

export interface RoutingBalance {
  readonly neutralCodexShareBps: number;
  readonly actualCodexShareBps: number;
  readonly absoluteEffortDeviationBps: number;
  readonly totalEffortPoints: number;
  readonly effortPoints: Readonly<Record<RoutingLane, number>>;
  readonly taskCount: Readonly<Record<RoutingLane, number>>;
  readonly totalWeightedFitScore: number;
  readonly decisionCounts: Readonly<Record<RoutingDecisionStage, number>>;
  readonly deviations: readonly RoutingDeviation[];
}

export interface SddRoutingWave {
  readonly wave: number;
  readonly taskIds: readonly string[];
  readonly writerTaskId?: string;
}

export interface SddRoutingPlan {
  readonly schemaVersion: 1;
  readonly routingPolicyVersion: typeof SDD_ROUTING_POLICY_VERSION;
  readonly fitPolicyVersion: typeof SDD_FIT_POLICY_VERSION;
  readonly selectionOrder: readonly [
    "hard-eligibility",
    "quality-fit",
    "preferred-lane-tie-break",
    "neutral-effort-balance",
    "neutral-task-count-balance",
    "odd-neutral-tie-to-codex",
    "lexical-task-id",
  ];
  readonly planFingerprint: string;
  readonly reasons: readonly RouteReason[];
  readonly tasks: readonly NormalizedSddRoutingTask[];
  readonly assignments: readonly SddTaskAssignment[];
  readonly waves: readonly SddRoutingWave[];
  readonly balance: RoutingBalance;
}
