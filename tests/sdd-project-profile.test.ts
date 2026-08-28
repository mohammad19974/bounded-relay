import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { sha256CanonicalJson } from "../src/sdd/routing/canonical.js";
import {
  SDD_ROUTING_ERROR_CODES,
  SddRoutingError,
  createProjectProfileTemplate,
  normalizeProjectProfile,
  projectProfileFingerprint,
  resolveCodexPolicy,
  resolveRequiredCheckProfiles,
  routeProfiledSddTasks,
  routeSddTasks,
  type SddProjectProfileInput,
  type SddRoutingInput,
  type SddRoutingTaskInput,
} from "../src/sdd/routing/index.js";

interface GoldenRoutingCase {
  readonly name: string;
  readonly input: SddRoutingInput;
  readonly planFingerprint: string;
  readonly jsonSha256: string;
}

interface GoldenRoutingFixture {
  readonly cases: readonly GoldenRoutingCase[];
}

type MutableValue<T> = T extends readonly (infer Entry)[]
  ? Mutable<Entry>[]
  : T extends object
    ? Mutable<T>
    : T;

type Mutable<T> = {
  -readonly [Key in keyof T]: MutableValue<T[Key]>;
};

function profile(): SddProjectProfileInput {
  return {
    schemaVersion: 1,
    profileId: "test-project",
    profileVersion: "1.0.0",
    laneCapabilities: {
      codex: [
        { id: "coding", score: 4 },
        { id: "reasoning", score: 3 },
        { id: "review", score: 3 },
      ],
      "claude-host": [
        { id: "coding", score: 2 },
        { id: "reasoning", score: 4 },
        { id: "review", score: 3 },
      ],
    },
    taskPolicies: [
      {
        kind: "implementation",
        requirements: [
          { capabilityId: "coding", minimumScore: 1, weight: 10 },
          { capabilityId: "reasoning", minimumScore: 1, weight: 2 },
        ],
      },
      {
        kind: "planning",
        requirements: [
          { capabilityId: "reasoning", minimumScore: 1, weight: 5 },
        ],
      },
      {
        kind: "review",
        requirements: [{ capabilityId: "review", minimumScore: 1, weight: 1 }],
      },
    ],
    checkProfiles: [
      { id: "lint", cwd: ".", argv: ["npm", "run", "lint"] },
      { id: "test", cwd: "packages/core", argv: ["npm", "test"] },
    ],
    requiredChecks: {
      always: ["lint"],
      byRisk: { high: ["test"], critical: ["test"] },
      byAuthority: { write: ["test"] },
    },
    codexPolicy: {
      default: { model: null, reasoningEffort: null },
      byKind: {
        implementation: {
          model: "implementation-model",
          reasoningEffort: "high",
        },
      },
      byRisk: {
        high: { model: "high-risk-model", reasoningEffort: "xhigh" },
        critical: { model: "critical-model", reasoningEffort: "ultra" },
      },
    },
    writePolicy: {
      allowedRoots: ["src", "tests"],
      additionalDeniedRoots: ["src/generated"],
    },
  };
}

function task(
  id: string,
  overrides: Partial<SddRoutingTaskInput> = {},
): SddRoutingTaskInput {
  return {
    id,
    effortPoints: 1,
    risk: "medium",
    authority: "read-only",
    kind: "review",
    ...overrides,
  };
}

function writer(
  id = "write",
  overrides: Partial<SddRoutingTaskInput> = {},
): SddRoutingTaskInput {
  return task(id, {
    authority: "write",
    kind: "implementation",
    writeScopes: ["src/features"],
    ...overrides,
  });
}

function expectRoutingError(
  operation: () => unknown,
  code: (typeof SDD_ROUTING_ERROR_CODES)[keyof typeof SDD_ROUTING_ERROR_CODES],
): SddRoutingError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(SddRoutingError);
    expect(error).toMatchObject({ code });
    return error as SddRoutingError;
  }
  throw new Error(`Expected routing error ${code}`);
}

