import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL, fileURLToPath } from "node:url";

import {
  SddRoutingError,
  normalizeProjectProfile,
  projectProfileFingerprint,
  routeProfiledSddTasks,
  routeSddTasks,
} from "../dist/index.js";

const corpusPath = fileURLToPath(
  new URL("../benchmarks/routing-conformance-corpus.json", import.meta.url),
);
const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
const results = [];
const {
  expectedPlanFingerprint: expectedLegacyPlanFingerprint,
  ...legacyRouteInput
} = corpus.legacyRoute;

assert.equal(corpus.schemaVersion, 1, "unsupported conformance corpus");

runInvariant("legacy-contract-golden", () => {
  const plan = routeSddTasks(legacyRouteInput);
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.routingPolicyVersion, "sdd-routing-v2");
  assert.equal(plan.fitPolicyVersion, "sdd-task-fit-v1");
  assert.match(plan.planFingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(plan.planFingerprint, expectedLegacyPlanFingerprint);
});

runInvariant("legacy-input-order-determinism", () => {
  const canonical = routeSddTasks(legacyRouteInput);
  const reordered = routeSddTasks({
    ...legacyRouteInput,
    tasks: [...legacyRouteInput.tasks].reverse(),
  });
  assert.deepEqual(reordered, canonical);
});

runInvariant("profile-canonical-equivalence", () => {
  const profile = corpus.profiledRoute.projectProfile;
  const reordered = reorderProfile(profile);
  assert.equal(
    projectProfileFingerprint(normalizeProjectProfile(reordered)),
    projectProfileFingerprint(normalizeProjectProfile(profile)),
  );
  assert.deepEqual(
    routeProfiledSddTasks({
      ...corpus.profiledRoute,
      projectProfile: reordered,
      tasks: [...corpus.profiledRoute.tasks].reverse(),
    }),
    routeProfiledSddTasks(corpus.profiledRoute),
  );
});

runInvariant("profiled-contract-and-binding", () => {
  const plan = routeProfiledSddTasks(corpus.profiledRoute);
  assert.equal(plan.schemaVersion, 2);
  assert.equal(plan.routingPolicyVersion, "sdd-routing-v3");
  assert.equal(plan.fitPolicyVersion, "sdd-capability-fit-v1");
  assert.equal(plan.projectProfile.profileId, "conformance-fixture");
  assert.match(plan.projectProfile.profileFingerprint, /^[a-f0-9]{64}$/u);
  assert.match(plan.planFingerprint, /^[a-f0-9]{64}$/u);

  const changedProfile = cloneJson(corpus.profiledRoute.projectProfile);
  changedProfile.profileVersion = "1.0.1";
  const changed = routeProfiledSddTasks({
    ...corpus.profiledRoute,
    projectProfile: changedProfile,
  });
  assert.notEqual(
    changed.projectProfile.profileFingerprint,
    plan.projectProfile.profileFingerprint,
  );
  assert.notEqual(changed.planFingerprint, plan.planFingerprint);
});

runInvariant("hard-eligibility-precedes-capability-fit", () => {
  const task = cloneJson(corpus.profiledRoute.tasks[0]);
  task.id = "hard-codex";
  task.eligibleLanes = ["codex"];
  const plan = routeProfiledSddTasks({
    projectProfile: corpus.profiledRoute.projectProfile,
    tasks: [task],
  });
  const routed = assignment(plan, task.id);
  assert.equal(routed.lane, "codex");
  assert.equal(routed.decisionStage, "hard-eligibility");
});

runInvariant("capability-minimum-removes-ineligible-lane", () => {
  const plan = routeProfiledSddTasks(corpus.profiledRoute);
  const routed = assignment(plan, "T003-testing");
  assert.deepEqual(routed.explicitEligibleLanes, ["codex", "claude-host"]);
  assert.deepEqual(routed.effectiveEligibleLanes, ["codex"]);
  assert.equal(routed.capabilityEligibility.codex, true);
  assert.equal(routed.capabilityEligibility["claude-host"], false);
  assert.equal(routed.decisionStage, "capability-eligibility");
});

