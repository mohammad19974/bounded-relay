#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import { TextDecoder } from "node:util";

import {
  artifactRevision,
  artifactRevisionAt,
  assertIsoDate,
  assertJobId,
  assertModel,
  assertReview,
  assertRevisionAncestor,
  assertRevisionEqual,
  assertSafeIdentifier,
  assertSha256,
  canonicalDigest,
  evidencePath,
  fail,
  fileDigest,
  hostReviewContextId,
  printSuccess,
  readCommittedRepositoryFile,
  readJson,
  requireSchema,
  workflowContext,
  writeJsonAtomic,
} from "./evidence-core.mjs";
import { assertStrictSddReview } from "./strict-review.mjs";

const PROVIDERS = new Set(["codex", "claude-host"]);
const RISKS = new Set(["low", "medium", "high", "critical"]);
const AUTHORITIES = new Set(["read-only", "write"]);
const ROUTING_POLICY_VERSION = "sdd-routing-v2";
const FIT_POLICY_VERSION = "sdd-task-fit-v1";
const MAX_ROUTED_TASKS = 64;
const STANDARD_TASK_ID = /^T[0-9]{3,}$/u;
const TASK_CHECKBOX_LINE = /^\s*-\s+\[[ xX]\](?:\s|$)/u;
const TASK_CHECKBOX = /^\s*-\s+\[([ xX])\]\s+(\S+)(?:\s|$)/u;
const SELECTION_ORDER = [
  "hard-eligibility",
  "quality-fit",
  "preferred-lane-tie-break",
  "neutral-effort-balance",
  "neutral-task-count-balance",
  "odd-neutral-tie-to-codex",
  "lexical-task-id",
];
const KINDS = new Set([
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
]);
const ROUTER_ENTRY = fileURLToPath(
  new URL("../../../../dist/cli.js", import.meta.url),
);

function authoritativeRoute(request) {
  const execution = spawnSync(
    process.execPath,
    [ROUTER_ENTRY, "sdd", "route"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      input: JSON.stringify(request),
      maxBuffer: 2 * 1024 * 1024,
      shell: false,
    },
  );
  if (execution.error || execution.status !== 0) {
    fail(
      "the packaged authoritative SDD router is unavailable or rejected the recorded request",
    );
  }
  try {
    return JSON.parse(execution.stdout);
  } catch {
    fail("the packaged authoritative SDD router returned invalid JSON");
  }
}

function approvedPlanReview(context, runId, routingRevision) {
  const path = evidencePath(context, "plan-review");
  const document = readJson(path, "plan review evidence");
  requireSchema(document, runId, "plan-review");
  if (
    document.state !== "complete" ||
    document.reconciliation?.verdict !== "approved" ||
    document.claudeReview?.verdict !== "approved" ||
    document.codexReview?.verdict !== "approved"
  ) {
    fail("routing requires an approved dual plan review");
  }
  const reviewedRevision = artifactRevisionAt(
    context,
    document.revision?.head,
    ["spec.md", "plan.md"],
  );
  assertRevisionEqual(
    document.revision,
    reviewedRevision,
    "historical approved plan revision",
  );
  assertRevisionAncestor(
    context,
    reviewedRevision.head,
    routingRevision.head,
    "approved plan to routing checkpoint",
  );
  const routingPlanArtifacts = routingRevision.artifacts.filter(
    (artifact) =>
      artifact.path === `${context.featureDirectory}/spec.md` ||
      artifact.path === `${context.featureDirectory}/plan.md`,
  );
  if (
    canonicalDigest(routingPlanArtifacts) !==
    canonicalDigest(reviewedRevision.artifacts)
  ) {
    fail("spec.md or plan.md changed after the approved plan review");
  }
  assertReview(
    document.claudeReview,
    "claude",
    document.revision.seal,
    "Claude plan review",
  );
  if (
    document.claudeReview.modelSource !== "host-selected" ||
    document.claudeReview.reviewId !== hostReviewContextId(document, "plan")
  ) {
    fail("Claude plan review provenance or frozen context is invalid");
  }
  assertModel(document.claudeReview.model ?? null, "Claude plan review model");
  assertReview(
    document.codexReview,
    "codex",
    document.revision.seal,
    "Codex plan review",
  );
  if (document.codexReview.modelSource !== "worker-resolved") {
    fail("Codex plan review must preserve worker-resolved provenance");
  }
  assertModel(document.codexReview.model ?? null, "Codex plan review model");
  assertJobId(document.codexReview.jobId, "Codex plan review job id");
  assertStrictSddReview(
    document.codexReview,
    document.claudeReview,
    document.revision,
    "plan",
  );
  if (
    Date.parse(document.codexReview.startedAt) <
    Date.parse(document.claudeReview.completedAt)
  ) {
    fail("Codex plan review started before Claude findings were frozen");
  }
  if (
    typeof document.reconciliation.summary !== "string" ||
    document.reconciliation.summary.trim() === "" ||
    document.reconciliation.summary.length > 8000
  ) {
    fail("approved plan review reconciliation is invalid");
  }
  assertIsoDate(
    document.reconciliation.completedAt,
    "plan review reconciliation.completedAt",
  );
  return { path, sha256: fileDigest(path, "plan review evidence") };
}

