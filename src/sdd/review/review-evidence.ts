import {
  MAX_FINDINGS,
  ReviewValidationError,
  assertOnlyKeys,
  boundedText,
  expectLiteral,
  expectRecord,
  optionalBoundedText,
  parseStrictJson,
  safeArtifactPath,
  safeIdentifier,
  sha256Digest,
  sha256Text,
} from "./validation.js";

export const REVIEW_PHASES = [
  "plan",
  "artifacts",
  "implementation",
  "convergence",
] as const;

export type ReviewPhase = (typeof REVIEW_PHASES)[number];
export type ReviewVerdict = "approved" | "changes-requested";
export type ReviewSeverity = "low" | "medium" | "high" | "critical";

export interface ReviewFinding {
  readonly id: string;
  readonly severity: ReviewSeverity;
  readonly requirement: string;
  readonly summary: string;
  readonly artifactPath: string;
  readonly line?: number;
  readonly nextAction: string;
}

interface ReviewEvidenceBase {
  readonly schemaVersion: 1;
  readonly reviewId: string;
  readonly phase: ReviewPhase;
  readonly sealId: string;
  readonly verdict: ReviewVerdict;
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
}

export interface HostReviewEvidence extends ReviewEvidenceBase {
  readonly reviewer: {
    readonly provider: "claude";
    readonly lane: "claude-host";
    readonly modelSource: "host-selected";
    readonly attestation: "host-declared";
    readonly declaredModelLabel?: string;
  };
}

export interface CodexReviewEvidence extends ReviewEvidenceBase {
  readonly reviewer: {
    readonly provider: "codex";
    readonly lane: "codex";
    readonly modelSource: "worker-resolved";
    readonly model: string;
    readonly reasoningEffort:
      "server-default" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  };
  readonly execution: {
    readonly fresh: true;
    readonly sandbox: "read-only";
    readonly approvalPolicy: "never";
    readonly ephemeral: true;
  };
}

const HOST_EVIDENCE_KEYS = new Set([
  "schemaVersion",
  "reviewId",
  "phase",
  "sealId",
  "reviewer",
  "verdict",
  "summary",
  "findings",
]);
const CODEX_EVIDENCE_KEYS = new Set([...HOST_EVIDENCE_KEYS, "execution"]);
const HOST_REVIEWER_KEYS = new Set([
  "provider",
  "lane",
  "modelSource",
  "attestation",
  "declaredModelLabel",
]);
const CODEX_REVIEWER_KEYS = new Set([
  "provider",
  "lane",
  "modelSource",
  "model",
  "reasoningEffort",
]);
const EXECUTION_KEYS = new Set([
  "fresh",
  "sandbox",
  "approvalPolicy",
  "ephemeral",
]);
const FINDING_KEYS = new Set([
  "id",
  "severity",
  "requirement",
  "summary",
  "artifactPath",
  "line",
  "nextAction",
]);

export function parseHostReviewEvidenceJson(raw: string): HostReviewEvidence {
  return validateHostReviewEvidence(
    parseStrictJson(raw, "host review evidence"),
  );
}

export function parseCodexReviewEvidenceJson(raw: string): CodexReviewEvidence {
  return validateCodexReviewEvidence(
    parseStrictJson(raw, "Codex review evidence"),
  );
}