runInvariant("capability-fit-overrides-soft-preference", () => {
  const plan = routeProfiledSddTasks(corpus.profiledRoute);
  const routed = assignment(plan, "T002-implementation");
  assert.equal(routed.lane, "codex");
  assert.equal(routed.decisionStage, "capability-fit");
  assert.ok(
    routed.reasons.some(
      ({ code }) => code === "PREFERRED_LANE_OVERRIDDEN_BY_FIT",
    ),
  );
});

runInvariant("required-checks-bind-canonical-command-digests", () => {
  const plan = routeProfiledSddTasks(corpus.profiledRoute);
  const implementation = assignment(plan, "T002-implementation");
  const testing = assignment(plan, "T003-testing");
  const review = assignment(plan, "T004-review");

  assert.deepEqual(
    implementation.requiredCheckProfiles.map(({ id }) => id),
    ["policy-check", "unit-check"],
  );
  assert.deepEqual(
    testing.requiredCheckProfiles.map(({ id }) => id),
    ["unit-check"],
  );
  assert.deepEqual(review.requiredCheckProfiles, []);

  const definitions = new Map(
    corpus.profiledRoute.projectProfile.checkProfiles.map((check) => [
      check.id,
      check,
    ]),
  );
  for (const requirement of implementation.requiredCheckProfiles) {
    const definition = definitions.get(requirement.id);
    assert.ok(definition, `missing check definition ${requirement.id}`);
    assert.equal(requirement.cwd, definition.cwd);
    assert.equal(
      requirement.commandSha256,
      canonicalSha256({ argv: definition.argv, cwd: definition.cwd }),
    );
  }
});

runInvariant("codex-policy-precedence-and-server-marker", () => {
  const plan = routeProfiledSddTasks(corpus.profiledRoute);
  const planning = assignment(plan, "T001-planning");
  const implementation = assignment(plan, "T002-implementation");
  const review = assignment(plan, "T004-review");

  assert.deepEqual(planning.codexPolicy, {
    source: "project-profile",
    purpose: "cross-review",
    model: null,
    reasoningEffort: null,
    serverAllowlistRequired: false,
  });
  assert.equal(implementation.codexPolicy.model, "fixture-high-risk-model");
  assert.equal(implementation.codexPolicy.reasoningEffort, "xhigh");
  assert.equal(implementation.codexPolicy.purpose, "execution");
  assert.equal(implementation.codexPolicy.serverAllowlistRequired, true);
  assert.equal(review.codexPolicy.model, "fixture-high-risk-model");
  assert.equal(review.codexPolicy.purpose, "cross-review");
});

runInvariant("global-cross-review-highest-risk-kind-default-precedence", () => {
  const profile = cloneJson(corpus.profiledRoute.projectProfile);
  profile.codexPolicy.default = corpus.crossReviewPolicyCases.defaultPolicy;
  profile.codexPolicy.byKind.review =
    corpus.crossReviewPolicyCases.reviewKindPolicy;

  const highestRisk = routeProfiledSddTasks({
    ...corpus.profiledRoute,
    projectProfile: profile,
  });
  assert.deepEqual(highestRisk.crossReviewPolicy, {
    source: "project-profile",
    purpose: "cross-review",
    model: "fixture-high-risk-model",
    reasoningEffort: "xhigh",
    serverAllowlistRequired: true,
  });

  const reviewKind = routeProfiledSddTasks({
    projectProfile: profile,
    tasks: [corpus.crossReviewPolicyCases.mediumReviewTask],
  });
  assert.deepEqual(reviewKind.crossReviewPolicy, {
    source: "project-profile",
    purpose: "cross-review",
    ...corpus.crossReviewPolicyCases.reviewKindPolicy,
    serverAllowlistRequired: true,
  });

  delete profile.codexPolicy.byKind.review;
  const fallback = routeProfiledSddTasks({
    projectProfile: profile,
    tasks: [corpus.crossReviewPolicyCases.mediumReviewTask],
  });
  assert.deepEqual(fallback.crossReviewPolicy, {
    source: "project-profile",
    purpose: "cross-review",
    ...corpus.crossReviewPolicyCases.defaultPolicy,
    serverAllowlistRequired: true,
  });
});

