import { createHash } from "node:crypto";

import type { WorkerConfig } from "../config/worker-config.js";
import { ERROR_CODES, WorkerError } from "../core/errors.js";
import type { ReasoningEffort } from "../core/types.js";
import type { GitClient } from "../runtime/git-client.js";
import { compareGitRevisions } from "../runtime/review-comparison.js";
import {
  REVIEW_PHASES,
  ReviewValidationError,
  createFileSystemArtifactReader,
  createRevisionSeal,
  evaluateDualReviewGate,
  reviewEvidenceDigest,
  validateCodexReviewEvidence,
  validateHostReviewEvidence,
  type CodexReviewEvidence,
  type DualReviewGateResult,
  type HostReviewEvidence,
  type ReviewFinding,
  type ReviewMode,
  type ReviewPhase,
  type ReviewVerdict,
  type RevisionSeal,
  type RevisionSealDependencies,
} from "./review/index.js";
import {
  assertOnlyKeys,
  expectLiteral,
  expectRecord,
  parseStrictJson,
} from "./review/validation.js";

const FULL_REVISION = /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DECISION_KEYS = new Set([
  "schemaVersion",
  "verdict",
  "summary",
  "findings",
]);

export interface SddHostReviewInput {
  readonly reviewId: string;
  readonly verdict: ReviewVerdict;
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
  readonly declaredModelLabel?: string;
}

export interface StartSddReviewInput {
  readonly phase: ReviewPhase;
  readonly mode: ReviewMode;
  readonly artifactPaths: readonly string[];
  readonly expectedRevision?: string;
  readonly baseRevision?: string;
  readonly hostReview: SddHostReviewInput;
  readonly focus?: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly timeoutMs?: number;
  readonly idempotencyKey?: string;
}

export interface PreparedSddReview {
  readonly schemaVersion: 1;
  readonly phase: ReviewPhase;
  readonly repositoryRoot: string;
  readonly seal: RevisionSeal;
  readonly hostEvidence: HostReviewEvidence;
  readonly hostEvidenceDigest: string;
  readonly task: string;
}

export interface SddReviewArtifact {
  readonly schemaVersion: 1;
  readonly phase: ReviewPhase;
  readonly seal: RevisionSeal;
  readonly hostEvidence: HostReviewEvidence;
  readonly codexEvidence: CodexReviewEvidence;
  readonly gate: DualReviewGateResult;
}

export class SddReviewService {
  readonly #config: WorkerConfig;
  readonly #git: GitClient;

  public constructor(config: WorkerConfig, git: GitClient) {
    this.#config = config;
    this.#git = git;
  }

