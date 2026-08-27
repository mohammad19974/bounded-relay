import {
  assertSafeIdentifier,
  assertSha256,
  canonicalDigest,
  fail,
  jsonDigest,
  safeRepositoryPath,
} from "./evidence-core.mjs";

export function assertStrictSddReview(
  codexReview,
  claudeReview,
  revision,
  phase,
) {
  const review = codexReview?.sddReview;
  assertOnlyKeys(
    review,
    [
      "tool",
      "phase",
      "mode",
      "expectedRevision",
      "seal",
      "hostEvidenceDigest",
      "hostEvidence",
      "codexEvidence",
      "gate",
    ],
    `${phase} strict review result`,
  );
  if (
    review?.tool !== "codex_worker_sdd_review" ||
    review.phase !== phase ||
    review.mode !== "strict" ||
    review.expectedRevision !== revision.head
  ) {
    fail(
      `${phase} gate requires codex_worker_sdd_review with a revision-pinned strict SDD review`,
    );
  }
  const seal = review.seal;
  assertOnlyKeys(
    seal,
    [
      "schemaVersion",
      "mode",
      "revision",
      "clean",
      "workspaceFingerprint",
      "artifacts",
      "comparison",
      "sealId",
    ],
    `${phase} strict seal`,
  );
  if (
    seal?.schemaVersion !== 1 ||
    seal.mode !== "strict" ||
    seal.clean !== true ||
    seal.revision !== revision.head ||
    !Array.isArray(seal.artifacts) ||
    seal.artifacts.length === 0 ||
    seal.artifacts.length > 64
  ) {
    fail(`${phase} Codex review contains an invalid strict seal`);
  }
  assertSha256(seal.workspaceFingerprint, `${phase} workspace fingerprint`);
  assertSha256(seal.sealId, `${phase} Codex seal id`);
  const expectedArtifacts = [...revision.artifacts].sort((left, right) =>
    compareCodeUnits(left.path, right.path),
  );
  let totalArtifactBytes = 0;
  const actualArtifacts = seal.artifacts
    .map((artifact) => {
      assertOnlyKeys(
        artifact,
        ["path", "bytes", "sha256"],
        `${phase} Codex artifact`,
      );
      if (
        !Number.isSafeInteger(artifact.bytes) ||
        artifact.bytes < 0 ||
        artifact.bytes > 2 * 1024 * 1024
      ) {
        fail(`${phase} Codex seal contains an invalid artifact size`);
      }
      totalArtifactBytes += artifact.bytes;
      if (totalArtifactBytes > 8 * 1024 * 1024) {
        fail(`${phase} Codex seal exceeds the total artifact size limit`);
      }
      assertSha256(artifact.sha256, `${phase} artifact digest`);
      return {
        path: safeRepositoryPath(artifact.path, `${phase} Codex artifact path`),
        bytes: artifact.bytes,
        sha256: artifact.sha256,
      };
    })
    .sort((left, right) => compareCodeUnits(left.path, right.path));
  const originalPaths = seal.artifacts.map((artifact) => artifact.path);
  if (
    new Set(originalPaths).size !== originalPaths.length ||
    canonicalDigest(originalPaths) !==
      canonicalDigest([...originalPaths].sort(compareCodeUnits))
  ) {
    fail(`${phase} Codex seal artifacts are not canonical`);
  }
  if (canonicalDigest(actualArtifacts) !== canonicalDigest(expectedArtifacts)) {
    fail(`${phase} Codex seal artifacts do not match the run-local revision`);
  }
  const comparison = validateComparison(seal.comparison ?? null, phase);
  if (
    canonicalDigest(comparison) !== canonicalDigest(revision.comparison ?? null)
  ) {
    fail(`${phase} Codex comparison does not match the run-local review scope`);
  }
  const sealPayload = {
    schemaVersion: 1,
    mode: "strict",
    revision: seal.revision,
    clean: true,
    workspaceFingerprint: seal.workspaceFingerprint,
    artifacts: seal.artifacts,
    comparison: seal.comparison ?? null,
  };
  if (jsonDigest(sealPayload) !== seal.sealId) {
    fail(`${phase} Codex seal id does not match its content`);
  }

  const hostEvidence = review.hostEvidence;
  const codexEvidence = review.codexEvidence;
  assertProviderEvidence(hostEvidence, "claude", phase, seal.sealId);
  assertProviderEvidence(codexEvidence, "codex", phase, seal.sealId);
  if (hostEvidence.reviewId === codexEvidence.reviewId) {
    fail(`${phase} reviews must have independent identifiers`);
  }
  if (
    hostEvidence.reviewer?.lane !== "claude-host" ||
    hostEvidence.reviewer?.modelSource !== "host-selected" ||
    hostEvidence.reviewer?.attestation !== "host-declared"
  ) {
    fail(`${phase} host evidence has invalid reviewer provenance`);
  }
  if (
    codexEvidence.reviewer?.lane !== "codex" ||
    codexEvidence.reviewer?.modelSource !== "worker-resolved" ||
    codexEvidence.execution?.fresh !== true ||
    codexEvidence.execution?.sandbox !== "read-only" ||
    codexEvidence.execution?.approvalPolicy !== "never" ||
    codexEvidence.execution?.ephemeral !== true
  ) {
    fail(`${phase} Codex evidence has invalid execution provenance`);
  }
  const reviewedPaths = new Set([
    ...seal.artifacts.map((artifact) => artifact.path),
    ...(comparison?.changedPaths ?? []),
  ]);
  for (const evidence of [hostEvidence, codexEvidence]) {
    if (
      evidence.findings.some(
        (finding) => !reviewedPaths.has(finding.artifactPath),
      )
    ) {
      fail(`${phase} evidence contains a finding outside the sealed scope`);
    }
  }

  const hostDigest = jsonDigest(hostEvidence);
  const codexDigest = jsonDigest(codexEvidence);
  if (
    review.hostEvidenceDigest !== hostDigest ||
    review.gate?.evidenceDigests?.host !== hostDigest ||
    review.gate?.evidenceDigests?.codex !== codexDigest
  ) {
    fail(
      `${phase} evidence digests do not match the returned provider evidence`,
    );
  }
  if (
    review.gate?.passed !== true ||
    review.gate?.status !== "ready" ||
    review.gate?.sealId !== seal.sealId ||
    !Array.isArray(review.gate.reasons) ||
    review.gate.reasons.length !== 0 ||
    !Array.isArray(review.gate.freshnessReasons) ||
    review.gate.freshnessReasons.length !== 0
  ) {
    fail(`${phase} strict dual-review gate did not pass cleanly`);
  }
  assertOnlyKeys(
    review.gate,
    [
      "passed",
      "status",
      "sealId",
      "reasons",
      "freshnessReasons",
      "evidenceDigests",
    ],
    `${phase} strict gate`,
  );
  assertOnlyKeys(
    review.gate.evidenceDigests,
    ["host", "codex"],
    `${phase} gate evidence digests`,
  );
  assertOuterProjection(claudeReview, hostEvidence, `${phase} Claude review`);
  assertOuterProjection(codexReview, codexEvidence, `${phase} Codex review`);
}