runInvariant("global-cross-review-policy-fingerprint-mutation", () => {
  const baselineProfile = cloneJson(corpus.profiledRoute.projectProfile);
  baselineProfile.codexPolicy.byKind.review =
    corpus.crossReviewPolicyCases.reviewKindPolicy;
  const baseline = routeProfiledSddTasks({
    projectProfile: baselineProfile,
    tasks: [corpus.crossReviewPolicyCases.mediumReviewTask],
  });

  const changedProfile = cloneJson(baselineProfile);
  changedProfile.codexPolicy.byKind.review =
    corpus.crossReviewPolicyCases.mutatedReviewKindPolicy;
  const changed = routeProfiledSddTasks({
    projectProfile: changedProfile,
    tasks: [corpus.crossReviewPolicyCases.mediumReviewTask],
  });

  assert.notDeepEqual(changed.crossReviewPolicy, baseline.crossReviewPolicy);
  assert.notEqual(changed.planFingerprint, baseline.planFingerprint);
});

runInvariant("critical-codex-policy-is-exact-or-refuse", () => {
  const criticalTask = {
    id: "critical-review",
    effortPoints: 1,
    risk: "critical",
    authority: "read-only",
    kind: "review",
    eligibleLanes: ["claude-host"],
  };
  const accepted = routeProfiledSddTasks({
    projectProfile: corpus.profiledRoute.projectProfile,
    tasks: [criticalTask],
  });
  assert.equal(
    assignment(accepted, criticalTask.id).codexPolicy.model,
    "fixture-critical-model",
  );
  assert.equal(
    assignment(accepted, criticalTask.id).codexPolicy.reasoningEffort,
    "ultra",
  );
  assert.deepEqual(accepted.crossReviewPolicy, {
    source: "project-profile",
    purpose: "cross-review",
    model: "fixture-critical-model",
    reasoningEffort: "ultra",
    serverAllowlistRequired: true,
  });

  const missingCritical = cloneJson(corpus.profiledRoute.projectProfile);
  delete missingCritical.codexPolicy.byRisk.critical;
  expectRoutingError(
    () =>
      routeProfiledSddTasks({
        projectProfile: missingCritical,
        tasks: [criticalTask],
      }),
    "CRITICAL_CODEX_POLICY_REQUIRED",
  );
});

runInvariant("write-policy-refuses-outside-and-denied-scopes", () => {
  const outside = cloneJson(corpus.profiledRoute.tasks[1]);
  outside.id = "outside-write-root";
  outside.dependencies = [];
  outside.writeScopes = ["docs"];
  expectRoutingError(
    () =>
      routeProfiledSddTasks({
        projectProfile: corpus.profiledRoute.projectProfile,
        tasks: [outside],
      }),
    "WRITE_POLICY_VIOLATION",
  );

  const denied = cloneJson(outside);
  denied.id = "denied-write-root";
  denied.writeScopes = ["src/generated/output"];
  expectRoutingError(
    () =>
      routeProfiledSddTasks({
        projectProfile: corpus.profiledRoute.projectProfile,
        tasks: [denied],
      }),
    "WRITE_POLICY_VIOLATION",
  );
});

runInvariant("strict-profile-data-rejects-unknown-fields", () => {
  const profile = cloneJson(corpus.profiledRoute.projectProfile);
  profile.executablePlugin = "not-allowed";
  expectRoutingError(
    () => normalizeProjectProfile(profile),
    "INVALID_PROJECT_PROFILE",
  );
});