  public async prepare(
    inputValue: unknown,
    repositoryRoot: string,
  ): Promise<PreparedSddReview> {
    let input: StartSddReviewInput;
    try {
      input = validateSddReviewInput(inputValue, this.#config);
    } catch (error) {
      throw mapReviewError(error);
    }
    const dependencies = await this.#dependencies(repositoryRoot);
    let seal: RevisionSeal;
    try {
      seal = await createRevisionSeal(
        {
          mode: input.mode,
          artifactPaths: input.artifactPaths,
          ...(input.baseRevision === undefined
            ? {}
            : { baseRevision: input.baseRevision }),
        },
        dependencies,
      );
    } catch (error) {
      throw mapReviewError(error);
    }

    const expectedRevision = input.expectedRevision?.toLowerCase();
    if (input.mode === "strict" && expectedRevision === undefined) {
      throw new WorkerError(
        ERROR_CODES.INVALID_REQUEST,
        "Strict SDD reviews require expectedRevision",
      );
    }
    if (expectedRevision !== undefined && expectedRevision !== seal.revision) {
      throw new WorkerError(
        ERROR_CODES.REVISION_MISMATCH,
        "The SDD review revision does not match the current repository HEAD",
      );
    }

    let hostEvidence: HostReviewEvidence;
    try {
      hostEvidence = validateHostReviewEvidence({
        schemaVersion: 1,
        reviewId: input.hostReview.reviewId,
        phase: input.phase,
        sealId: seal.sealId,
        reviewer: {
          provider: "claude",
          lane: "claude-host",
          modelSource: "host-selected",
          attestation: "host-declared",
          ...(input.hostReview.declaredModelLabel === undefined
            ? {}
            : { declaredModelLabel: input.hostReview.declaredModelLabel }),
        },
        verdict: input.hostReview.verdict,
        summary: input.hostReview.summary,
        findings: input.hostReview.findings,
      });
    } catch (error) {
      throw mapReviewError(error);
    }

    return {
      schemaVersion: 1,
      phase: input.phase,
      repositoryRoot,
      seal,
      hostEvidence,
      hostEvidenceDigest: reviewEvidenceDigest(hostEvidence),
      task: buildReviewTask(input, seal),
    };
  }

  public async finalize(
    prepared: PreparedSddReview,
    rawCodexDecision: string,
    requestedModel?: string,
    requestedReasoningEffort?: ReasoningEffort,
  ): Promise<SddReviewArtifact> {
    let codexEvidence: CodexReviewEvidence;
    try {
      const record = expectRecord(
        parseStrictJson(rawCodexDecision, "Codex SDD review decision"),
        "Codex SDD review decision",
      );
      assertOnlyKeys(record, DECISION_KEYS, "Codex SDD review decision");
      expectLiteral(
        record.schemaVersion,
        1,
        "Codex SDD review decision schemaVersion",
      );
      codexEvidence = validateCodexReviewEvidence({
        schemaVersion: 1,
        reviewId: `codex-${prepared.seal.sealId.slice(0, 24)}`,
        phase: prepared.phase,
        sealId: prepared.seal.sealId,
        reviewer: {
          provider: "codex",
          lane: "codex",
          modelSource: "worker-resolved",
          model: requestedModel ?? "server-default",
          reasoningEffort: requestedReasoningEffort ?? "server-default",
        },
        execution: {
          fresh: true,
          sandbox: "read-only",
          approvalPolicy: "never",
          ephemeral: true,
        },
        verdict: record.verdict,
        summary: record.summary,
        findings: record.findings,
      });
    } catch (error) {
      throw mapReviewError(error);
    }

    const dependencies = await this.#dependencies(prepared.repositoryRoot);
    const gate = await evaluateDualReviewGate(
      {
        seal: prepared.seal,
        hostEvidence: prepared.hostEvidence,
        codexEvidence,
      },
      dependencies,
    );
    return {
      schemaVersion: 1,
      phase: prepared.phase,
      seal: prepared.seal,
      hostEvidence: prepared.hostEvidence,
      codexEvidence,
      gate,
    };
  }

  async #dependencies(
    repositoryRoot: string,
  ): Promise<RevisionSealDependencies> {
    const readArtifact = await createFileSystemArtifactReader(repositoryRoot);
    return {
      snapshotWorkspace: async () => await this.#snapshot(repositoryRoot),
      readArtifact,
      compareRevision: async (baseRevision, currentRevision) =>
        await compareGitRevisions(
          this.#git,
          repositoryRoot,
          baseRevision,
          currentRevision,
        ),
    };
  }

  async #snapshot(repositoryRoot: string): Promise<{
    readonly revision: string;
    readonly clean: boolean;
    readonly fingerprint: string;
  }> {
    const statusArgs = [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ] as const;
    const before = await this.#git.run(repositoryRoot, statusArgs);
    const revision = await this.#git.run(repositoryRoot, [
      "rev-parse",
      "--verify",
      "HEAD",
    ]);
    const after = await this.#git.run(repositoryRoot, statusArgs);
    if (before.stdout !== after.stdout) {
      throw new ReviewValidationError(
        "REVIEW_WORKSPACE_CHANGED",
        "The review workspace changed while its revision seal was being captured",
      );
    }
    const normalizedRevision = revision.stdout.trim().toLowerCase();
    return {
      revision: normalizedRevision,
      clean: after.stdout === "",
      fingerprint: createHash("sha256")
        .update(
          JSON.stringify({
            revision: normalizedRevision,
            status: after.stdout,
          }),
        )
        .digest("hex"),
    };
  }
}

export function validateSddReviewInput(
  value: unknown,
  config: WorkerConfig,
): StartSddReviewInput {
  try {
    return validateSddReviewInputValue(value, config);
  } catch (error) {
    if (error instanceof WorkerError) {
      throw error;
    }
    if (error instanceof ReviewValidationError) {
      throw new WorkerError(ERROR_CODES.INVALID_REQUEST, error.message);
    }
    throw error;
  }
}