function validateComparison(value, phase) {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.baseRevision) ||
    !Array.isArray(value.changedPaths) ||
    value.changedPaths.length > 256
  ) {
    fail(`${phase} Codex comparison is malformed`);
  }
  assertOnlyKeys(
    value,
    ["baseRevision", "changedPaths", "diffSha256"],
    `${phase} Codex comparison`,
  );
  const changedPaths = value.changedPaths.map((path) =>
    safeRepositoryPath(path, `${phase} comparison path`),
  );
  if (
    new Set(changedPaths).size !== changedPaths.length ||
    canonicalDigest(changedPaths) !==
      canonicalDigest([...changedPaths].sort(compareCodeUnits))
  ) {
    fail(`${phase} Codex comparison paths are not canonical`);
  }
  assertSha256(value.diffSha256, `${phase} comparison diff digest`);
  return {
    baseRevision: value.baseRevision,
    changedPaths,
    diffSha256: value.diffSha256,
  };
}

function assertProviderEvidence(evidence, provider, phase, sealId) {
  assertOnlyKeys(
    evidence,
    [
      "schemaVersion",
      "reviewId",
      "phase",
      "sealId",
      "reviewer",
      ...(provider === "codex" ? ["execution"] : []),
      "verdict",
      "summary",
      "findings",
    ],
    `${phase} ${provider} evidence`,
  );
  if (
    evidence?.schemaVersion !== 1 ||
    evidence.phase !== phase ||
    evidence.sealId !== sealId ||
    evidence.reviewer?.provider !== provider ||
    !new Set(["approved", "changes-requested"]).has(evidence.verdict) ||
    typeof evidence.summary !== "string" ||
    evidence.summary.trim() === "" ||
    evidence.summary.length > 8000 ||
    !Array.isArray(evidence.findings) ||
    evidence.findings.length > 100
  ) {
    fail(`${phase} ${provider} evidence is malformed`);
  }
  assertSafeIdentifier(evidence.reviewId, `${phase} ${provider} review id`);
  assertOnlyKeys(
    evidence.reviewer,
    provider === "codex"
      ? ["provider", "lane", "modelSource", "model", "reasoningEffort"]
      : [
          "provider",
          "lane",
          "modelSource",
          "attestation",
          "declaredModelLabel",
        ],
    `${phase} ${provider} reviewer`,
  );
  if (provider === "codex") {
    assertSafeIdentifier(
      evidence.reviewer.model,
      `${phase} Codex reviewer model`,
    );
    if (
      !new Set([
        "server-default",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
      ]).has(evidence.reviewer.reasoningEffort)
    ) {
      fail(`${phase} Codex reviewer reasoning effort is invalid`);
    }
    assertOnlyKeys(
      evidence.execution,
      ["fresh", "sandbox", "approvalPolicy", "ephemeral"],
      `${phase} Codex execution`,
    );
  } else if (
    evidence.reviewer.declaredModelLabel !== undefined &&
    (typeof evidence.reviewer.declaredModelLabel !== "string" ||
      evidence.reviewer.declaredModelLabel.trim() === "" ||
      evidence.reviewer.declaredModelLabel.length > 128)
  ) {
    fail(`${phase} Claude declared model label is invalid`);
  }
  const findingIds = new Set();
  for (const [index, finding] of evidence.findings.entries()) {
    assertOnlyKeys(
      finding,
      [
        "id",
        "severity",
        "requirement",
        "summary",
        "artifactPath",
        "line",
        "nextAction",
      ],
      `${phase} ${provider} finding ${index}`,
    );
    assertSafeIdentifier(finding.id, `${phase} ${provider} finding id`);
    if (findingIds.has(finding.id)) {
      fail(`${phase} ${provider} evidence repeats a finding id`);
    }
    findingIds.add(finding.id);
    if (
      !new Set(["low", "medium", "high", "critical"]).has(finding.severity) ||
      !boundedText(finding.requirement, 512) ||
      !boundedText(finding.summary, 2000) ||
      !boundedText(finding.nextAction, 2000)
    ) {
      fail(`${phase} ${provider} finding ${index} is malformed`);
    }
    safeRepositoryPath(
      finding.artifactPath,
      `${phase} ${provider} finding path`,
    );
    if (
      finding.line !== undefined &&
      (!Number.isSafeInteger(finding.line) ||
        finding.line < 1 ||
        finding.line > 10_000_000)
    ) {
      fail(`${phase} ${provider} finding line is invalid`);
    }
  }
  if (
    evidence.verdict === "changes-requested" &&
    evidence.findings.length === 0
  ) {
    fail(`${phase} ${provider} changes-requested evidence needs a finding`);
  }
  if (
    evidence.verdict === "approved" &&
    evidence.findings.some(
      (finding) =>
        finding.severity === "high" || finding.severity === "critical",
    )
  ) {
    fail(
      `${phase} ${provider} cannot approve with an unresolved High or Critical finding`,
    );
  }
}

function assertOuterProjection(outer, evidence, label) {
  if (
    (evidence.reviewer?.provider === "claude" &&
      outer.reviewId !== evidence.reviewId) ||
    (evidence.reviewer?.provider === "codex" &&
      ((outer.model ?? "server-default") !== evidence.reviewer.model ||
        (outer.reasoningEffort ?? "server-default") !==
          evidence.reviewer.reasoningEffort)) ||
    outer.verdict !== evidence.verdict ||
    outer.summary !== evidence.summary ||
    canonicalDigest(outer.findings) !== canonicalDigest(evidence.findings)
  ) {
    fail(`${label} does not exactly project the returned provider evidence`);
  }
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertOnlyKeys(value, allowed, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    fail(`${label} contains unsupported fields: ${unknown.sort().join(", ")}`);
  }
}

function boundedText(value, maximum) {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= maximum &&
    // eslint-disable-next-line no-control-regex -- review prose permits only tab, LF, and CR controls.
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  );
}