function taskManifest(context, revision) {
  const sourcePath = `${context.featureDirectory}/tasks.md`;
  const sourceArtifact = revision.artifacts.find(
    (artifact) => artifact.path === sourcePath,
  );
  if (sourceArtifact === undefined) {
    fail("routing revision does not seal tasks.md");
  }
  const bytes = readCommittedRepositoryFile(
    context,
    revision.head,
    sourcePath,
    "routing task manifest",
  );
  let markdown;
  try {
    markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("tasks.md must be valid UTF-8");
  }
  const tasks = [];
  for (const [index, line] of markdown.split(/\r?\n/u).entries()) {
    const match = TASK_CHECKBOX.exec(line);
    if (match === null) {
      if (TASK_CHECKBOX_LINE.test(line)) {
        fail(`tasks.md line ${index + 1} is missing a standard T### task id`);
      }
      continue;
    }
    const id = match[2];
    assertSafeIdentifier(id, `tasks.md line ${index + 1} task id`);
    if (!STANDARD_TASK_ID.test(id)) {
      fail(`tasks.md line ${index + 1} must use a standard T### task id`);
    }
    tasks.push({ id, completed: match[1].toLowerCase() === "x" });
  }
  if (tasks.length === 0 || tasks.length > MAX_ROUTED_TASKS) {
    fail(`tasks.md must contain 1-${MAX_ROUTED_TASKS} checkbox tasks`);
  }
  tasks.sort((left, right) => compareCodeUnits(left.id, right.id));
  const taskIds = tasks.map((task) => task.id);
  if (new Set(taskIds).size !== taskIds.length) {
    fail("tasks.md contains duplicate task ids");
  }
  const pendingTaskIds = tasks
    .filter((task) => !task.completed)
    .map((task) => task.id);
  if (pendingTaskIds.length === 0) {
    fail("routing requires at least one incomplete task in tasks.md");
  }
  return {
    schemaVersion: 1,
    sourcePath,
    sourceSha256: sourceArtifact.sha256,
    tasks,
    pendingTaskIds,
  };
}

function assertTaskManifest(document, expectedManifest) {
  const expectedDigest = canonicalDigest(expectedManifest);
  assertSha256(document.taskManifestSha256, "routing task manifest digest");
  if (
    document.taskManifestSha256 !== expectedDigest ||
    canonicalDigest(document.taskManifest) !== expectedDigest
  ) {
    fail("routing task manifest is stale or malformed");
  }
}