function cloneProfile(
  value: SddProjectProfileInput = profile(),
): Record<string, unknown> {
  return structuredClone(value) as unknown as Record<string, unknown>;
}

function mutableProfile(
  value: SddProjectProfileInput = profile(),
): Mutable<SddProjectProfileInput> {
  return structuredClone(value) as Mutable<SddProjectProfileInput>;
}

function requiredValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Missing test fixture value: ${label}`);
  }
  return value;
}

describe("legacy SDD routing compatibility", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/sdd-routing-v2-golden.json", import.meta.url),
      "utf8",
    ),
  ) as GoldenRoutingFixture;

  for (const golden of fixture.cases) {
    test(`preserves ${golden.name} v2 output and fingerprint byte-for-byte`, () => {
      const plan = routeSddTasks(golden.input);
      const jsonSha256 = createHash("sha256")
        .update(JSON.stringify(plan))
        .digest("hex");

      expect(plan.planFingerprint).toBe(golden.planFingerprint);
      expect(jsonSha256).toBe(golden.jsonSha256);
      expect(plan.routingPolicyVersion).toBe("sdd-routing-v2");
    });
  }
});

describe("project profile normalization", () => {
  test("maps non-object JSON values to a typed profile error", () => {
    for (const value of [undefined, null, true, "profile", 1]) {
      expectRoutingError(
        () =>
          normalizeProjectProfile(value as unknown as SddProjectProfileInput),
        SDD_ROUTING_ERROR_CODES.INVALID_PROJECT_PROFILE,
      );
    }
  });

  test("creates a provider-neutral template covering every task kind", () => {
    const template = createProjectProfileTemplate();
    const normalized = normalizeProjectProfile(template);

    expect(template.taskPolicies).toHaveLength(11);
    expect(normalized.taskPolicies).toHaveLength(11);
    expect(template.codexPolicy).toEqual({
      default: { model: null, reasoningEffort: null },
    });
    expect(template.codexPolicy.byRisk).toBeUndefined();
    expect(template.checkProfiles).toEqual([]);
    expect(template.requiredChecks).toBeUndefined();
    expect(template.writePolicy.allowedRoots).toEqual([]);
    expect(() =>
      routeProfiledSddTasks({
        tasks: [task("normal")],
        projectProfile: template,
      }),
    ).not.toThrow();
    expectRoutingError(
      () =>
        routeProfiledSddTasks({
          tasks: [
            task("write", {
              kind: "implementation",
              authority: "write",
              writeScopes: ["src"],
            }),
          ],
          projectProfile: template,
        }),
      SDD_ROUTING_ERROR_CODES.WRITE_POLICY_VIOLATION,
    );
    expectRoutingError(
      () =>
        routeProfiledSddTasks({
          tasks: [task("critical", { risk: "critical" })],
          projectProfile: template,
        }),
      SDD_ROUTING_ERROR_CODES.CRITICAL_CODEX_POLICY_REQUIRED,
    );
  });

  test("canonicalizes arrays and map-like objects deterministically", () => {
    const first = profile();
    const second = mutableProfile(first);
    second.laneCapabilities.codex.reverse();
    second.laneCapabilities["claude-host"].reverse();
    second.taskPolicies.reverse();
    second.checkProfiles.reverse();
    second.writePolicy.allowedRoots.reverse();
    second.writePolicy.additionalDeniedRoots?.reverse();
    second.requiredChecks?.always?.reverse();

    const firstNormalized = normalizeProjectProfile(first);
    const secondNormalized = normalizeProjectProfile(second);
    expect(secondNormalized).toEqual(firstNormalized);
    expect(projectProfileFingerprint(secondNormalized)).toBe(
      projectProfileFingerprint(firstNormalized),
    );

    const firstPlan = routeProfiledSddTasks({
      tasks: [task("z"), task("a")],
      projectProfile: first,
    });
    const secondPlan = routeProfiledSddTasks({
      tasks: [task("a"), task("z")],
      projectProfile: second,
    });
    expect(secondPlan).toEqual(firstPlan);
  });

  test("rejects unknown provider, executable, Claude-model, and nested fields", () => {
    for (const mutation of [
      (value: Record<string, unknown>) => {
        value.claudeModel = "opus";
      },
      (value: Record<string, unknown>) => {
        value.provider = "vendor";
      },
      (value: Record<string, unknown>) => {
        const codexPolicy = value.codexPolicy as Record<string, unknown>;
        codexPolicy.executable = "codex";
      },
      (value: Record<string, unknown>) => {
        const laneCapabilities = value.laneCapabilities as Record<
          string,
          unknown[]
        >;
        (laneCapabilities.codex?.[0] as Record<string, unknown>).provider =
          "vendor";
      },
    ]) {
      const malformed = cloneProfile();
      mutation(malformed);
      expectRoutingError(
        () =>
          normalizeProjectProfile(
            malformed as unknown as SddProjectProfileInput,
          ),
        SDD_ROUTING_ERROR_CODES.INVALID_PROJECT_PROFILE,
      );
    }
  });

  test("rejects backslashes instead of silently normalizing profile paths", () => {
    const cwd = cloneProfile();
    requiredValue(
      (cwd.checkProfiles as Record<string, unknown>[])[0],
      "check profile",
    ).cwd = "tools\\ci";
    expectRoutingError(
      () => normalizeProjectProfile(cwd as unknown as SddProjectProfileInput),
      SDD_ROUTING_ERROR_CODES.INVALID_PROJECT_PROFILE,
    );

    const root = cloneProfile();
    (root.writePolicy as Record<string, unknown>).allowedRoots = [
      "src\\features",
    ];
    expectRoutingError(
      () => normalizeProjectProfile(root as unknown as SddProjectProfileInput),
      SDD_ROUTING_ERROR_CODES.INVALID_PROJECT_PROFILE,
    );
  });

  test("rejects overlaps within each path list but permits denied subtrees of allowed roots", () => {
    const allowed = cloneProfile();
    (allowed.writePolicy as Record<string, unknown>).allowedRoots = [
      "src",
      "src/features",
    ];
    expectRoutingError(
      () =>
        normalizeProjectProfile(allowed as unknown as SddProjectProfileInput),
      SDD_ROUTING_ERROR_CODES.INVALID_PROJECT_PROFILE,
    );

    const denied = cloneProfile();
    (denied.writePolicy as Record<string, unknown>).additionalDeniedRoots = [
      "src/generated",
      "src/generated/client",
    ];
    expectRoutingError(
      () =>
        normalizeProjectProfile(denied as unknown as SddProjectProfileInput),
      SDD_ROUTING_ERROR_CODES.INVALID_PROJECT_PROFILE,
    );

    expect(() => normalizeProjectProfile(profile())).not.toThrow();
  });

  test("rejects duplicate identifiers and unknown capability or check references", () => {
    const duplicate = cloneProfile();
    const laneCapabilities = duplicate.laneCapabilities as Record<
      string,
      unknown[]
    >;
    const codexCapabilities = requiredValue(
      laneCapabilities.codex,
      "Codex capabilities",
    );
    codexCapabilities.push(
      structuredClone(requiredValue(codexCapabilities[0], "first capability")),
    );
    expectRoutingError(
      () =>
        normalizeProjectProfile(duplicate as unknown as SddProjectProfileInput),
      SDD_ROUTING_ERROR_CODES.INVALID_PROJECT_PROFILE,
    );

    const capability = cloneProfile();
    const taskPolicies = capability.taskPolicies as Record<string, unknown>[];
    const implementationPolicy = requiredValue(
      taskPolicies[0],
      "implementation policy",
    );
    const requirements = implementationPolicy.requirements as Record<
      string,
      unknown
    >[];
    requiredValue(requirements[0], "capability requirement").capabilityId =
      "missing";
    expectRoutingError(
      () =>
        normalizeProjectProfile(
          capability as unknown as SddProjectProfileInput,
        ),
      SDD_ROUTING_ERROR_CODES.UNKNOWN_CAPABILITY,
    );

    const check = cloneProfile();
    (check.requiredChecks as Record<string, unknown>).always = ["missing"];
    expectRoutingError(
      () => normalizeProjectProfile(check as unknown as SddProjectProfileInput),
      SDD_ROUTING_ERROR_CODES.INVALID_PROJECT_PROFILE,
    );
  });
});

describe("profiled SDD routing", () => {
  test("emits versioned capability-fit evidence and fixed executor descriptors", () => {
    const plan = routeProfiledSddTasks({
      tasks: [task("review")],
      projectProfile: profile(),
    });

    expect(plan).toMatchObject({
      schemaVersion: 2,
      routingPolicyVersion: "sdd-routing-v3",
      fitPolicyVersion: "sdd-capability-fit-v1",
      projectProfile: {
        schemaVersion: 1,
        profileId: "test-project",
        profileVersion: "1.0.0",
      },
    });
    expect(plan.executors).toEqual([
      expect.objectContaining({
        id: "claude-host",
        modelSource: "host-selected",
        launchedByWorker: false,
      }),
      expect.objectContaining({
        id: "codex-worker",
        modelSource: "server-allowlisted",
        launchedByWorker: true,
      }),
    ]);
    expect(plan.executors.every((executor) => !("model" in executor))).toBe(
      true,
    );
  });

  test("resolves one global cross-review policy across mixed task policies", () => {
    const configured = mutableProfile();
    requiredValue(configured.codexPolicy.byKind, "kind policy").review = {
      model: "review-kind-model",
      reasoningEffort: "medium",
    };
    const plan = routeProfiledSddTasks({
      tasks: [
        task("build", { kind: "implementation", risk: "low" }),
        task("plan", { kind: "planning", risk: "medium" }),
      ],
      projectProfile: configured,
    });

    expect(plan.crossReviewPolicy).toEqual({
      source: "project-profile",
      purpose: "cross-review",
      model: "review-kind-model",
      reasoningEffort: "medium",
      serverAllowlistRequired: true,
    });
    expect(
      plan.assignments.map(({ codexPolicy }) => codexPolicy.model),
    ).toEqual(["implementation-model", null]);
  });

  test("uses highest-risk byRisk policy before review-kind and default", () => {
    const configured = mutableProfile();
    configured.codexPolicy.default = {
      model: "default-model",
      reasoningEffort: "low",
    };
    requiredValue(configured.codexPolicy.byKind, "kind policy").review = {
      model: "review-kind-model",
      reasoningEffort: "medium",
    };

    const riskPlan = routeProfiledSddTasks({
      tasks: [task("low", { risk: "low" }), task("high", { risk: "high" })],
      projectProfile: configured,
    });
    expect(riskPlan.crossReviewPolicy.model).toBe("high-risk-model");
    expect(riskPlan.crossReviewPolicy.reasoningEffort).toBe("xhigh");

    const kindPlan = routeProfiledSddTasks({
      tasks: [task("medium", { risk: "medium" })],
      projectProfile: configured,
    });
    expect(kindPlan.crossReviewPolicy.model).toBe("review-kind-model");

    delete requiredValue(configured.codexPolicy.byKind, "kind policy").review;
    const defaultPlan = routeProfiledSddTasks({
      tasks: [task("low", { risk: "low" })],
      projectProfile: configured,
    });
    expect(defaultPlan.crossReviewPolicy.model).toBe("default-model");
  });

  test("emits the explicit critical global cross-review policy", () => {
    const plan = routeProfiledSddTasks({
      tasks: [task("critical", { risk: "critical" })],
      projectProfile: profile(),
    });

    expect(plan.crossReviewPolicy).toEqual({
      source: "project-profile",
      purpose: "cross-review",
      model: "critical-model",
      reasoningEffort: "ultra",
      serverAllowlistRequired: true,
    });
  });

  test("uses weighted fit before soft preference", () => {
    const plan = routeProfiledSddTasks({
      tasks: [
        writer("build", {
          preferredLane: "claude-host",
        }),
      ],
      projectProfile: profile(),
    });
    expect(plan.assignments[0]).toMatchObject({
      lane: "codex",
      executorId: "codex-worker",
      decisionStage: "capability-fit",
      laneFit: { codex: 46, "claude-host": 28 },
    });
    expect(plan.assignments[0]?.reasons.map(({ code }) => code)).toContain(
      "PREFERRED_LANE_OVERRIDDEN_BY_FIT",
    );
  });

  test("gives Codex the extra task for an odd exact capability-fit tie", () => {
    const plan = routeProfiledSddTasks({
      tasks: [task("a"), task("b"), task("c")],
      projectProfile: profile(),
    });

    expect(plan.balance.taskCount).toEqual({
      codex: 2,
      "claude-host": 1,
    });
    expect(plan.reasons.map(({ code }) => code)).toContain(
      "ODD_NEUTRAL_TIE_TO_CODEX",
    );
    expect(
      plan.assignments.every(
        ({ decisionStage }) => decisionStage === "neutral-balance",
      ),
    ).toBe(true);
  });

  test("intersects explicit eligibility with capability minimums", () => {
    const minimumProfile = mutableProfile();
    const implementationPolicy = requiredValue(
      minimumProfile.taskPolicies[0],
      "implementation policy",
    );
    requiredValue(
      implementationPolicy.requirements[0],
      "coding requirement",
    ).minimumScore = 3;
    const capabilityPlan = routeProfiledSddTasks({
      tasks: [writer("capability")],
      projectProfile: minimumProfile,
    });
    expect(capabilityPlan.assignments[0]).toMatchObject({
      lane: "codex",
      decisionStage: "capability-eligibility",
      explicitEligibleLanes: ["codex", "claude-host"],
      effectiveEligibleLanes: ["codex"],
      capabilityEligibility: { codex: true, "claude-host": false },
    });

    const explicitPlan = routeProfiledSddTasks({
      tasks: [writer("explicit", { eligibleLanes: ["claude-host"] })],
      projectProfile: profile(),
    });
    expect(explicitPlan.assignments[0]).toMatchObject({
      lane: "claude-host",
      decisionStage: "hard-eligibility",
      effectiveEligibleLanes: ["claude-host"],
    });

    expectRoutingError(
      () =>
        routeProfiledSddTasks({
          tasks: [writer("none", { eligibleLanes: ["claude-host"] })],
          projectProfile: minimumProfile,
        }),
      SDD_ROUTING_ERROR_CODES.NO_ELIGIBLE_LANE,
    );
  });

  test("binds write-only required-check IDs to canonical argv and cwd digests", () => {
    const configured = profile();
    const normalized = normalizeProjectProfile(configured);
    const plan = routeProfiledSddTasks({
      tasks: [
        writer("write-high", { risk: "high" }),
        task("read-high", { kind: "implementation", risk: "high" }),
      ],
      projectProfile: configured,
    });
    const writeChecks = plan.assignments.find(
      ({ taskId }) => taskId === "write-high",
    )?.requiredCheckProfiles;
    expect(writeChecks).toEqual([
      {
        id: "lint",
        cwd: ".",
        commandSha256: sha256CanonicalJson({
          argv: ["npm", "run", "lint"],
          cwd: ".",
        }),
      },
      {
        id: "test",
        cwd: "packages/core",
        commandSha256: sha256CanonicalJson({
          argv: ["npm", "test"],
          cwd: "packages/core",
        }),
      },
    ]);
    expect(
      plan.assignments.find(({ taskId }) => taskId === "read-high")
        ?.requiredCheckProfiles,
    ).toEqual([]);
    expect(
      resolveRequiredCheckProfiles(normalized, {
        kind: "implementation",
        risk: "high",
        authority: "read-only",
      }),
    ).toEqual([]);
  });

  test("enforces allowed, denied, and BoundedRelay-protected write scopes", () => {
    for (const [scope, code] of [
      ["docs/guide.md", SDD_ROUTING_ERROR_CODES.WRITE_POLICY_VIOLATION],
      [
        "src/generated/client.ts",
        SDD_ROUTING_ERROR_CODES.WRITE_POLICY_VIOLATION,
      ],
      ["src/.env", SDD_ROUTING_ERROR_CODES.WRITE_POLICY_VIOLATION],
    ] as const) {
      expectRoutingError(
        () =>
          routeProfiledSddTasks({
            tasks: [writer("unsafe", { writeScopes: [scope] })],
            projectProfile: profile(),
          }),
        code,
      );
    }
  });

  test("resolves Codex policy by risk, then kind, then default", () => {
    const configured = profile();
    const normalized = normalizeProjectProfile(configured);
    expect(
      resolveCodexPolicy(normalized, { kind: "implementation", risk: "high" }),
    ).toEqual({
      model: "high-risk-model",
      reasoningEffort: "xhigh",
    });
    expect(
      resolveCodexPolicy(normalized, { kind: "implementation", risk: "low" }),
    ).toEqual({
      model: "implementation-model",
      reasoningEffort: "high",
    });
    expect(
      resolveCodexPolicy(normalized, { kind: "review", risk: "low" }),
    ).toEqual({
      model: null,
      reasoningEffort: null,
    });
    expect(
      resolveCodexPolicy(normalized, { kind: "review", risk: "critical" }),
    ).toEqual({
      model: "critical-model",
      reasoningEffort: "ultra",
    });

    const plan = routeProfiledSddTasks({
      tasks: [task("host", { kind: "planning", risk: "high" })],
      projectProfile: configured,
    });
    expect(plan.assignments[0]).toMatchObject({
      lane: "claude-host",
      codexPolicy: {
        source: "project-profile",
        purpose: "cross-review",
        model: "high-risk-model",
        reasoningEffort: "xhigh",
        serverAllowlistRequired: true,
      },
    });
  });

  test("fails critical routing closed without a complete explicit risk policy", () => {
    const missing = mutableProfile();
    delete missing.codexPolicy.byRisk?.critical;
    expectRoutingError(
      () =>
        routeProfiledSddTasks({
          tasks: [task("critical", { risk: "critical" })],
          projectProfile: missing,
        }),
      SDD_ROUTING_ERROR_CODES.CRITICAL_CODEX_POLICY_REQUIRED,
    );

    const incomplete = mutableProfile();
    requiredValue(incomplete.codexPolicy.byRisk, "risk policy").critical = {
      model: null,
      reasoningEffort: "ultra",
    };
    expectRoutingError(
      () =>
        routeProfiledSddTasks({
          tasks: [task("critical", { risk: "critical" })],
          projectProfile: incomplete,
        }),
      SDD_ROUTING_ERROR_CODES.CRITICAL_CODEX_POLICY_REQUIRED,
    );
  });

  test("binds check, write, and Codex policy changes into profile and plan fingerprints", () => {
    const baseline = profile();
    const baselinePlan = routeProfiledSddTasks({
      tasks: [writer()],
      projectProfile: baseline,
    });

    const mutations: SddProjectProfileInput[] = [];
    const command = mutableProfile(baseline);
    requiredValue(command.checkProfiles[0], "lint check").argv = [
      "npm",
      "run",
      "lint:strict",
    ];
    mutations.push(command);
    const write = mutableProfile(baseline);
    write.writePolicy.allowedRoots = ["src", "tests", "tools"];
    mutations.push(write);
    const model = mutableProfile(baseline);
    requiredValue(model.codexPolicy.byKind, "kind policy").implementation = {
      model: "other-model",
      reasoningEffort: "high",
    };
    mutations.push(model);

    for (const changed of mutations) {
      const changedPlan = routeProfiledSddTasks({
        tasks: [writer()],
        projectProfile: changed,
      });
      expect(changedPlan.projectProfile.profileFingerprint).not.toBe(
        baselinePlan.projectProfile.profileFingerprint,
      );
      expect(changedPlan.planFingerprint).not.toBe(
        baselinePlan.planFingerprint,
      );
    }
  });
});
