import {
  evaluateRevisionSealFreshness,
  validateRevisionSeal,
  type RevisionSealDependencies,
} from "./revision-seal.js";
import {
  reviewEvidenceDigest,
  validateCodexReviewEvidence,
  validateHostReviewEvidence,
  type CodexReviewEvidence,
  type HostReviewEvidence,
} from "./review-evidence.js";

export type DualReviewGateStatus = "ready" | "blocked" | "stale";

export interface DualReviewGateResult {
  readonly passed: boolean;
  readonly status: DualReviewGateStatus;
  readonly sealId: string | null;
  readonly reasons: readonly string[];
  readonly freshnessReasons: readonly string[];
  readonly evidenceDigests: {
    readonly host: string | null;
    readonly codex: string | null;
  };
}

export async function evaluateDualReviewGate(
  input: {
    readonly seal: unknown;
    readonly hostEvidence: unknown;
    readonly codexEvidence: unknown;
  },
  dependencies: RevisionSealDependencies,
): Promise<DualReviewGateResult> {
  let seal;
  try {
    seal = validateRevisionSeal(input.seal);
  } catch {
    return blockedResult(null, ["invalid-revision-seal"]);
  }

  const reasons: string[] = [];
  let hostEvidence: HostReviewEvidence | undefined;
  let codexEvidence: CodexReviewEvidence | undefined;
  try {
    hostEvidence = validateHostReviewEvidence(input.hostEvidence);
  } catch {
    reasons.push("invalid-host-evidence");
  }
  try {
    codexEvidence = validateCodexReviewEvidence(input.codexEvidence);
  } catch {
    reasons.push("invalid-codex-evidence");
  }

  const evidenceDigests = {
    host:
      hostEvidence === undefined ? null : reviewEvidenceDigest(hostEvidence),
    codex:
      codexEvidence === undefined ? null : reviewEvidenceDigest(codexEvidence),
  };

  if (seal.mode !== "strict") {
    reasons.push("draft-review-advisory-only");
  }
  if (hostEvidence !== undefined) {
    if (hostEvidence.sealId !== seal.sealId) {
      reasons.push("host-seal-mismatch");
    }
    if (hostEvidence.verdict !== "approved") {
      reasons.push("host-changes-requested");
    }
  }
  if (codexEvidence !== undefined) {
    if (codexEvidence.sealId !== seal.sealId) {
      reasons.push("codex-seal-mismatch");
    }
    if (codexEvidence.verdict !== "approved") {
      reasons.push("codex-changes-requested");
    }
  }
  if (
    hostEvidence !== undefined &&
    codexEvidence !== undefined &&
    hostEvidence.phase !== codexEvidence.phase
  ) {
    reasons.push("review-phase-mismatch");
  }
  const reviewedArtifactPaths = new Set([
    ...seal.artifacts.map((artifact) => artifact.path),
    ...(seal.comparison?.changedPaths ?? []),
  ]);
  if (
    hostEvidence?.findings.some(
      (finding) => !reviewedArtifactPaths.has(finding.artifactPath),
    ) === true
  ) {
    reasons.push("host-finding-outside-seal");
  }
  if (
    codexEvidence?.findings.some(
      (finding) => !reviewedArtifactPaths.has(finding.artifactPath),
    ) === true
  ) {
    reasons.push("codex-finding-outside-seal");
  }
  if (
    hostEvidence?.reviewId !== undefined &&
    hostEvidence.reviewId === codexEvidence?.reviewId
  ) {
    reasons.push("duplicate-review-id");
  }

  let freshnessReasons: readonly string[];
  try {
    const freshness = await evaluateRevisionSealFreshness(seal, dependencies);
    freshnessReasons = freshness.reasons;
  } catch {
    freshnessReasons = ["freshness-check-failed"];
  }
  if (freshnessReasons.length > 0) {
    return {
      passed: false,
      status: "stale",
      sealId: seal.sealId,
      reasons: unique(reasons),
      freshnessReasons,
      evidenceDigests,
    };
  }

  const uniqueReasons = unique(reasons);
  if (uniqueReasons.length > 0) {
    return {
      passed: false,
      status: "blocked",
      sealId: seal.sealId,
      reasons: uniqueReasons,
      freshnessReasons: [],
      evidenceDigests,
    };
  }
  return {
    passed: true,
    status: "ready",
    sealId: seal.sealId,
    reasons: [],
    freshnessReasons: [],
    evidenceDigests,
  };
}

export const evaluateDualPlanReviewGate = evaluateDualReviewGate;

function blockedResult(
  sealId: string | null,
  reasons: readonly string[],
): DualReviewGateResult {
  return {
    passed: false,
    status: "blocked",
    sealId,
    reasons,
    freshnessReasons: [],
    evidenceDigests: { host: null, codex: null },
  };
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