runInvariant("dependency-order-and-single-writer-waves", () => {
  const plan = routeProfiledSddTasks(corpus.profiledRoute);
  const tasks = new Map(plan.tasks.map((task) => [task.id, task]));
  const assignments = new Map(
    plan.assignments.map((entry) => [entry.taskId, entry]),
  );
  for (const task of plan.tasks) {
    const current = assignments.get(task.id);
    assert.ok(current, `missing assignment ${task.id}`);
    for (const dependency of task.dependencies) {
      const prior = assignments.get(dependency);
      assert.ok(prior, `missing dependency assignment ${dependency}`);
      assert.ok(
        prior.wave < current.wave,
        `${dependency} must precede ${task.id}`,
      );
    }
  }
  for (const wave of plan.waves) {
    const writers = wave.taskIds.filter(
      (taskId) => tasks.get(taskId)?.authority === "write",
    );
    assert.ok(writers.length <= 1, `wave ${wave.wave} has multiple writers`);
    assert.equal(wave.writerTaskId, writers[0]);
  }
});

runInvariant("executor-descriptors-preserve-one-way-boundary", () => {
  const { executors } = routeProfiledSddTasks(corpus.profiledRoute);
  assert.deepEqual(
    executors.map(({ id, launchedByWorker, modelSource }) => ({
      id,
      launchedByWorker,
      modelSource,
    })),
    [
      {
        id: "claude-host",
        launchedByWorker: false,
        modelSource: "host-selected",
      },
      {
        id: "codex-worker",
        launchedByWorker: true,
        modelSource: "server-allowlisted",
      },
    ],
  );
});

const failed = results.filter(({ status }) => status === "failed").length;
const report = {
  schemaVersion: 1,
  evaluation: "routing-policy-conformance",
  corpusId: corpus.corpusId,
  credentialFree: true,
  providerCalls: 0,
  total: results.length,
  passed: results.length - failed,
  failed,
  invariants: results,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (failed > 0) {
  process.exitCode = 1;
}

function runInvariant(id, check) {
  try {
    check();
    results.push({ id, status: "passed" });
  } catch (error) {
    results.push({
      id,
      status: "failed",
      error:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : "Unknown conformance failure",
    });
  }
}

function assignment(plan, taskId) {
  const value = plan.assignments.find((entry) => entry.taskId === taskId);
  assert.ok(value, `missing assignment ${taskId}`);
  return value;
}

function expectRoutingError(operation, code) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof SddRoutingError);
    assert.equal(error.code, code);
    return true;
  });
}

function reorderProfile(profile) {
  return {
    writePolicy: {
      additionalDeniedRoots: [
        ...(profile.writePolicy.additionalDeniedRoots ?? []),
      ].reverse(),
      allowedRoots: [...profile.writePolicy.allowedRoots].reverse(),
    },
    codexPolicy: {
      byRisk: reverseRecord(profile.codexPolicy.byRisk ?? {}),
      byKind: reverseRecord(profile.codexPolicy.byKind ?? {}),
      default: reverseRecord(profile.codexPolicy.default),
    },
    requiredChecks: {
      byAuthority: reverseRecord(profile.requiredChecks?.byAuthority ?? {}),
      byRisk: reverseRecord(profile.requiredChecks?.byRisk ?? {}),
      byKind: reverseRecord(profile.requiredChecks?.byKind ?? {}),
      always: [...(profile.requiredChecks?.always ?? [])].reverse(),
    },
    checkProfiles: [...profile.checkProfiles].reverse(),
    taskPolicies: [...profile.taskPolicies].reverse().map((policy) => ({
      requirements: [...policy.requirements].reverse(),
      kind: policy.kind,
    })),
    laneCapabilities: {
      "claude-host": [...profile.laneCapabilities["claude-host"]].reverse(),
      codex: [...profile.laneCapabilities.codex].reverse(),
    },
    profileVersion: profile.profileVersion,
    profileId: profile.profileId,
    schemaVersion: profile.schemaVersion,
  };
}

function reverseRecord(value) {
  return Object.fromEntries(Object.entries(value).reverse());
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalSha256(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}
