export const JOB_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const RUN_MODES = ["analyze", "proposal"] as const;

export type RunMode = (typeof RUN_MODES)[number];

export const JOB_ACTIVITIES = [
  "queued",
  "starting",
  "preparing_workspace",
  "preparing_review_workspace",
  "codex_started",
  "reasoning",
  "planning",
  "running_command",
  "command_completed",
  "preparing_changes",
  "using_tool",
  "researching",
  "working",
  "composing_response",
  "response_ready",
  "validating_proposal",
  "validating_review",
  "completed",
  "failed",
  "cancelled",
] as const;

export type JobActivity = (typeof JOB_ACTIVITIES)[number];

export const REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface StartJobInput {
  readonly task: string;
  readonly cwd?: string;
  readonly mode?: RunMode;
  readonly writePaths?: readonly string[];
  readonly expectedRevision?: string;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly timeoutMs?: number;
  readonly idempotencyKey?: string;
  /** Continue a recorded Codex thread instead of starting a new one. */
  readonly resumeSessionId?: string;
  /** Keep this run's Codex session on disk so it can be resumed later. */
  readonly persistSession?: boolean;
}

export interface ResolvedJobRequest {
  readonly task: string;
  readonly taskHash: string;
  readonly cwd: string;
  readonly repositoryRoot: string;
  readonly executionRoot: string;
  readonly mode: RunMode;
  readonly writePaths?: readonly string[];
  readonly expectedRevision?: string;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly timeoutMs: number;
  readonly idempotencyKey?: string;
  readonly sddReview?: PreparedSddReview;
  readonly resumeSessionId?: string;
  readonly persistSession?: boolean;
  /** Set when the operator bootstrap installed dependencies in the clone. */
  readonly proposalDependenciesReady?: boolean;
}

export interface UsageSummary {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
}

export interface JobProgress {
  readonly phase: "queued" | "starting" | "working" | "finalizing" | "terminal";
  readonly activity: JobActivity;
  readonly activityLabel: string;
  readonly eventCount: number;
  readonly commandCount: number;
  readonly messageCount: number;
  readonly lastEventType?: string;
  readonly updatedAt: string;
  readonly elapsedMs: number;
  readonly sinceLastUpdateMs: number;
}

export interface PublicJobSnapshot {
  readonly id: string;
  readonly revision: number;
  readonly status: JobStatus;
  readonly mode: RunMode;
  readonly cwd: string;
  readonly repositoryRoot: string;
  readonly writePaths?: readonly string[];
  readonly expectedRevision?: string;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly idempotencyKey?: string;
  readonly sddReview?: {
    readonly phase: PreparedSddReview["phase"];
    readonly mode: PreparedSddReview["seal"]["mode"];
    readonly sealId: string;
    readonly hostEvidenceDigest: string;
  };
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly queuePosition?: number;
  readonly progress: JobProgress;
  readonly sessionId?: string;
  /** Present when the run's Codex session is recorded and can be resumed. */
  readonly sessionPersisted?: boolean;
  readonly usage?: UsageSummary;
  readonly resultAvailable: boolean;
  /** Present when a failed job still salvaged a partial final message. */
  readonly partialResultAvailable?: boolean;
  readonly resultTruncated: boolean;
  readonly error?: WorkerFailure;
}

export interface WorkerFailure {
  readonly code: string;
  readonly message: string;
  readonly diagnostics?: FailureDiagnostics;
}

/**
 * Server-derived run measurements attached to a failure. Every field is a
 * number or a fixed enum produced by the worker itself; child-provided text
 * never appears here.
 */
export interface FailureDiagnostics {
  readonly stopReason?: "timeout" | "output-limit" | "protocol";
  readonly exitCode?: number;
  readonly eventCount?: number;
  readonly commandsSucceeded?: number;
  readonly commandsFailed?: number;
  readonly stdoutBytes?: number;
  readonly stderrBytes?: number;
  readonly elapsedMs?: number;
  readonly partialMessageChars?: number;
}

export interface JobResult {
  readonly ready: boolean;
  readonly job: PublicJobSnapshot;
  readonly finalMessage?: string;
  readonly proposal?: ProposalArtifact;
  readonly review?: SddReviewArtifact;
}

export interface ProposalArtifact {
  readonly effect: "none" | "proposal";
  readonly baselineRevision: string;
  readonly changedFiles: readonly string[];
  readonly patch?: string;
  readonly patchBytes: number;
  readonly patchSha256?: string;
}

export interface RuntimeEvent {
  readonly type: string;
  readonly activity?: JobActivity;
  readonly sessionId?: string;
  readonly commandCompleted?: boolean;
  readonly agentMessage?: string;
  readonly usage?: UsageSummary;
}

export type RuntimeOutcome = "completed" | "failed" | "cancelled";

export interface RuntimeResult {
  readonly outcome: RuntimeOutcome;
  readonly finalMessage?: string;
  readonly sessionId?: string;
  readonly usage?: UsageSummary;
  readonly resultTruncated: boolean;
  readonly failure?: WorkerFailure;
}

export interface RuntimeHandle {
  readonly completion: Promise<RuntimeResult>;
  cancel(reason: "user" | "shutdown"): Promise<void>;
}

export interface WorkerRuntime {
  start(
    request: ResolvedJobRequest,
    onEvent: (event: RuntimeEvent) => void,
  ): RuntimeHandle;
}

export interface WorkerHealth {
  readonly ok: boolean;
  readonly version: string;
  readonly codexExecutable: string;
  readonly gitExecutable: string;
  readonly codexVersion?: string;
  readonly gitVersion?: string;
  readonly compatible: boolean;
  readonly authenticated?: boolean;
  readonly allowedRoots: readonly string[];
  readonly allowedModels: readonly string[];
  readonly proposalsEnabled: boolean;
  readonly maxConcurrent: number;
  readonly maxQueued: number;
  readonly authEnvironmentForwarding: boolean;
  readonly warnings: readonly string[];
}

export interface WorkspaceSummary {
  readonly cwd: string;
  readonly repositoryRoot: string;
  readonly revision: string;
  readonly clean: boolean;
  readonly proposalReady: boolean;
  readonly proposalBlockers: readonly string[];
}
import type {
  PreparedSddReview,
  SddReviewArtifact,
} from "../sdd/review-job.js";