export function validateHostReviewEvidence(value: unknown): HostReviewEvidence {
  const record = expectRecord(value, "host review evidence");
  assertOnlyKeys(record, HOST_EVIDENCE_KEYS, "host review evidence");
  const common = validateCommonEvidence(record, "host review evidence");
  const reviewer = expectRecord(record.reviewer, "host reviewer");

  expectLiteral(reviewer.provider, "claude", "host reviewer provider");
  expectLiteral(reviewer.lane, "claude-host", "host reviewer lane");
  expectLiteral(
    reviewer.modelSource,
    "host-selected",
    "host reviewer modelSource",
  );
  expectLiteral(
    reviewer.attestation,
    "host-declared",
    "host reviewer attestation",
  );
  assertOnlyKeys(reviewer, HOST_REVIEWER_KEYS, "host reviewer");
  const declaredModelLabel = optionalBoundedText(
    reviewer.declaredModelLabel,
    "host reviewer declaredModelLabel",
    128,
  );

  const evidence: HostReviewEvidence = {
    ...common,
    reviewer: {
      provider: "claude",
      lane: "claude-host",
      modelSource: "host-selected",
      attestation: "host-declared",
      ...(declaredModelLabel === undefined ? {} : { declaredModelLabel }),
    },
  };
  assertEvidenceSize(evidence, "host review evidence");
  return evidence;
}

export function validateCodexReviewEvidence(
  value: unknown,
): CodexReviewEvidence {
  const record = expectRecord(value, "Codex review evidence");
  assertOnlyKeys(record, CODEX_EVIDENCE_KEYS, "Codex review evidence");
  const common = validateCommonEvidence(record, "Codex review evidence");
  const reviewer = expectRecord(record.reviewer, "Codex reviewer");
  expectLiteral(reviewer.provider, "codex", "Codex reviewer provider");
  expectLiteral(reviewer.lane, "codex", "Codex reviewer lane");
  expectLiteral(
    reviewer.modelSource,
    "worker-resolved",
    "Codex reviewer modelSource",
  );
  assertOnlyKeys(reviewer, CODEX_REVIEWER_KEYS, "Codex reviewer");
  const model = safeIdentifier(reviewer.model, "Codex reviewer model");
  const reasoningEffort = codexReasoningEffort(reviewer.reasoningEffort);

  const execution = expectRecord(record.execution, "Codex review execution");
  expectLiteral(execution.fresh, true, "Codex review execution fresh");
  expectLiteral(
    execution.sandbox,
    "read-only",
    "Codex review execution sandbox",
  );
  expectLiteral(
    execution.approvalPolicy,
    "never",
    "Codex review execution approvalPolicy",
  );
  expectLiteral(execution.ephemeral, true, "Codex review execution ephemeral");
  assertOnlyKeys(execution, EXECUTION_KEYS, "Codex review execution");

  const evidence: CodexReviewEvidence = {
    ...common,
    reviewer: {
      provider: "codex",
      lane: "codex",
      modelSource: "worker-resolved",
      model,
      reasoningEffort,
    },
    execution: {
      fresh: true,
      sandbox: "read-only",
      approvalPolicy: "never",
      ephemeral: true,
    },
  };
  assertEvidenceSize(evidence, "Codex review evidence");
  return evidence;
}

function codexReasoningEffort(
  value: unknown,
): CodexReviewEvidence["reviewer"]["reasoningEffort"] {
  if (
    value !== "server-default" &&
    value !== "low" &&
    value !== "medium" &&
    value !== "high" &&
    value !== "xhigh" &&
    value !== "max" &&
    value !== "ultra"
  ) {
    throw new ReviewValidationError(
      "INVALID_REVIEW_REASONING_EFFORT",
      "Codex reviewer reasoningEffort is invalid",
    );
  }
  return value;
}

export function reviewEvidenceDigest(
  evidence: HostReviewEvidence | CodexReviewEvidence,
): string {
  return sha256Text(JSON.stringify(evidence));
}

