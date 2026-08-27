import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, test } from "vitest";

import {
  locateIntegrationPack,
  validateIntegrationPack,
} from "../src/sdd/integration-pack.js";
import { routeSddTasks } from "../src/sdd/routing/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptsRoot = join(
  repositoryRoot,
  "integrations/spec-kit/workflow/scripts",
);
const cleanup: string[] = [];
const runId = "run-1";

beforeAll(() => {
  execFileSync(
    process.execPath,
    [
      join(repositoryRoot, "node_modules/typescript/bin/tsc"),
      "-p",
      "tsconfig.build.json",
    ],
    { cwd: repositoryRoot, stdio: "pipe" },
  );
});

interface Fixture {
  readonly root: string;
  readonly evidence: string;
}

interface ScriptResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map(async (path) => {
      await rm(path, { force: true, recursive: true });
    }),
  );
});

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function jsonHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`missing ${label}`);
  }
  return value;
}

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function script(
  fixture: Fixture,
  name: string,
  args: readonly string[],
): ScriptResult {
  const result = spawnSync(
    process.execPath,
    [join(scriptsRoot, name), ...args],
    {
      cwd: fixture.root,
      encoding: "utf8",
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "boundedrelay-pack-"));
  cleanup.push(root);
  const feature = join(root, "specs/001-feature");
  const run = join(root, ".specify/workflows/runs", runId);
  const evidence = join(run, "evidence");
  await mkdir(feature, { recursive: true });
  await mkdir(evidence, { recursive: true });
  await mkdir(join(root, "src/codex"), { recursive: true });
  await mkdir(join(root, "src/claude"), { recursive: true });
  await writeFile(join(root, ".gitignore"), ".specify/workflows/runs/\n");
  await writeFile(join(feature, "spec.md"), "# Spec\n");
  await writeFile(join(feature, "plan.md"), "# Plan\n");
  await writeFile(
    join(root, "src/codex/index.ts"),
    "export const codex = 1;\n",
  );
  await writeFile(
    join(root, "src/claude/index.ts"),
    "export const claude = 1;\n",
  );
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Fixture"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "fixture"]);
  await writeJson(join(run, "inputs.json"), {
    inputs: {
      feature_directory: "specs/001-feature",
      codex_share: "50",
      spec: "Build the fixture",
      scope: "fixture",
    },
  });
  return { root, evidence };
}

async function commitTasks(
  item: Fixture,
  tasks: readonly { readonly id: string; readonly completed?: boolean }[],
): Promise<string> {
  const markdown = [
    "# Tasks",
    "",
    ...tasks.map(
      (task) =>
        `- [${task.completed === true ? "x" : " "}] ${task.id} Implement the fixture task.`,
    ),
    "",
  ].join("\n");
  await writeFile(join(item.root, "specs/001-feature/tasks.md"), markdown);
  git(item.root, ["add", "specs/001-feature/tasks.md"]);
  git(item.root, ["commit", "-qm", "add approved tasks"]);
  return git(item.root, ["rev-parse", "HEAD"]);
}