function verifyRouterEvidence(
  router,
  targetBasisPoints,
  assignments,
  manifest,
) {
  if (
    typeof router !== "object" ||
    router === null ||
    router.tool !== "codex_worker_sdd_route"
  ) {
    fail("routing must use codex_worker_sdd_route");
  }
  if (
    router.request?.neutralCodexShareBps !== targetBasisPoints ||
    !Array.isArray(router.request?.tasks)
  ) {
    fail("recorded SDD route request does not match the workflow target");
  }
  const result = router.result;
  if (
    typeof result !== "object" ||
    result === null ||
    result.schemaVersion !== 1 ||
    result.routingPolicyVersion !== ROUTING_POLICY_VERSION ||
    result.fitPolicyVersion !== FIT_POLICY_VERSION ||
    canonicalDigest(result.selectionOrder) !==
      canonicalDigest(SELECTION_ORDER) ||
    !Array.isArray(result.tasks) ||
    !Array.isArray(result.assignments) ||
    !Array.isArray(result.waves) ||
    !Array.isArray(result.reasons)
  ) {
    fail("recorded SDD route result is incomplete");
  }
  const expectedTaskIds = manifest.pendingTaskIds;
  for (const [label, taskIds] of [
    ["router request", router.request.tasks.map((task) => task?.id)],
    ["router result", result.tasks.map((task) => task?.id)],
    [
      "router assignments",
      result.assignments.map((assignment) => assignment?.taskId),
    ],
    [
      "workflow assignments",
      assignments.map((assignment) => assignment?.taskId),
    ],
  ]) {
    if (canonicalDigest(taskIds) !== canonicalDigest(expectedTaskIds)) {
      fail(`${label} does not exactly cover the committed task manifest`);
    }
  }
  assertSha256(result.planFingerprint, "SDD route plan fingerprint");
  const fingerprintPayload = {
    schemaVersion: result.schemaVersion,
    routingPolicyVersion: result.routingPolicyVersion,
    fitPolicyVersion: result.fitPolicyVersion,
    neutralCodexShareBps: result.balance?.neutralCodexShareBps,
    selectionOrder: result.selectionOrder,
    tasks: result.tasks,
    assignments: result.assignments.map((assignment) => ({
      taskId: assignment.taskId,
      lane: assignment.lane,
      wave: assignment.wave,
      decisionStage: assignment.decisionStage,
      laneFit: assignment.laneFit,
      reasonCodes: Array.isArray(assignment.reasons)
        ? assignment.reasons.map((reason) => reason.code)
        : [],
    })),
    waves: result.waves,
    reasonCodes: result.reasons.map((reason) => reason.code),
  };
  if (canonicalDigest(fingerprintPayload) !== result.planFingerprint) {
    fail("SDD route plan fingerprint does not match the returned plan");
  }
  const authoritative = authoritativeRoute(router.request);
  if (canonicalDigest(authoritative) !== canonicalDigest(result)) {
    fail("recorded SDD route result differs from the authoritative router");
  }
  if (
    result.balance?.neutralCodexShareBps !== targetBasisPoints ||
    canonicalDigest(router.request.tasks) !== canonicalDigest(result.tasks)
  ) {
    fail("SDD route result does not match its recorded normalized request");
  }
  const taskById = new Map(result.tasks.map((task) => [task.id, task]));
  const routeById = new Map(
    result.assignments.map((assignment) => [assignment.taskId, assignment]),
  );
  if (
    taskById.size !== assignments.length ||
    routeById.size !== assignments.length
  ) {
    fail("SDD route result and workflow assignments have different task sets");
  }
  for (const assignment of assignments) {
    const task = taskById.get(assignment.taskId);
    const route = routeById.get(assignment.taskId);
    if (
      task?.effortPoints !== assignment.effort ||
      task?.risk !== assignment.risk ||
      task?.authority !== assignment.authority ||
      task?.kind !== assignment.kind ||
      canonicalDigest(task?.dependencies) !==
        canonicalDigest(assignment.dependencies) ||
      canonicalDigest(task?.writeScopes) !==
        canonicalDigest(assignment.writePaths) ||
      route?.lane !== assignment.provider ||
      route?.wave !== assignment.wave
    ) {
      fail(
        `task ${assignment.taskId} does not match the fingerprinted SDD route result`,
      );
    }
  }
}

function parseShare(value) {
  const share = value === undefined || value === "" ? 50 : Number(value);
  if (!Number.isInteger(share) || share < 0 || share > 100) {
    fail("codex_share must be an integer from 0 to 100");
  }
  return share;
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedPath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > 4096 ||
    path.startsWith("/") ||
    path.includes("\0") ||
    path.includes("\\") ||
    /^[A-Za-z]:/u.test(path) ||
    path
      .split("/")
      .some(
        (part) =>
          part === "" ||
          part === "." ||
          part === ".." ||
          part.toLowerCase() === ".git",
      )
  ) {
    fail("routing assignment contains an unsafe path");
  }
  return path.replace(/\/$/u, "");
}