function validateSddReviewInputValue(
  value: unknown,
  config: WorkerConfig,
): StartSddReviewInput {
  const record = expectRecord(value, "SDD review input");
  const allowed = new Set([
    "phase",
    "mode",
    "artifactPaths",
    "expectedRevision",
    "baseRevision",
    "hostReview",
    "focus",
    "cwd",
    "model",
    "reasoningEffort",
    "timeoutMs",
    "idempotencyKey",
  ]);
  assertOnlyKeys(record, allowed, "SDD review input");
  if (!REVIEW_PHASES.some((phase) => phase === record.phase)) {
    invalid("phase is invalid");
  }
  if (record.mode !== "strict" && record.mode !== "draft") {
    invalid("mode must be strict or draft");
  }
  if (!Array.isArray(record.artifactPaths)) {
    invalid("artifactPaths must be an array");
  }
  if (
    record.expectedRevision !== undefined &&
    (typeof record.expectedRevision !== "string" ||
      !FULL_REVISION.test(record.expectedRevision))
  ) {
    invalid("expectedRevision must be a full Git object ID");
  }
  if (
    record.baseRevision !== undefined &&
    (typeof record.baseRevision !== "string" ||
      !FULL_REVISION.test(record.baseRevision))
  ) {
    invalid("baseRevision must be a full Git object ID");
  }
  if (record.mode === "strict" && record.expectedRevision === undefined) {
    invalid("strict reviews require expectedRevision");
  }
  const hostReview = expectRecord(record.hostReview, "hostReview");
  assertOnlyKeys(
    hostReview,
    new Set([
      "reviewId",
      "verdict",
      "summary",
      "findings",
      "declaredModelLabel",
    ]),
    "hostReview",
  );
  if (
    typeof hostReview.reviewId !== "string" ||
    !SAFE_ID.test(hostReview.reviewId)
  ) {
    invalid("hostReview.reviewId is invalid");
  }
  if (
    hostReview.verdict !== "approved" &&
    hostReview.verdict !== "changes-requested"
  ) {
    invalid("hostReview.verdict is invalid");
  }
  if (
    typeof hostReview.summary !== "string" ||
    !Array.isArray(hostReview.findings)
  ) {
    invalid("hostReview summary or findings are invalid");
  }
  if (
    record.focus !== undefined &&
    (typeof record.focus !== "string" ||
      record.focus.trim() === "" ||
      record.focus.length > 4_000 ||
      hasUnsafeControl(record.focus))
  ) {
    invalid("focus must contain 1-4000 safe characters");
  }
  if (
    record.cwd !== undefined &&
    (typeof record.cwd !== "string" || record.cwd.length > 4_096)
  ) {
    invalid("cwd must be a bounded string");
  }
  if (
    record.model !== undefined &&
    (typeof record.model !== "string" ||
      !config.allowedModels.includes(record.model))
  ) {
    invalid("model must be listed in CCW_ALLOWED_MODELS");
  }
  if (
    record.reasoningEffort !== undefined &&
    (typeof record.reasoningEffort !== "string" ||
      !["low", "medium", "high", "xhigh", "max", "ultra"].includes(
        record.reasoningEffort,
      ))
  ) {
    invalid("reasoningEffort is invalid");
  }
  for (const key of ["idempotencyKey"] as const) {
    if (record[key] !== undefined && typeof record[key] !== "string") {
      invalid(`${key} must be a string`);
    }
  }
  if (record.timeoutMs !== undefined && typeof record.timeoutMs !== "number") {
    invalid("timeoutMs must be a number");
  }

  return record as unknown as StartSddReviewInput;
}

function buildReviewTask(
  input: StartSddReviewInput,
  seal: RevisionSeal,
): string {
  return [
    `Perform an independent ${input.phase} review against revision seal ${seal.sealId}.`,
    `Review mode: ${input.mode}.`,
    `Repository revision: ${seal.revision ?? "uncommitted draft"}.`,
    ...(seal.comparison === null
      ? []
      : [
          `Comparison base revision: ${seal.comparison.baseRevision}.`,
          `Comparison diff sha256: ${seal.comparison.diffSha256}.`,
          "Changed review scope:",
          ...seal.comparison.changedPaths.map((path) => `- ${path}`),
        ]),
    "Reviewed artifacts:",
    ...seal.artifacts.map(
      (artifact) =>
        `- ${artifact.path} (${artifact.bytes} bytes, sha256 ${artifact.sha256})`,
    ),
    ...(input.focus === undefined ? [] : ["Review focus:", input.focus.trim()]),
    "Review the artifacts independently. You have not been given the Claude host review and must not attempt to discover it.",
    "A High or Critical finding is blocking: return changes-requested, never approved, until a new revision resolves it.",
    "Return only one raw JSON object matching the provided output schema. Do not use Markdown fences.",
  ].join("\n");
}

function mapReviewError(error: unknown): WorkerError {
  if (error instanceof WorkerError) {
    return error;
  }
  if (error instanceof ReviewValidationError) {
    return new WorkerError(ERROR_CODES.REVIEW_INVALID, error.message);
  }
  return new WorkerError(
    ERROR_CODES.REVIEW_INVALID,
    error instanceof Error ? error.message : "Invalid SDD review evidence",
  );
}

function invalid(message: string): never {
  throw new WorkerError(ERROR_CODES.INVALID_REQUEST, message);
}

function hasUnsafeControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint >= 0 && codePoint <= 8) ||
        codePoint === 11 ||
        codePoint === 12 ||
        (codePoint >= 14 && codePoint <= 31) ||
        codePoint === 127)
    ) {
      return true;
    }
  }
  return false;
}