function validateCommonEvidence(
  record: Readonly<Record<string, unknown>>,
  label: string,
): ReviewEvidenceBase {
  expectLiteral(record.schemaVersion, 1, `${label} schemaVersion`);
  const reviewId = safeIdentifier(record.reviewId, `${label} reviewId`);
  const phase = reviewPhase(record.phase, `${label} phase`);
  const sealId = sha256Digest(record.sealId, `${label} sealId`);
  const verdict = reviewVerdict(record.verdict, `${label} verdict`);
  const summary = boundedText(record.summary, `${label} summary`, 8_000);
  const findings = validateFindings(record.findings, label);
  if (verdict === "changes-requested" && findings.length === 0) {
    throw new ReviewValidationError(
      "EMPTY_CHANGE_REVIEW",
      `${label} must include a finding when changes are requested`,
    );
  }
  if (
    verdict === "approved" &&
    findings.some(
      (finding) =>
        finding.severity === "high" || finding.severity === "critical",
    )
  ) {
    throw new ReviewValidationError(
      "APPROVED_WITH_BLOCKING_FINDING",
      `${label} cannot approve while a High or Critical finding remains`,
    );
  }

  return {
    schemaVersion: 1,
    reviewId,
    phase,
    sealId,
    verdict,
    summary,
    findings,
  };
}

function validateFindings(
  value: unknown,
  label: string,
): readonly ReviewFinding[] {
  if (!Array.isArray(value) || value.length > MAX_FINDINGS) {
    throw new ReviewValidationError(
      "INVALID_REVIEW_FINDINGS",
      `${label} findings must be an array with at most ${MAX_FINDINGS} items`,
    );
  }
  const findings = value.map((entry, index): ReviewFinding => {
    const record = expectRecord(entry, `${label} finding ${index}`);
    assertOnlyKeys(record, FINDING_KEYS, `${label} finding ${index}`);
    const line = optionalLine(record.line, `${label} finding ${index} line`);
    return {
      id: safeIdentifier(record.id, `${label} finding ${index} id`),
      severity: reviewSeverity(
        record.severity,
        `${label} finding ${index} severity`,
      ),
      requirement: boundedText(
        record.requirement,
        `${label} finding ${index} requirement`,
        512,
      ),
      summary: boundedText(
        record.summary,
        `${label} finding ${index} summary`,
        2_000,
      ),
      artifactPath: safeArtifactPath(
        record.artifactPath,
        `${label} finding ${index} artifactPath`,
      ),
      ...(line === undefined ? {} : { line }),
      nextAction: boundedText(
        record.nextAction,
        `${label} finding ${index} nextAction`,
        2_000,
      ),
    };
  });
  const ids = findings.map((finding) => finding.id);
  if (new Set(ids).size !== ids.length) {
    throw new ReviewValidationError(
      "DUPLICATE_REVIEW_FINDING",
      `${label} contains duplicate finding identifiers`,
    );
  }
  return findings;
}

function optionalLine(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 10_000_000
  ) {
    throw new ReviewValidationError(
      "INVALID_REVIEW_LINE",
      `${label} must be a positive integer`,
    );
  }
  return value;
}

function assertEvidenceSize(
  evidence: HostReviewEvidence | CodexReviewEvidence,
  label: string,
): void {
  if (Buffer.byteLength(JSON.stringify(evidence), "utf8") > 64 * 1024) {
    throw new ReviewValidationError(
      "REVIEW_EVIDENCE_TOO_LARGE",
      `${label} exceeds the 65536-byte limit`,
    );
  }
}

function reviewVerdict(value: unknown, label: string): ReviewVerdict {
  if (value !== "approved" && value !== "changes-requested") {
    throw new ReviewValidationError(
      "INVALID_REVIEW_VERDICT",
      `${label} must be approved or changes-requested`,
    );
  }
  return value;
}

function reviewPhase(value: unknown, label: string): ReviewPhase {
  if (!REVIEW_PHASES.some((phase) => phase === value)) {
    throw new ReviewValidationError(
      "INVALID_REVIEW_PHASE",
      `${label} must be one of ${REVIEW_PHASES.join(", ")}`,
    );
  }
  return value as ReviewPhase;
}

function reviewSeverity(value: unknown, label: string): ReviewSeverity {
  if (
    value !== "low" &&
    value !== "medium" &&
    value !== "high" &&
    value !== "critical"
  ) {
    throw new ReviewValidationError(
      "INVALID_REVIEW_SEVERITY",
      `${label} is invalid`,
    );
  }
  return value;
}