function pathsOverlap(left, right) {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

function verifyAssignment(assignment, revisionSeal) {
  assertSafeIdentifier(assignment.taskId, "task id");
  if (!PROVIDERS.has(assignment.provider) || !RISKS.has(assignment.risk)) {
    fail(`task ${assignment.taskId} has an invalid provider or risk`);
  }
  if (
    !PROVIDERS.has(assignment.reviewerProvider) ||
    assignment.reviewerProvider === assignment.provider
  ) {
    fail(`task ${assignment.taskId} requires the other provider as reviewer`);
  }
  if (
    !AUTHORITIES.has(assignment.authority) ||
    !KINDS.has(assignment.kind) ||
    !Number.isInteger(assignment.wave) ||
    assignment.wave < 1
  ) {
    fail(`task ${assignment.taskId} has invalid authority, kind, or wave`);
  }
  if (
    !Number.isInteger(assignment.effort) ||
    assignment.effort < 1 ||
    assignment.effort > 100
  ) {
    fail(`task ${assignment.taskId} effort must be an integer from 1 to 100`);
  }
  if (
    !Array.isArray(assignment.writePaths) ||
    assignment.writePaths.length > 100
  ) {
    fail(`task ${assignment.taskId} requires bounded write paths`);
  }
  assignment.writePaths = assignment.writePaths.map(normalizedPath);
  if (
    (assignment.authority === "write" && assignment.writePaths.length === 0) ||
    (assignment.authority === "read-only" && assignment.writePaths.length > 0)
  ) {
    fail(`task ${assignment.taskId} write paths do not match its authority`);
  }
  if (new Set(assignment.writePaths).size !== assignment.writePaths.length) {
    fail(`task ${assignment.taskId} contains duplicate write paths`);
  }
  if (
    !Array.isArray(assignment.dependencies) ||
    assignment.dependencies.some((item) => typeof item !== "string")
  ) {
    fail(`task ${assignment.taskId} dependencies are invalid`);
  }
  if (
    typeof assignment.rationale !== "string" ||
    assignment.rationale.trim() === "" ||
    assignment.rationale.length > 4000
  ) {
    fail(`task ${assignment.taskId} requires a bounded rationale`);
  }
  if (assignment.revisionSeal !== revisionSeal) {
    fail(`task ${assignment.taskId} is not bound to the current artifacts`);
  }

  const policy = assignment.modelPolicy;
  if (typeof policy !== "object" || policy === null) {
    fail(`task ${assignment.taskId} model policy is missing`);
  }
  if (assignment.provider === "claude-host") {
    if (policy.source !== "host-selected" || policy.model !== null) {
      fail(`task ${assignment.taskId} must not override the Claude host model`);
    }
  } else {
    if (policy.source !== "server-allowlisted") {
      fail(`task ${assignment.taskId} must use BoundedRelay model policy`);
    }
    assertModel(policy.model ?? null, `task ${assignment.taskId} Codex model`);
  }

  if (assignment.risk === "critical") {
    const solPolicy =
      assignment.provider === "codex" ? policy : assignment.reviewerModelPolicy;
    if (
      typeof solPolicy !== "object" ||
      solPolicy.source !== "server-allowlisted" ||
      solPolicy.model !== "gpt-5.6-sol" ||
      solPolicy.reasoningEffort !== "ultra"
    ) {
      fail(
        `critical task ${assignment.taskId} requires an allowlisted gpt-5.6-sol ultra lane`,
      );
    }
  }
}

try {
  const [action, runId] = process.argv.slice(2);
  if (!new Set(["prepare", "verify", "verify-static"]).has(action) || !runId) {
    fail("usage: routing.mjs <prepare|verify|verify-static> <run-id>");
  }
  const context = workflowContext(runId);
  const path = evidencePath(context, "routing");
  const codexShare = parseShare(context.inputs.codex_share);

  if (action === "prepare") {
    const revision = artifactRevision(context, [
      "spec.md",
      "plan.md",
      "tasks.md",
    ]);
    const planReview = approvedPlanReview(context, runId, revision);
    const manifest = taskManifest(context, revision);
    writeJsonAtomic(path, {
      schemaVersion: 1,
      kind: "routing",
      runId,
      state: "pending",
      revision,
      planReviewSha256: planReview.sha256,
      taskManifest: manifest,
      taskManifestSha256: canonicalDigest(manifest),
      target: {
        metric: "fit-neutral-estimated-effort",
        soft: true,
        codexPercent: codexShare,
        claudePercent: 100 - codexShare,
        tieBreak: "codex-on-true-50-50-odd-neutral-tie",
      },
      router: null,
      assignments: [],
      totals: null,
      deviations: [],
      preparedAt: new Date().toISOString(),
    });
    printSuccess({
      runId,
      state: "pending",
      codexPercent: codexShare,
      pendingTasks: manifest.pendingTaskIds.length,
      taskManifestSha256: canonicalDigest(manifest),
    });
  } else {
    const document = readJson(path, "routing evidence");
    requireSchema(document, runId, "routing");
    if (document.state !== "complete") {
      fail("routing evidence is incomplete");
    }
    const revision =
      action === "verify"
        ? artifactRevision(context, ["spec.md", "plan.md", "tasks.md"])
        : artifactRevisionAt(context, document.revision?.head, [
            "spec.md",
            "plan.md",
            "tasks.md",
          ]);
    assertRevisionEqual(
      document.revision,
      revision,
      action === "verify"
        ? "routing artifact revision"
        : "historical routing artifact revision",
    );
    const planReview = approvedPlanReview(context, runId, revision);
    if (document.planReviewSha256 !== planReview.sha256) {
      fail("routing is not bound to its current approved plan review");
    }
    const manifest = taskManifest(context, revision);
    assertTaskManifest(document, manifest);
    if (
      document.target?.metric !== "fit-neutral-estimated-effort" ||
      document.target.soft !== true ||
      document.target.codexPercent !== codexShare ||
      document.target.claudePercent !== 100 - codexShare ||
      document.target.tieBreak !== "codex-on-true-50-50-odd-neutral-tie"
    ) {
      fail("routing target does not match workflow inputs");
    }
    if (
      !Array.isArray(document.assignments) ||
      document.assignments.length === 0 ||
      document.assignments.length > 64
    ) {
      fail("routing assignments must be a bounded non-empty array");
    }
    for (const assignment of document.assignments) {
      verifyAssignment(assignment, document.revision.seal);
    }
    verifyRouterEvidence(
      document.router,
      codexShare * 100,
      document.assignments,
      manifest,
    );
    const taskIds = document.assignments.map((item) => item.taskId);
    if (new Set(taskIds).size !== taskIds.length) {
      fail("routing contains duplicate task ids");
    }
    if (
      canonicalDigest(taskIds) !==
      canonicalDigest(
        document.router.result.assignments.map((item) => item.taskId),
      )
    ) {
      fail("routing assignments must preserve authoritative canonical order");
    }
    for (
      let leftIndex = 0;
      leftIndex < document.assignments.length;
      leftIndex += 1
    ) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < document.assignments.length;
        rightIndex += 1
      ) {
        const left = document.assignments[leftIndex];
        const right = document.assignments[rightIndex];
        if (
          left.authority === "write" &&
          right.authority === "write" &&
          left.wave === right.wave &&
          left.writePaths.some((a) =>
            right.writePaths.some((b) => pathsOverlap(a, b)),
          )
        ) {
          fail(
            `routing gives overlapping writer scopes to ${left.taskId} and ${right.taskId}`,
          );
        }
      }
    }
    const totalEffort = document.assignments.reduce(
      (sum, item) => sum + item.effort,
      0,
    );
    const codexEffort = document.assignments
      .filter((item) => item.provider === "codex")
      .reduce((sum, item) => sum + item.effort, 0);
    const claudeEffort = totalEffort - codexEffort;
    const codexPercent = Number(((codexEffort / totalEffort) * 100).toFixed(2));
    const claudePercent = Number((100 - codexPercent).toFixed(2));
    if (
      document.totals?.totalEffort !== totalEffort ||
      document.totals.codexEffort !== codexEffort ||
      document.totals.claudeEffort !== claudeEffort ||
      document.totals.codexPercent !== codexPercent ||
      document.totals.claudePercent !== claudePercent
    ) {
      fail("routing totals do not match assignments");
    }
    const deviates = codexPercent !== codexShare;
    if (
      !Array.isArray(document.deviations) ||
      document.deviations.some(
        (item) =>
          typeof item !== "string" || item.trim() === "" || item.length > 1000,
      )
    ) {
      fail("routing deviation reasons are invalid");
    }
    if (deviates && document.deviations.length === 0) {
      fail("a non-target route requires an explicit deviation reason");
    }
    const authoritativeDeviations =
      document.router.result.balance.deviations.map((entry) => entry.message);
    if (
      canonicalDigest(document.deviations) !==
      canonicalDigest(authoritativeDeviations)
    ) {
      fail("routing deviations do not match the authoritative route");
    }
    printSuccess({
      runId,
      state: "complete",
      codexPercent,
      claudePercent,
      routingPolicyVersion: document.router.result.routingPolicyVersion,
      planFingerprint: document.router.result.planFingerprint,
      taskManifestSha256: document.taskManifestSha256,
      pendingTasks: manifest.pendingTaskIds.length,
      deviations: document.deviations.length,
    });
  }
} catch (error) {
  process.stderr.write(`Routing evidence error: ${error.message}\n`);
  process.exitCode = 1;
}
