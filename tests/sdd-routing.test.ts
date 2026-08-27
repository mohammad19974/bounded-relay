import { describe, expect, test } from "vitest";

import {
  SDD_ROUTING_ERROR_CODES,
  routeSddTasks,
  type SddRoutingPlan,
  type SddRoutingTaskInput,
} from "../src/sdd/routing/index.js";

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

function laneFor(plan: SddRoutingPlan, taskId: string): string | undefined {
  return plan.assignments.find((assignment) => assignment.taskId === taskId)
    ?.lane;
}

describe("deterministic SDD routing", () => {
  test("uses the neutral share only after quality fit is tied", () => {
    const plan = routeSddTasks({
      tasks: [task("a"), task("b"), task("c"), task("d")],
    });

    expect(plan.balance).toMatchObject({
      neutralCodexShareBps: 5_000,
      actualCodexShareBps: 5_000,
      absoluteEffortDeviationBps: 0,
      effortPoints: { codex: 2, "claude-host": 2 },
      taskCount: { codex: 2, "claude-host": 2 },
      decisionCounts: {
        "hard-eligibility": 0,
        "quality-fit": 0,
        "preferred-lane-tie-break": 0,
        "neutral-balance": 4,
      },
      deviations: [],
    });
    expect(plan.assignments.map(({ taskId, lane }) => [taskId, lane])).toEqual([
      ["a", "claude-host"],
      ["b", "claude-host"],
      ["c", "codex"],
      ["d", "codex"],
    ]);
  });

  test("gives Codex the extra task for an odd fully tied plan", () => {
    const plan = routeSddTasks({
      tasks: [task("a"), task("b"), task("c")],
    });

    expect(plan.balance.taskCount).toEqual({
      codex: 2,
      "claude-host": 1,
    });
    expect(plan.reasons.map((reason) => reason.code)).toContain(
      "ODD_NEUTRAL_TIE_TO_CODEX",
    );
  });

  test("never sacrifices a stronger task fit to approach 50/50", () => {
    const plan = routeSddTasks({
      tasks: [
        task("build-a", { effortPoints: 8, kind: "implementation" }),
        task("build-b", { effortPoints: 5, kind: "debugging" }),
        task("build-c", { effortPoints: 3, kind: "refactor" }),
      ],
    });

    expect(plan.balance.effortPoints).toEqual({
      codex: 16,
      "claude-host": 0,
    });
    expect(plan.balance.actualCodexShareBps).toBe(10_000);
    expect(plan.balance.deviations.map((value) => value.code)).toContain(
      "ADAPTIVE_FIT_POLICY",
    );
    expect(
      plan.assignments.every(
        (assignment) =>
          assignment.lane === "codex" &&
          assignment.decisionStage === "quality-fit",
      ),
    ).toBe(true);
  });

  test("routes host-specialized tasks entirely to the current Claude host", () => {
    const plan = routeSddTasks({
      tasks: [
        task("architecture", { kind: "architecture" }),
        task("docs", { kind: "documentation" }),
        task("plan", { kind: "planning" }),
      ],
    });

    expect(plan.balance.actualCodexShareBps).toBe(0);
    expect(
      plan.assignments.every((assignment) => assignment.lane === "claude-host"),
    ).toBe(true);
  });

  test("does not report an odd-neutral tie for quality-fixed odd work", () => {
    const plan = routeSddTasks({
      tasks: [
        task("a", { kind: "implementation" }),
        task("b", { kind: "debugging" }),
        task("c", { kind: "testing" }),
      ],
    });

    expect(plan.balance.taskCount).toEqual({
      codex: 3,
      "claude-host": 0,
    });
    expect(plan.reasons.map((reason) => reason.code)).not.toContain(
      "ODD_NEUTRAL_TIE_TO_CODEX",
    );
  });

  test("honors hard eligibility and explains the resulting deviation", () => {
    const plan = routeSddTasks({
      tasks: [
        task("forced-a", {
          effortPoints: 30,
          eligibleLanes: ["codex"],
          preferredLane: "claude-host",
        }),
        task("forced-b", {
          effortPoints: 30,
          eligibleLanes: ["codex"],
        }),
        task("host-a", {
          effortPoints: 20,
          eligibleLanes: ["claude-host"],
        }),
        task("host-b", {
          effortPoints: 20,
          eligibleLanes: ["claude-host"],
        }),
      ],
    });

    expect(laneFor(plan, "forced-a")).toBe("codex");
    expect(laneFor(plan, "host-a")).toBe("claude-host");
    expect(plan.balance.actualCodexShareBps).toBe(6_000);
    expect(plan.balance.deviations.map((value) => value.code)).toContain(
      "HARD_ELIGIBILITY",
    );
    expect(
      plan.assignments
        .find((assignment) => assignment.taskId === "forced-a")
        ?.reasons.map((reason) => reason.code),
    ).toEqual(
      expect.arrayContaining(["HARD_ELIGIBILITY", "PREFERRED_LANE_INELIGIBLE"]),
    );
  });

  test("hard eligibility overrides stronger fit with explicit audit evidence", () => {
    const plan = routeSddTasks({
      tasks: [
        task("forced-host", {
          kind: "implementation",
          eligibleLanes: ["claude-host"],
        }),
      ],
    });
    const assignment = plan.assignments[0];

    expect(assignment).toMatchObject({
      lane: "claude-host",
      decisionStage: "hard-eligibility",
      laneFit: { codex: 4, "claude-host": 2 },
    });
    expect(assignment?.reasons.map((reason) => reason.code)).toContain(
      "HARD_ELIGIBILITY",
    );
  });

  test("uses an eligible preference only to break an exact quality-fit tie", () => {
    const plan = routeSddTasks({
      tasks: [
        task("a", { preferredLane: "codex" }),
        task("b", { preferredLane: "codex" }),
      ],
    });

    expect(plan.balance.actualCodexShareBps).toBe(10_000);
    expect(
      plan.assignments.every(
        (assignment) => assignment.decisionStage === "preferred-lane-tie-break",
      ),
    ).toBe(true);
  });

  test("stronger quality fit overrides a conflicting soft preference", () => {
    const plan = routeSddTasks({
      tasks: [
        task("implementation", {
          kind: "implementation",
          preferredLane: "claude-host",
        }),
      ],
    });

    expect(laneFor(plan, "implementation")).toBe("codex");
    expect(plan.assignments[0]?.reasons.map((reason) => reason.code)).toContain(
      "PREFERRED_LANE_OVERRIDDEN_BY_FIT",
    );
  });

  test("uses a configurable neutral share for effort and task-count ties", () => {
    const plan = routeSddTasks({
      neutralCodexShareBps: 7_000,
      tasks: [
        task("a", { effortPoints: 3 }),
        task("b", { effortPoints: 3 }),
        task("c", { effortPoints: 2 }),
        task("d", { effortPoints: 2 }),
      ],
    });

    expect(plan.balance).toMatchObject({
      neutralCodexShareBps: 7_000,
      actualCodexShareBps: 7_000,
      effortPoints: { codex: 7, "claude-host": 3 },
    });
  });

  test("uses the configured neutral share for task count after effort ties", () => {
    const plan = routeSddTasks({
      neutralCodexShareBps: 7_000,
      tasks: [
        task("a", { effortPoints: 4 }),
        task("b", { effortPoints: 3 }),
        task("c", { effortPoints: 2 }),
        task("d", { effortPoints: 1 }),
      ],
    });

    expect(plan.balance.effortPoints.codex).toBe(7);
    expect(plan.balance.taskCount.codex).toBe(3);
  });

  test("risk changes review policy but does not silently bias provider fit", () => {
    const plan = routeSddTasks({
      tasks: [
        task("critical-review", { risk: "critical" }),
        task("low-review", { risk: "low" }),
      ],
    });

    expect(plan.assignments.map((assignment) => assignment.laneFit)).toEqual([
      { codex: 3, "claude-host": 3 },
      { codex: 3, "claude-host": 3 },
    ]);
    expect(plan.balance.actualCodexShareBps).toBe(5_000);
  });

  test("produces canonical output and fingerprint independent of input order", () => {
    const first = routeSddTasks({
      neutralCodexShareBps: 5_000,
      tasks: [
        task("build", {
          authority: "write",
          kind: "implementation",
          dependencies: ["plan", "review"],
          writeScopes: ["src\\core", "tests"],
          eligibleLanes: ["codex", "claude-host"],
        }),
        task("review"),
        task("plan", { kind: "planning" }),
      ],
    });
    const second = routeSddTasks({
      tasks: [
        task("plan", { kind: "planning" }),
        task("review"),
        {
          eligibleLanes: ["claude-host", "codex"],
          writeScopes: ["tests", "src/core"],
          dependencies: ["review", "plan"],
          kind: "implementation",
          authority: "write",
          risk: "medium",
          effortPoints: 1,
          id: "build",
        },
      ],
      neutralCodexShareBps: 5_000,
    });

    expect(second).toEqual(first);
    expect(first.planFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(
      routeSddTasks({
        tasks: [task("a", { effortPoints: 2 }), task("b")],
      }).planFingerprint,
    ).not.toBe(
      routeSddTasks({
        tasks: [task("a", { effortPoints: 3 }), task("b")],
      }).planFingerprint,
    );
  });

  test("builds dependency waves with at most one repository writer", () => {
    const plan = routeSddTasks({
      tasks: [
        task("writer-b", {
          authority: "write",
          kind: "implementation",
          writeScopes: ["src/core"],
        }),
        task("reader"),
        task("writer-a", {
          authority: "write",
          kind: "refactor",
          writeScopes: ["src"],
        }),
        task("verify", {
          dependencies: ["writer-a", "writer-b"],
          kind: "testing",
        }),
      ],
    });

    expect(plan.waves).toEqual([
      {
        wave: 1,
        taskIds: ["reader", "writer-a"],
        writerTaskId: "writer-a",
      },
      { wave: 2, taskIds: ["writer-b"], writerTaskId: "writer-b" },
      { wave: 3, taskIds: ["verify"] },
    ]);
    for (const wave of plan.waves) {
      const writers = wave.taskIds.filter(
        (taskId) =>
          plan.tasks.find((candidate) => candidate.id === taskId)?.authority ===
          "write",
      );
      expect(writers.length).toBeLessThanOrEqual(1);
    }
  });

  test("rejects dependency cycles, unknown dependencies, and duplicate ids", () => {
    expect(() =>
      routeSddTasks({
        tasks: [
          task("a", { dependencies: ["b"] }),
          task("b", { dependencies: ["a"] }),
        ],
      }),
    ).toThrow(
      expect.objectContaining({
        code: SDD_ROUTING_ERROR_CODES.DEPENDENCY_CYCLE,
      }),
    );
    expect(() =>
      routeSddTasks({ tasks: [task("a", { dependencies: ["missing"] })] }),
    ).toThrow(
      expect.objectContaining({
        code: SDD_ROUTING_ERROR_CODES.UNKNOWN_DEPENDENCY,
      }),
    );
    expect(() => routeSddTasks({ tasks: [task("a"), task("a")] })).toThrow(
      expect.objectContaining({
        code: SDD_ROUTING_ERROR_CODES.DUPLICATE_TASK_ID,
      }),
    );
  });

  test.each([
    "../src",
    "/absolute",
    "src//nested",
    ".git/config",
    "C:/workspace",
    ".",
  ])("rejects unsafe write scope %j", (writeScope) => {
    expect(() =>
      routeSddTasks({
        tasks: [
          task("writer", {
            authority: "write",
            writeScopes: [writeScope],
          }),
        ],
      }),
    ).toThrow(
      expect.objectContaining({
        code: SDD_ROUTING_ERROR_CODES.INVALID_WRITE_SCOPE,
      }),
    );
  });

  test("rejects malformed limits and unsupported authority-bearing fields", () => {
    expect(() => routeSddTasks({ tasks: [] })).toThrow(
      expect.objectContaining({ code: SDD_ROUTING_ERROR_CODES.INVALID_INPUT }),
    );
    expect(() =>
      routeSddTasks({
        tasks: Array.from({ length: 65 }, (_, index) => task(`t-${index}`)),
      }),
    ).toThrow(
      expect.objectContaining({ code: SDD_ROUTING_ERROR_CODES.INVALID_INPUT }),
    );
    expect(() =>
      routeSddTasks({
        tasks: [task("bad id")],
      }),
    ).toThrow(
      expect.objectContaining({ code: SDD_ROUTING_ERROR_CODES.INVALID_TASK }),
    );
    expect(() =>
      routeSddTasks({
        tasks: [
          {
            ...task("a"),
            claudeModel: "must-not-be-accepted",
          } as SddRoutingTaskInput,
        ],
      }),
    ).toThrow(
      expect.objectContaining({ code: SDD_ROUTING_ERROR_CODES.INVALID_INPUT }),
    );
  });

  test.each([
    { effortPoints: 0 },
    { effortPoints: 101 },
    { effortPoints: 1.5 },
    { risk: "extreme" },
    { authority: "admin" },
    { kind: "anything" },
    { eligibleLanes: [] },
    { eligibleLanes: ["codex", "codex"] },
    { preferredLane: "auto" },
    { dependencies: ["duplicate", "duplicate"] },
  ])("rejects malformed task policy %#", (override) => {
    expect(() =>
      routeSddTasks({
        tasks: [
          {
            ...task("duplicate"),
            ...override,
          } as unknown as SddRoutingTaskInput,
        ],
      }),
    ).toThrow();
  });

  test.each([-1, 10_001, 5_000.5])(
    "rejects invalid neutralCodexShareBps %j",
    (neutralCodexShareBps) => {
      expect(() =>
        routeSddTasks({ tasks: [task("a")], neutralCodexShareBps }),
      ).toThrow(
        expect.objectContaining({
          code: SDD_ROUTING_ERROR_CODES.INVALID_INPUT,
        }),
      );
    },
  );

  test("requires explicit scopes only for write-authority tasks", () => {
    expect(() =>
      routeSddTasks({
        tasks: [task("writer", { authority: "write" })],
      }),
    ).toThrow(
      expect.objectContaining({
        code: SDD_ROUTING_ERROR_CODES.INVALID_WRITE_SCOPE,
      }),
    );
    expect(() =>
      routeSddTasks({
        tasks: [task("reader", { writeScopes: ["src"] })],
      }),
    ).toThrow(
      expect.objectContaining({
        code: SDD_ROUTING_ERROR_CODES.INVALID_WRITE_SCOPE,
      }),
    );
  });

  test("never emits a Claude model, executable, or API field", () => {
    const plan = routeSddTasks({
      tasks: [task("host", { eligibleLanes: ["claude-host"] }), task("worker")],
    });
    const keys = collectKeys(plan);

    expect(keys.some((key) => /model|executable|api/i.test(key))).toBe(false);
    expect(JSON.stringify(plan)).toContain('"claude-host"');
  });

  test("keeps the bounded dynamic program finite at the 64-task limit", () => {
    const plan = routeSddTasks({
      tasks: Array.from({ length: 64 }, (_, index) =>
        task(`task-${String(index).padStart(2, "0")}`, {
          effortPoints: (index % 100) + 1,
        }),
      ),
    });

    expect(plan.assignments).toHaveLength(64);
    expect(plan.balance.taskCount).toEqual({
      codex: 32,
      "claude-host": 32,
    });
  }, 15_000);
});

function collectKeys(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectKeys(entry));
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, entry]) => [
    key,
    ...collectKeys(entry),
  ]);
}