function review(
  provider: "claude" | "codex",
  revision: Record<string, unknown>,
  phase: "plan" | "implementation" | "convergence",
  hostReviewId?: string,
  codexProfile: {
    readonly model: string;
    readonly reasoningEffort:
      "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  } | null = null,
): Record<string, unknown> {
  const startedAt =
    provider === "claude"
      ? "2026-01-01T00:00:00.000Z"
      : "2026-01-01T00:00:02.000Z";
  const base: Record<string, unknown> = {
    provider,
    status: "complete",
    modelSource: provider === "claude" ? "host-selected" : "worker-resolved",
    model: null,
    revisionSeal: revision.seal,
    verdict: "approved",
    summary: `${provider} approved the fixture`,
    findings: [],
    startedAt,
    completedAt:
      provider === "claude"
        ? "2026-01-01T00:00:01.000Z"
        : "2026-01-01T00:00:03.000Z",
  };
  if (provider === "codex") {
    base.model = codexProfile?.model ?? null;
    base.reasoningEffort = codexProfile?.reasoningEffort ?? null;
    const sealPayload = {
      schemaVersion: 1,
      mode: "strict",
      revision: revision.head,
      clean: true,
      workspaceFingerprint: "e".repeat(64),
      artifacts: revision.artifacts,
      comparison: revision.comparison ?? null,
    };
    const seal = { ...sealPayload, sealId: jsonHash(sealPayload) };
    const hostEvidence = {
      schemaVersion: 1,
      reviewId: hostReviewId ?? `claude-${phase}`,
      phase,
      sealId: seal.sealId,
      reviewer: {
        provider: "claude",
        lane: "claude-host",
        modelSource: "host-selected",
        attestation: "host-declared",
      },
      verdict: "approved",
      summary: "claude approved the fixture",
      findings: [],
    };
    const codexEvidence = {
      schemaVersion: 1,
      reviewId: `codex-${phase}`,
      phase,
      sealId: seal.sealId,
      reviewer: {
        provider: "codex",
        lane: "codex",
        modelSource: "worker-resolved",
        model: codexProfile?.model ?? "server-default",
        reasoningEffort: codexProfile?.reasoningEffort ?? "server-default",
      },
      execution: {
        fresh: true,
        sandbox: "read-only",
        approvalPolicy: "never",
        ephemeral: true,
      },
      verdict: "approved",
      summary: "codex approved the fixture",
      findings: [],
    };
    const hostDigest = jsonHash(hostEvidence);
    const codexDigest = jsonHash(codexEvidence);
    base.jobId = "00000000-0000-4000-8000-000000000001";
    base.sddReview = {
      tool: "codex_worker_sdd_review",
      phase,
      mode: "strict",
      expectedRevision: revision.head,
      seal,
      hostEvidenceDigest: hostDigest,
      hostEvidence,
      codexEvidence,
      gate: {
        passed: true,
        status: "ready",
        sealId: seal.sealId,
        reasons: [],
        freshnessReasons: [],
        evidenceDigests: { host: hostDigest, codex: codexDigest },
      },
    };
  }
  return base;
}

async function completeApprovedPlanReview(item: Fixture): Promise<void> {
  expect(script(item, "plan-review.mjs", ["prepare", runId]).status).toBe(0);
  const path = join(item.evidence, "plan-review.json");
  let document = await json(path);
  const revision = document.revision as Record<string, unknown>;
  document.state = "claude-frozen";
  document.claudeReview = review("claude", revision, "plan");
  await writeJson(path, document);
  expect(script(item, "plan-review.mjs", ["verify-claude", runId]).status).toBe(
    0,
  );
  document = await json(path);
  const claudeReview = document.claudeReview as Record<string, unknown>;
  document.state = "complete";
  document.codexReview = review(
    "codex",
    revision,
    "plan",
    String(claudeReview.reviewId),
  );
  document.reconciliation = {
    verdict: "approved",
    summary: "Both independent reviews approved the same strict seal.",
    completedAt: "2026-01-01T00:00:04.000Z",
  };
  await writeJson(path, document);
  expect(script(item, "plan-review.mjs", ["verify", runId]).status).toBe(0);
}

async function writeReadOnlyRouting(
  item: Fixture,
  taskIds: readonly string[],
): Promise<ScriptResult> {
  expect(script(item, "routing.mjs", ["prepare", runId]).status).toBe(0);
  const routePath = join(item.evidence, "routing.json");
  const document = await json(routePath);
  const revision = document.revision as Record<string, unknown>;
  const result = routeSddTasks({
    neutralCodexShareBps: 5000,
    tasks: taskIds.map((id) => ({
      id,
      effortPoints: 3,
      risk: "medium",
      authority: "read-only",
      kind: "planning",
    })),
  });
  expect(
    result.assignments.every((entry) => entry.lane === "claude-host"),
  ).toBe(true);

  document.state = "complete";
  document.router = {
    tool: "codex_worker_sdd_route",
    request: {
      tasks: result.tasks,
      neutralCodexShareBps: 5000,
    },
    result,
  };
  document.assignments = result.tasks.map((task) => {
    const assignment = required(
      result.assignments.find((entry) => entry.taskId === task.id),
      `read-only assignment ${task.id}`,
    );
    return {
      taskId: task.id,
      provider: assignment.lane,
      reviewerProvider: "codex",
      risk: task.risk,
      authority: task.authority,
      kind: task.kind,
      wave: assignment.wave,
      effort: task.effortPoints,
      writePaths: task.writeScopes,
      dependencies: task.dependencies,
      rationale: "The versioned planning fit selects the Claude host.",
      revisionSeal: revision.seal,
      modelPolicy: { source: "host-selected", model: null },
    };
  });
  const totalEffort = result.tasks.reduce(
    (total, task) => total + task.effortPoints,
    0,
  );
  document.totals = {
    totalEffort,
    codexEffort: 0,
    claudeEffort: totalEffort,
    codexPercent: 0,
    claudePercent: 100,
  };
  document.deviations = result.balance.deviations.map((entry) => entry.message);
  await writeJson(routePath, document);
  return script(item, "routing.mjs", ["verify", runId]);
}

async function completeHostOnlyRouting(item: Fixture): Promise<void> {
  await commitTasks(item, [{ id: "T001" }]);
  const verified = await writeReadOnlyRouting(item, ["T001"]);
  expect(verified.status, verified.stderr).toBe(0);
}

async function completeHostWriterRouting(
  item: Fixture,
  risk: "medium" | "critical" = "medium",
): Promise<void> {
  await completeApprovedPlanReview(item);
  await commitTasks(item, [{ id: "T001" }]);
  expect(script(item, "routing.mjs", ["prepare", runId]).status).toBe(0);
  const routePath = join(item.evidence, "routing.json");
  const document = await json(routePath);
  const revision = document.revision as Record<string, unknown>;
  const result = routeSddTasks({
    neutralCodexShareBps: 5000,
    tasks: [
      {
        id: "T001",
        effortPoints: 5,
        risk,
        authority: "write",
        kind: "planning",
        dependencies: [],
        writeScopes: ["src/claude"],
      },
    ],
  });
  const task = required(result.tasks[0], "host writer task");
  const assignment = required(result.assignments[0], "host writer assignment");
  expect(assignment.lane).toBe("claude-host");
  document.state = "complete";
  document.router = {
    tool: "codex_worker_sdd_route",
    request: { tasks: result.tasks, neutralCodexShareBps: 5000 },
    result,
  };
  document.assignments = [
    {
      taskId: task.id,
      provider: "claude-host",
      reviewerProvider: "codex",
      risk: task.risk,
      authority: task.authority,
      kind: task.kind,
      wave: assignment.wave,
      effort: task.effortPoints,
      writePaths: task.writeScopes,
      dependencies: task.dependencies,
      rationale: "Planning work has a stronger versioned Claude-host fit.",
      revisionSeal: revision.seal,
      modelPolicy: { source: "host-selected", model: null },
      ...(risk === "critical"
        ? {
            reviewerModelPolicy: {
              source: "server-allowlisted",
              model: "gpt-5.6-sol",
              reasoningEffort: "ultra",
            },
          }
        : {}),
    },
  ];
  document.totals = {
    totalEffort: 5,
    codexEffort: 0,
    claudeEffort: 5,
    codexPercent: 0,
    claudePercent: 100,
  };
  document.deviations = result.balance.deviations.map((entry) => entry.message);
  await writeJson(routePath, document);
  expect(script(item, "routing.mjs", ["verify", runId]).status).toBe(0);
}

async function writeHostCheckpoint(
  item: Fixture,
  extraCommit = false,
): Promise<ScriptResult> {
  expect(script(item, "execution.mjs", ["prepare", runId]).status).toBe(0);
  const path = join(item.evidence, "execution.json");
  const document = await json(path);
  const active = document.activeWave as Record<string, unknown>;
  const sourcePath = join(item.root, "src/claude/index.ts");
  await writeFile(
    sourcePath,
    `${await readFile(sourcePath, "utf8")}export const checkpoint = 1;\n`,
  );
  git(item.root, ["add", "src/claude/index.ts"]);
  git(item.root, ["commit", "-qm", "writer checkpoint"]);
  if (extraCommit) {
    await writeFile(
      sourcePath,
      `${await readFile(sourcePath, "utf8")}export const hiddenHistory = 2;\n`,
    );
    git(item.root, ["add", "src/claude/index.ts"]);
    git(item.root, ["commit", "-qm", "second writer commit"]);
  }
  document.results = [
    {
      taskId: "T001",
      provider: "claude-host",
      wave: active.wave,
      status: "accepted",
      transport: "claude-host",
      effect: "host-write",
      baselineRevision: active.baselineRevision,
      modelSource: "host-selected",
      model: null,
      reasoningEffort: null,
      changedFiles: ["src/claude/index.ts"],
      verification: ["The host writer stayed inside its exact path lease."],
      checks: [
        checkReceipt(
          "host-writer-check",
          git(item.root, ["rev-parse", "HEAD^{tree}"]),
        ),
      ],
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
    },
  ];
  await writeJson(path, document);
  return script(item, "execution.mjs", ["verify-wave", runId]);
}

function checkReceipt(id: string, testedTree: string): Record<string, unknown> {
  return {
    id,
    source: "host-executed",
    profile: "fixture-check",
    commandLabel: "fixture verification",
    commandSha256: "a".repeat(64),
    cwd: ".",
    exitCode: 0,
    stdoutSha256: "b".repeat(64),
    stderrSha256: "c".repeat(64),
    testedTree,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
  };
}

async function completeHostOnlyExecution(item: Fixture): Promise<void> {
  expect(script(item, "execution.mjs", ["prepare", runId]).status).toBe(0);
  const path = join(item.evidence, "execution.json");
  const document = await json(path);
  const active = document.activeWave as Record<string, unknown>;
  document.results = [
    {
      taskId: "T001",
      provider: "claude-host",
      wave: active.wave,
      status: "accepted",
      transport: "claude-host",
      effect: "analysis",
      baselineRevision: active.baselineRevision,
      modelSource: "host-selected",
      model: null,
      reasoningEffort: null,
      verification: ["The host analysis covered the fixture plan."],
      checks: [],
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
    },
  ];
  await writeJson(path, document);
  const verified = script(item, "execution.mjs", ["verify-wave", runId]);
  expect(verified.status).toBe(0);
  expect(JSON.parse(verified.stdout)).toBe(false);
  expect(script(item, "execution.mjs", ["verify", runId]).status).toBe(0);
}

describe("pack metadata", () => {
  test("locates and validates the packaged integration without installing it", async () => {
    await expect(locateIntegrationPack()).resolves.toBe(
      join(repositoryRoot, "integrations"),
    );
    await expect(validateIntegrationPack()).resolves.toMatchObject({
      ok: true,
      root: join(repositoryRoot, "integrations"),
      jsonManifests: [
        "claude-code-plugin/.claude-plugin/plugin.json",
        "claude-code-plugin/.mcp.json",
        "spec-kit/workflow/schemas/plan-review.schema.json",
        "spec-kit/workflow/schemas/routing.schema.json",
        "spec-kit/workflow/schemas/execution.schema.json",
        "spec-kit/workflow/schemas/implementation-review.schema.json",
        "spec-kit/workflow/schemas/proof-pack.schema.json",
        "spec-kit/workflow/schemas/handoff-context.schema.json",
      ],
    });
  });

  test("ships parseable schemas and a model-neutral boundedrelay MCP plugin", async () => {
    const schemaDirectory = join(
      repositoryRoot,
      "integrations/spec-kit/workflow/schemas",
    );
    for (const name of [
      "plan-review.schema.json",
      "routing.schema.json",
      "execution.schema.json",
      "implementation-review.schema.json",
      "proof-pack.schema.json",
      "handoff-context.schema.json",
    ]) {
      const raw = await readFile(join(schemaDirectory, name), "utf8");
      expect(() => {
        JSON.parse(raw);
      }).not.toThrow();
    }
    const mcp = JSON.parse(
      await readFile(
        join(repositoryRoot, "integrations/claude-code-plugin/.mcp.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(mcp).toEqual({
      mcpServers: {
        boundedrelay: {
          type: "stdio",
          command: "boundedrelay",
          args: ["serve"],
        },
      },
    });
  });

  test("rejects unsafe feature paths before the workflow dereferences them", async () => {
    const item = await fixture();
    expect(script(item, "preflight.mjs", [runId]).status).toBe(0);
    await writeJson(join(dirname(item.evidence), "inputs.json"), {
      inputs: {
        feature_directory: "../outside",
        codex_share: "50",
        spec: "Build the fixture",
        scope: "fixture",
      },
    });
    const rejected = script(item, "preflight.mjs", [runId]);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toMatch(/safe repository-relative path/u);
  });
});

describe("strict dual review evidence", () => {
  test("freezes host evidence first and accepts only the strict SDD review tool", async () => {
    const item = await fixture();
    expect(script(item, "plan-review.mjs", ["prepare", runId]).status).toBe(0);
    const path = join(item.evidence, "plan-review.json");
    let document = await json(path);
    const revision = document.revision as Record<string, unknown>;
    document.state = "claude-frozen";
    document.claudeReview = review("claude", revision, "plan");
    await writeJson(path, document);
    expect(
      script(item, "plan-review.mjs", ["verify-claude", runId]).status,
    ).toBe(0);

    document = await json(path);
    const claudeReview = document.claudeReview as Record<string, unknown>;
    document.state = "complete";
    document.codexReview = review(
      "codex",
      revision,
      "plan",
      String(claudeReview.reviewId),
    );
    document.reconciliation = {
      verdict: "approved",
      summary: "Both independent reviews approved the same strict seal.",
      completedAt: "2026-01-01T00:00:04.000Z",
    };
    await writeJson(path, document);
    expect(script(item, "plan-review.mjs", ["verify", runId]).status).toBe(0);

    const codex = document.codexReview as Record<string, unknown>;
    const sdd = codex.sddReview as Record<string, unknown>;
    sdd.tool = "codex_worker_analyze";
    await writeJson(path, document);
    const advisory = script(item, "plan-review.mjs", ["verify", runId]);
    expect(advisory.status).not.toBe(0);
    expect(advisory.stderr).toMatch(/codex_worker_sdd_review/u);
  });

  test("rejects stale implementation evidence and unsafe run identifiers", async () => {
    const item = await fixture();
    await completeApprovedPlanReview(item);
    await completeHostOnlyRouting(item);
    await completeHostOnlyExecution(item);
    expect(
      script(item, "implementation-review.mjs", [
        "prepare",
        runId,
        "implementation",
      ]).status,
    ).toBe(0);
    const path = join(item.evidence, "implementation-review.json");
    let document = await json(path);
    const revision = document.revision as Record<string, unknown>;
    document.state = "claude-frozen";
    document.claudeReview = review("claude", revision, "implementation");
    await writeJson(path, document);
    expect(
      script(item, "implementation-review.mjs", [
        "verify-claude",
        runId,
        "implementation",
      ]).status,
    ).toBe(0);
    document = await json(path);
    const claudeReview = document.claudeReview as Record<string, unknown>;
    document.state = "complete";
    document.codexReview = review(
      "codex",
      revision,
      "implementation",
      String(claudeReview.reviewId),
    );
    document.verdict = "approved";
    await writeJson(path, document);
    expect(
      script(item, "implementation-review.mjs", [
        "verify",
        runId,
        "implementation",
      ]).status,
    ).toBe(0);

    await writeFile(
      join(item.root, "src/codex/index.ts"),
      "export const codex = 2;\n",
    );
    expect(
      script(item, "implementation-review.mjs", [
        "verify",
        runId,
        "implementation",
      ]).status,
    ).not.toBe(0);
    expect(
      script(item, "plan-review.mjs", ["prepare", "../escape"]).status,
    ).not.toBe(0);
  }, 30_000);
});

describe("routing and wave-ordered execution evidence", () => {
  test("accepts a descendant committed task checkpoint without staling the reviewed plan", async () => {
    const item = await fixture();
    await completeApprovedPlanReview(item);
    const planReview = await json(join(item.evidence, "plan-review.json"));
    const planRevision = planReview.revision as Record<string, unknown>;
    const taskRevision = await commitTasks(item, [{ id: "T001" }]);
    expect(taskRevision).not.toBe(planRevision.head);

    const prepared = script(item, "routing.mjs", ["prepare", runId]);
    expect(prepared.status, prepared.stderr).toBe(0);
    const routing = await json(join(item.evidence, "routing.json"));
    expect(routing).toMatchObject({
      state: "pending",
      revision: { head: taskRevision },
      taskManifest: {
        schemaVersion: 1,
        sourcePath: "specs/001-feature/tasks.md",
        tasks: [{ id: "T001", completed: false }],
        pendingTaskIds: ["T001"],
      },
    });
    expect(routing.taskManifestSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("rejects a descendant task checkpoint that also changes the reviewed plan", async () => {
    const item = await fixture();
    await completeApprovedPlanReview(item);
    await commitTasks(item, [{ id: "T001" }]);
    await writeFile(
      join(item.root, "specs/001-feature/plan.md"),
      "# Changed plan\n",
    );
    git(item.root, ["add", "specs/001-feature/plan.md"]);
    git(item.root, ["commit", "-qm", "change reviewed plan"]);

    const prepared = script(item, "routing.mjs", ["prepare", runId]);
    expect(prepared.status).not.toBe(0);
    expect(prepared.stderr).toMatch(/changed after the approved plan review/u);
  });

  test("rejects approved outer plan evidence that no longer projects its strict evidence", async () => {
    const item = await fixture();
    await completeApprovedPlanReview(item);
    await commitTasks(item, [{ id: "T001" }]);
    const path = join(item.evidence, "plan-review.json");
    const document = await json(path);
    const claudeReview = document.claudeReview as Record<string, unknown>;
    claudeReview.summary = "Tampered outer approval summary.";
    await writeJson(path, document);

    const prepared = script(item, "routing.mjs", ["prepare", runId]);
    expect(prepared.status).not.toBe(0);
    expect(prepared.stderr).toMatch(/does not exactly project/u);
  });

  test("rejects routing that omits a committed incomplete task", async () => {
    const item = await fixture();
    await completeApprovedPlanReview(item);
    await commitTasks(item, [{ id: "T001" }, { id: "T002" }]);
    const verified = await writeReadOnlyRouting(item, ["T001"]);
    expect(verified.status).not.toBe(0);
    expect(verified.stderr).toMatch(/committed task manifest/u);
  });

  test("rejects routing that invents a task outside the committed manifest", async () => {
    const item = await fixture();
    await completeApprovedPlanReview(item);
    await commitTasks(item, [{ id: "T001" }]);
    const verified = await writeReadOnlyRouting(item, ["T001", "T999"]);
    expect(verified.status).not.toBe(0);
    expect(verified.stderr).toMatch(/committed task manifest/u);
  });

  test("executes every routed writer from a clean dependency checkpoint", async () => {
    const item = await fixture();
    await completeApprovedPlanReview(item);
    await commitTasks(item, [{ id: "T001" }, { id: "T002" }]);
    expect(script(item, "routing.mjs", ["prepare", runId]).status).toBe(0);
    const routePath = join(item.evidence, "routing.json");
    const document = await json(routePath);
    const revision = document.revision as Record<string, unknown>;
    const result = routeSddTasks({
      neutralCodexShareBps: 5000,
      tasks: [
        {
          id: "T001",
          effortPoints: 3,
          risk: "medium",
          authority: "write",
          kind: "review",
          dependencies: [],
          writeScopes: ["src/claude"],
          eligibleLanes: ["codex", "claude-host"],
        },
        {
          id: "T002",
          effortPoints: 3,
          risk: "medium",
          authority: "write",
          kind: "review",
          dependencies: [],
          writeScopes: ["src/codex"],
          eligibleLanes: ["codex", "claude-host"],
        },
      ],
    });
    const tasks = result.tasks;
    document.state = "complete";
    document.router = {
      tool: "codex_worker_sdd_route",
      request: { tasks, neutralCodexShareBps: 5000 },
      result,
    };
    document.assignments = tasks.map((task) => {
      const assignment = result.assignments.find(
        (entry) => entry.taskId === task.id,
      );
      if (assignment === undefined) {
        throw new Error(`missing route assignment for ${task.id}`);
      }
      return {
        taskId: task.id,
        provider: assignment.lane,
        reviewerProvider: assignment.lane === "codex" ? "claude-host" : "codex",
        risk: task.risk,
        authority: task.authority,
        kind: task.kind,
        wave: assignment.wave,
        effort: task.effortPoints,
        writePaths: task.writeScopes,
        dependencies: task.dependencies,
        rationale: "The deterministic router selected this lane.",
        revisionSeal: revision.seal,
        modelPolicy:
          assignment.lane === "codex"
            ? { source: "server-allowlisted", model: null }
            : { source: "host-selected", model: null },
      };
    });
    document.totals = {
      totalEffort: 6,
      codexEffort: 3,
      claudeEffort: 3,
      codexPercent: 50,
      claudePercent: 50,
    };
    await writeJson(routePath, document);
    expect(script(item, "routing.mjs", ["verify", runId]).status).toBe(0);

    const firstAssignment = required(
      (document.assignments as Record<string, unknown>[])[0],
      "first routing assignment",
    );
    const originalProvider = firstAssignment.provider;
    firstAssignment.provider =
      originalProvider === "codex" ? "claude-host" : "codex";
    await writeJson(routePath, document);
    expect(script(item, "execution.mjs", ["prepare", runId]).status).not.toBe(
      0,
    );
    firstAssignment.provider = originalProvider;
    await writeJson(routePath, document);

    expect(script(item, "execution.mjs", ["prepare", runId]).status).toBe(0);
    const executionPath = join(item.evidence, "execution.json");
    const routedAssignments = document.assignments as Record<string, unknown>[];
    const waveCount = (result.waves as readonly unknown[]).length;

    for (let index = 0; index < waveCount; index += 1) {
      const execution = await json(executionPath);
      const active = execution.activeWave as Record<string, unknown>;
      const assignment = routedAssignments.find(
        (entry) => entry.wave === active.wave,
      );
      if (assignment === undefined) {
        throw new Error(`missing assignment for wave ${String(active.wave)}`);
      }
      const writePaths = assignment.writePaths as string[];
      const changedFile = `${writePaths[0]}/index.ts`;
      const absolute = join(item.root, changedFile);
      await writeFile(
        absolute,
        `${await readFile(absolute, "utf8")}export const wave${String(active.wave)} = true;\n`,
      );
      git(item.root, ["add", changedFile]);
      git(item.root, ["commit", "-qm", `wave ${String(active.wave)}`]);
      const provider = assignment.provider as "codex" | "claude-host";
      const patchText = execFileSync(
        "git",
        [
          "diff",
          "--binary",
          "--full-index",
          "--no-ext-diff",
          `${String(active.baselineRevision)}..HEAD`,
          "--",
        ],
        { cwd: item.root, encoding: "utf8" },
      );
      if (provider === "codex") {
        await mkdir(join(dirname(item.evidence), "patches"), {
          recursive: true,
        });
        await writeFile(
          join(
            dirname(item.evidence),
            "patches",
            `${String(assignment.taskId)}.patch`,
          ),
          patchText,
          { mode: 0o600 },
        );
      }
      const results = execution.results as Record<string, unknown>[];
      results.push({
        taskId: assignment.taskId,
        provider,
        wave: active.wave,
        status: "accepted",
        transport: provider === "codex" ? "boundedrelay" : "claude-host",
        effect: provider === "codex" ? "proposal-integrated" : "host-write",
        baselineRevision: active.baselineRevision,
        modelSource: provider === "codex" ? "worker-resolved" : "host-selected",
        model: null,
        reasoningEffort: null,
        ...(provider === "codex"
          ? {
              jobId: `00000000-0000-4000-8000-00000000000${String(active.wave)}`,
              patchFile: `patches/${String(assignment.taskId)}.patch`,
              patchSha256: createHash("sha256").update(patchText).digest("hex"),
            }
          : {}),
        changedFiles: [changedFile],
        verification: [
          "The routed writer and exact changed path were reviewed.",
        ],
        checks: [
          checkReceipt(
            `check-wave-${String(active.wave)}`,
            git(item.root, ["rev-parse", "HEAD^{tree}"]),
          ),
        ],
        startedAt: `2026-01-01T00:00:0${String(index * 2)}.000Z`,
        completedAt: `2026-01-01T00:00:0${String(index * 2 + 1)}.000Z`,
      });
      await writeJson(executionPath, execution);
      const writerResult = required(results.at(-1), "writer result");
      const writerCheck = required(
        (writerResult.checks as Record<string, unknown>[])[0],
        "writer check receipt",
      );
      const validTree = writerCheck.testedTree;
      writerCheck.testedTree = String(active.baselineRevision);
      await writeJson(executionPath, execution);
      expect(
        script(item, "execution.mjs", ["verify-wave", runId]).status,
      ).not.toBe(0);
      writerCheck.testedTree = validTree;
      await writeJson(executionPath, execution);
      if (provider === "codex") {
        writerResult.reasoningEffort = "high";
        await writeJson(executionPath, execution);
        expect(
          script(item, "execution.mjs", ["verify-wave", runId]).status,
        ).not.toBe(0);
        writerResult.reasoningEffort = null;

        const alternatePatch = patchText.replace("true", "false");
        await writeFile(
          join(dirname(item.evidence), String(writerResult.patchFile)),
          alternatePatch,
          { mode: 0o600 },
        );
        writerResult.patchSha256 = createHash("sha256")
          .update(alternatePatch)
          .digest("hex");
        await writeJson(executionPath, execution);
        expect(
          script(item, "execution.mjs", ["verify-wave", runId]).status,
        ).not.toBe(0);
        await writeFile(
          join(dirname(item.evidence), String(writerResult.patchFile)),
          patchText,
          { mode: 0o600 },
        );
        writerResult.patchSha256 = createHash("sha256")
          .update(patchText)
          .digest("hex");
        await writeJson(executionPath, execution);
      }
      const verified = script(item, "execution.mjs", ["verify-wave", runId]);
      expect(verified.status, verified.stderr).toBe(0);
      expect(JSON.parse(verified.stdout)).toBe(index < waveCount - 1);
    }
    expect(script(item, "execution.mjs", ["verify", runId]).status).toBe(0);
    expect(
      script(item, "implementation-review.mjs", [
        "prepare",
        runId,
        "implementation",
      ]).status,
    ).toBe(0);
    const implementation = await json(
      join(item.evidence, "implementation-review.json"),
    );
    const implementationRevision = implementation.revision as Record<
      string,
      unknown
    >;
    expect(implementationRevision.comparison).toMatchObject({
      baseRevision: revision.head,
      changedPaths: ["src/claude/index.ts", "src/codex/index.ts"],
    });
    expect(implementation.checks).toHaveLength(2);

    const acceptedExecution = await json(executionPath);
    const accepted = acceptedExecution.results as Record<string, unknown>[];
    const writer = required(
      accepted.find((entry) => entry.effect === "proposal-integrated"),
      "accepted Codex writer result",
    );
    const acceptedChangedFiles = writer.changedFiles;
    const patchPath = join(dirname(item.evidence), String(writer.patchFile));
    const acceptedPatch = await readFile(patchPath);
    await writeFile(patchPath, "tampered patch\n");
    expect(script(item, "execution.mjs", ["verify", runId]).status).not.toBe(0);
    await writeFile(patchPath, acceptedPatch);
    expect(script(item, "execution.mjs", ["verify", runId]).status).toBe(0);

    writer.effect = "analysis";
    await writeJson(executionPath, acceptedExecution);
    expect(script(item, "execution.mjs", ["verify", runId]).status).not.toBe(0);

    writer.effect = "proposal-integrated";
    writer.changedFiles = ["src/codex/../outside.ts"];
    await writeJson(executionPath, acceptedExecution);
    expect(script(item, "execution.mjs", ["verify", runId]).status).not.toBe(0);

    writer.changedFiles = acceptedChangedFiles;
    await writeJson(executionPath, acceptedExecution);
    expect(script(item, "execution.mjs", ["verify", runId]).status).toBe(0);

    const router = document.router as Record<string, unknown>;
    const routed = router.result as Record<string, unknown>;
    const validFingerprint = routed.planFingerprint;
    routed.routingPolicyVersion = "sdd-routing-v999";
    await writeJson(routePath, document);
    const obsoletePolicy = script(item, "routing.mjs", ["verify", runId]);
    expect(obsoletePolicy.status).not.toBe(0);

    routed.routingPolicyVersion = "sdd-routing-v2";
    routed.planFingerprint = validFingerprint;
    routed.planFingerprint = "f".repeat(64);
    await writeJson(routePath, document);
    expect(script(item, "routing.mjs", ["verify", runId]).status).not.toBe(0);
    expect(script(item, "execution.mjs", ["verify", runId]).status).not.toBe(0);
  }, 45_000);

  test("rejects a writer wave containing more than one commit", async () => {
    const item = await fixture();
    await completeHostWriterRouting(item);
    const result = await writeHostCheckpoint(item, true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/exactly one non-merge commit/u);
  }, 15_000);

  test("binds critical cross-provider review to Sol ultra", async () => {
    const item = await fixture();
    await completeHostWriterRouting(item, "critical");
    const checkpoint = await writeHostCheckpoint(item);
    expect(checkpoint.status, checkpoint.stderr).toBe(0);
    expect(script(item, "execution.mjs", ["verify", runId]).status).toBe(0);
    expect(
      script(item, "implementation-review.mjs", [
        "prepare",
        runId,
        "implementation",
      ]).status,
    ).toBe(0);
    const path = join(item.evidence, "implementation-review.json");
    let document = await json(path);
    expect(document.codexReviewPolicy).toEqual({
      source: "server-allowlisted",
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      reason: "critical-cross-provider-review",
    });
    const revision = document.revision as Record<string, unknown>;
    document.state = "claude-frozen";
    document.claudeReview = review("claude", revision, "implementation");
    await writeJson(path, document);
    expect(
      script(item, "implementation-review.mjs", [
        "verify-claude",
        runId,
        "implementation",
      ]).status,
    ).toBe(0);
    document = await json(path);
    const claudeReview = document.claudeReview as Record<string, unknown>;
    document.state = "complete";
    document.codexReview = review(
      "codex",
      revision,
      "implementation",
      String(claudeReview.reviewId),
    );
    document.verdict = "approved";
    await writeJson(path, document);
    expect(
      script(item, "implementation-review.mjs", [
        "verify",
        runId,
        "implementation",
      ]).status,
    ).not.toBe(0);

    document.codexReview = review(
      "codex",
      revision,
      "implementation",
      String(claudeReview.reviewId),
      { model: "gpt-5.6-sol", reasoningEffort: "ultra" },
    );
    await writeJson(path, document);
    expect(
      script(item, "implementation-review.mjs", [
        "verify",
        runId,
        "implementation",
      ]).status,
    ).toBe(0);
  }, 15_000);

  test("executes a quality-selected all-host route without a worker call", async () => {
    const item = await fixture();
    await completeApprovedPlanReview(item);
    await completeHostOnlyRouting(item);

    await completeHostOnlyExecution(item);
    await expect(
      json(join(item.evidence, "execution.json")),
    ).resolves.toMatchObject({
      state: "complete",
      results: [{ provider: "claude-host", effect: "analysis" }],
    });
  }, 15_000);

  test("assembles a bounded digest-only proof pack after every gate passes", async () => {
    const item = await fixture();
    await completeApprovedPlanReview(item);
    await completeHostOnlyRouting(item);
    await completeHostOnlyExecution(item);

    for (const phase of ["implementation", "convergence"] as const) {
      expect(
        script(item, "implementation-review.mjs", ["prepare", runId, phase])
          .status,
      ).toBe(0);
      const path = join(item.evidence, `${phase}-review.json`);
      let document = await json(path);
      const revision = document.revision as Record<string, unknown>;
      document.state = "claude-frozen";
      document.claudeReview = review("claude", revision, phase);
      await writeJson(path, document);
      expect(
        script(item, "implementation-review.mjs", [
          "verify-claude",
          runId,
          phase,
        ]).status,
      ).toBe(0);
      document = await json(path);
      const claudeReview = document.claudeReview as Record<string, unknown>;
      document.state = "complete";
      document.codexReview = review(
        "codex",
        revision,
        phase,
        String(claudeReview.reviewId),
      );
      document.verdict = "approved";
      await writeJson(path, document);
      expect(
        script(item, "implementation-review.mjs", ["verify", runId, phase])
          .status,
      ).toBe(0);
    }

    const assembled = script(item, "proof-pack.mjs", ["assemble", runId]);
    expect(assembled.status).toBe(0);
    const proof = await json(join(item.evidence, "proof-pack.json"));
    expect(proof).toMatchObject({
      kind: "proof-pack",
      state: "complete",
      decisions: {
        plan: "approved",
        implementation: "approved",
        convergence: "approved",
      },
      delegatedJobs: [],
    });
    expect(proof.bundleFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(proof.evidence).toHaveLength(5);
    expect(proof.codexReviews).toHaveLength(3);
    expect(script(item, "proof-pack.mjs", ["verify", runId]).status).toBe(0);

    const executionPath = join(item.evidence, "execution.json");
    const execution = await json(executionPath);
    const preparedAt = execution.preparedAt;
    execution.preparedAt = "2026-01-02T00:00:00.000Z";
    await writeJson(executionPath, execution);
    expect(script(item, "proof-pack.mjs", ["assemble", runId]).status).not.toBe(
      0,
    );
    execution.preparedAt = preparedAt;
    await writeJson(executionPath, execution);
    expect(script(item, "proof-pack.mjs", ["verify", runId]).status).toBe(0);

    const convergencePath = join(item.evidence, "convergence-review.json");
    const convergence = await json(convergencePath);
    convergence.verdict = "changes-requested";
    await writeJson(convergencePath, convergence);
    expect(script(item, "proof-pack.mjs", ["assemble", runId]).status).not.toBe(
      0,
    );
    convergence.verdict = "approved";
    await writeJson(convergencePath, convergence);
    expect(script(item, "proof-pack.mjs", ["verify", runId]).status).toBe(0);

    await mkdir(join(item.root, ".specify/agents"), { recursive: true });
    expect(script(item, "handoff.mjs", ["prepare", runId]).status).toBe(0);
    const handoffContext = await json(
      join(item.evidence, "handoff-context.json"),
    );
    await writeFile(
      join(dirname(item.evidence), "handoff-draft.md"),
      `# Handoff\n\n${String(handoffContext.marker)}\n`,
    );
    expect(script(item, "handoff.mjs", ["verify", runId]).status).toBe(0);
    expect(script(item, "handoff.mjs", ["verify", runId]).status).toBe(0);

    execution.preparedAt = "2026-01-03T00:00:00.000Z";
    await writeJson(executionPath, execution);
    expect(script(item, "handoff.mjs", ["verify", runId]).status).not.toBe(0);
    execution.preparedAt = preparedAt;
    await writeJson(executionPath, execution);
    expect(script(item, "handoff.mjs", ["verify", runId]).status).toBe(0);
  }, 60_000);

  test.runIf(process.platform !== "win32")(
    "rejects symlinked evidence",
    async () => {
      const item = await fixture();
      expect(script(item, "plan-review.mjs", ["prepare", runId]).status).toBe(
        0,
      );
      const path = join(item.evidence, "plan-review.json");
      const outside = join(item.root, "outside.json");
      await writeFile(outside, "{}\n");
      await unlink(path);
      await symlink(outside, path);
      const result = script(item, "plan-review.mjs", ["verify", runId]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/regular non-symlink file/u);
    },
  );
});
