import { writeFile } from "node:fs/promises";

import { afterEach, describe, expect, test } from "vitest";

import type { WorkerConfig } from "../src/config/worker-config.js";
import { ERROR_CODES, WorkerError } from "../src/core/errors.js";
import type { ReasoningEffort } from "../src/core/types.js";
import { GitClient, type GitResult } from "../src/runtime/git-client.js";
import {
  SddReviewService,
  validateSddReviewInput,
  type StartSddReviewInput,
} from "../src/sdd/review-job.js";
import {
  createTestRepository,
  makeConfig,
  runGit,
  type TestRepository,
} from "./helpers.js";

const repositories: TestRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map(async (item) => item.cleanup()));
});

async function repository(): Promise<TestRepository> {
  const item = await createTestRepository();
  repositories.push(item);
  return item;
}

function configFor(item?: TestRepository): WorkerConfig {
  return makeConfig({
    allowedModels: ["gpt-5.6-sol"],
    ...(item === undefined ? {} : { allowedRoots: [item.root] }),
  });
}

function inputRecord(): Record<string, unknown> {
  return {
    phase: "plan",
    mode: "strict",
    artifactPaths: ["README.md"],
    expectedRevision: "a".repeat(40),
    hostReview: {
      reviewId: "claude-plan-review",
      verdict: "approved",
      summary: "The host approves the sealed review scope.",
      findings: [],
    },
  };
}

function withInputField(key: string, value: unknown): Record<string, unknown> {
  return { ...inputRecord(), [key]: value };
}

function withHostField(key: string, value: unknown): Record<string, unknown> {
  const input = inputRecord();
  return {
    ...input,
    hostReview: {
      ...(input.hostReview as Record<string, unknown>),
      [key]: value,
    },
  };
}

function expectInvalidRequest(
  value: unknown,
  config: WorkerConfig,
  message: RegExp,
): void {
  let thrown: unknown;
  try {
    validateSddReviewInput(value, config);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(WorkerError);
  expect(thrown).toMatchObject({ code: ERROR_CODES.INVALID_REQUEST });
  expect((thrown as Error).message).toMatch(message);
}

function strictInput(
  item: TestRepository,
  overrides: Partial<StartSddReviewInput> = {},
): StartSddReviewInput {
  return {
    phase: "plan",
    mode: "strict",
    artifactPaths: ["README.md"],
    expectedRevision: item.revision,
    hostReview: {
      reviewId: "claude-plan-review",
      verdict: "approved",
      summary: "The host approves the sealed review scope.",
      findings: [],
    },
    ...overrides,
  };
}

describe("SDD review job validation branches", () => {
  test("accepts every bounded optional request field", () => {
    const value = {
      ...inputRecord(),
      phase: "artifacts",
      mode: "draft",
      expectedRevision: "A".repeat(40),
      baseRevision: "B".repeat(64),
      focus: "\tReview the migration boundary.\n",
      cwd: "/bounded/repository",
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      timeoutMs: 30_000,
      idempotencyKey: "review-attempt-1",
      hostReview: {
        reviewId: "claude-artifact-review",
        verdict: "changes-requested",
        summary: "The host requests a bounded correction.",
        findings: [],
        declaredModelLabel: "host-selected-model",
      },
    };

    expect(validateSddReviewInput(value, configFor())).toBe(value);
  });

  test.each([
    ["non-object input", null, /must be an object/u],
    [
      "unknown input property",
      { ...inputRecord(), authority: "write" },
      /unsupported properties/u,
    ],
    ["invalid phase", withInputField("phase", "delivery"), /phase is invalid/u],
    [
      "invalid mode",
      withInputField("mode", "live"),
      /mode must be strict or draft/u,
    ],
    [
      "non-array artifacts",
      withInputField("artifactPaths", "README.md"),
      /artifactPaths must be an array/u,
    ],
    [
      "non-string expected revision",
      withInputField("expectedRevision", 42),
      /expectedRevision must be/u,
    ],
    [
      "abbreviated expected revision",
      withInputField("expectedRevision", "deadbeef"),
      /expectedRevision must be/u,
    ],
    [
      "non-string base revision",
      withInputField("baseRevision", 42),
      /baseRevision must be/u,
    ],
    [
      "abbreviated base revision",
      withInputField("baseRevision", "deadbeef"),
      /baseRevision must be/u,
    ],
    [
      "missing strict revision",
      withInputField("expectedRevision", undefined),
      /strict reviews require/u,
    ],
    [
      "non-object host review",
      withInputField("hostReview", []),
      /hostReview must be an object/u,
    ],
    [
      "unknown host property",
      withHostField("provider", "claude"),
      /unsupported properties/u,
    ],
    [
      "non-string host id",
      withHostField("reviewId", 7),
      /reviewId is invalid/u,
    ],
    [
      "unsafe host id",
      withHostField("reviewId", "not safe"),
      /reviewId is invalid/u,
    ],
    [
      "invalid host verdict",
      withHostField("verdict", "maybe"),
      /verdict is invalid/u,
    ],
    [
      "non-string host summary",
      withHostField("summary", 7),
      /summary or findings are invalid/u,
    ],
    [
      "non-array host findings",
      withHostField("findings", {}),
      /summary or findings are invalid/u,
    ],
    ["non-string focus", withInputField("focus", 7), /focus must contain/u],
    ["empty focus", withInputField("focus", " \n "), /focus must contain/u],
    [
      "oversized focus",
      withInputField("focus", "x".repeat(4_001)),
      /focus must contain/u,
    ],
    [
      "null-control focus",
      withInputField("focus", "unsafe\u0001focus"),
      /focus must contain/u,
    ],
    [
      "vertical-tab focus",
      withInputField("focus", "unsafe\u000bfocus"),
      /focus must contain/u,
    ],
    [
      "form-feed focus",
      withInputField("focus", "unsafe\u000cfocus"),
      /focus must contain/u,
    ],
    [
      "record-separator focus",
      withInputField("focus", "unsafe\u001efocus"),
      /focus must contain/u,
    ],
    [
      "delete-control focus",
      withInputField("focus", "unsafe\u007ffocus"),
      /focus must contain/u,
    ],
    [
      "non-string cwd",
      withInputField("cwd", 7),
      /cwd must be a bounded string/u,
    ],
    [
      "oversized cwd",
      withInputField("cwd", "x".repeat(4_097)),
      /cwd must be a bounded string/u,
    ],
    ["non-string model", withInputField("model", 7), /model must be listed/u],
    [
      "unlisted model",
      withInputField("model", "gpt-unlisted"),
      /model must be listed/u,
    ],
    [
      "non-string effort",
      withInputField("reasoningEffort", 7),
      /reasoningEffort is invalid/u,
    ],
    [
      "unknown effort",
      withInputField("reasoningEffort", "extreme"),
      /reasoningEffort is invalid/u,
    ],
    [
      "non-string idempotency key",
      withInputField("idempotencyKey", 7),
      /idempotencyKey must be a string/u,
    ],
    [
      "non-number timeout",
      withInputField("timeoutMs", "30000"),
      /timeoutMs must be a number/u,
    ],
  ] as const)("rejects %s", (_name, value, message) => {
    expectInvalidRequest(value, configFor(), message);
  });
});

describe("SDD review service error and task branches", () => {
  test("builds a focused comparison task and defaults Codex provenance for a dirty draft", async () => {
    const item = await repository();
    await writeFile(`${item.root}/README.md`, "committed change\n", "utf8");
    await runGit(item.root, ["add", "README.md"]);
    await runGit(item.root, ["commit", "--quiet", "-m", "review change"]);
    const currentRevision = (await runGit(item.root, ["rev-parse", "HEAD"]))
      .trim()
      .toLowerCase();
    await writeFile(
      `${item.root}/src/stable.ts`,
      "export const stable = false;\n",
      "utf8",
    );

    const service = new SddReviewService(
      configFor(item),
      new GitClient(configFor(item)),
    );
    const prepared = await service.prepare(
      {
        phase: "implementation",
        mode: "draft",
        artifactPaths: ["src/allowed.ts", "README.md"],
        expectedRevision: currentRevision.toUpperCase(),
        baseRevision: item.revision.toUpperCase(),
        focus: "  Confirm the migration boundary.  ",
        hostReview: {
          reviewId: "claude-implementation-review",
          verdict: "approved",
          summary: "The host approves this draft scope.",
          findings: [],
          declaredModelLabel: "host-selected-model",
        },
      },
      item.root,
    );

    expect(prepared.seal).toMatchObject({
      mode: "draft",
      revision: currentRevision,
      clean: false,
      artifacts: [{ path: "README.md" }, { path: "src/allowed.ts" }],
      comparison: {
        baseRevision: item.revision,
        changedPaths: ["README.md"],
      },
    });
    expect(prepared.hostEvidence.reviewer).toMatchObject({
      modelSource: "host-selected",
      declaredModelLabel: "host-selected-model",
    });
    expect(prepared.task).toContain(
      `Comparison base revision: ${item.revision}.`,
    );
    expect(prepared.task).toContain("Changed review scope:\n- README.md");
    expect(prepared.task).toContain(
      "Review focus:\nConfirm the migration boundary.",
    );

    const artifact = await service.finalize(
      prepared,
      JSON.stringify({
        schemaVersion: 1,
        verdict: "approved",
        summary: "Codex independently approves the draft.",
        findings: [],
      }),
    );
    expect(artifact.codexEvidence.reviewer).toMatchObject({
      model: "server-default",
      reasoningEffort: "server-default",
    });
    expect(artifact.gate).toMatchObject({
      passed: false,
      status: "blocked",
      reasons: ["draft-review-advisory-only"],
      freshnessReasons: [],
    });
  });

  test("maps revision, host-evidence, filesystem, and unexpected input failures", async () => {
    const item = await repository();
    const service = new SddReviewService(
      configFor(item),
      new GitClient(configFor(item)),
    );

    await expect(
      service.prepare(
        strictInput(item, { expectedRevision: "f".repeat(40) }),
        item.root,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.REVISION_MISMATCH });

    await expect(
      service.prepare(
        strictInput(item, { artifactPaths: ["missing.md"] }),
        item.root,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.REVIEW_INVALID });

    await expect(
      service.prepare(
        strictInput(item, {
          hostReview: {
            reviewId: "claude-plan-review",
            verdict: "approved",
            summary: "",
            findings: [],
          },
        }),
        item.root,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.REVIEW_INVALID });

    await expect(
      service.prepare(withInputField("phase", "delivery"), item.root),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_REQUEST });

    const hostileInput = new Proxy(inputRecord(), {
      ownKeys: () => {
        throw new Error("input enumeration failed");
      },
    });
    await expect(
      service.prepare(hostileInput, item.root),
    ).rejects.toMatchObject({
      code: ERROR_CODES.REVIEW_INVALID,
      message: "input enumeration failed",
    });
  });

  test("retains the defensive strict expected-revision check after validation", async () => {
    const item = await repository();
    const service = new SddReviewService(
      configFor(item),
      new GitClient(configFor(item)),
    );
    const changingInput = strictInput(item) as unknown as Record<
      string,
      unknown
    >;
    let reads = 0;
    Object.defineProperty(changingInput, "expectedRevision", {
      configurable: true,
      enumerable: true,
      get: () => {
        reads += 1;
        return reads <= 4 ? item.revision : undefined;
      },
    });

    await expect(
      service.prepare(changingInput, item.root),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_REQUEST,
      message: "Strict SDD reviews require expectedRevision",
    });
  });

  test("fails closed when the workspace changes during seal capture", async () => {
    const item = await repository();
    let statusCalls = 0;
    const fakeGit = {
      run: async (
        _cwd: string,
        args: readonly string[],
      ): Promise<GitResult> => {
        if (args[0] === "status") {
          statusCalls += 1;
          return {
            stdout: statusCalls === 1 ? "" : " M README.md\0",
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[0] === "rev-parse") {
          return { stdout: `${item.revision}\n`, stderr: "", exitCode: 0 };
        }
        throw new Error(`Unexpected Git command: ${String(args[0])}`);
      },
    } as unknown as GitClient;
    const service = new SddReviewService(configFor(item), fakeGit);

    await expect(
      service.prepare(strictInput(item), item.root),
    ).rejects.toMatchObject({
      code: ERROR_CODES.REVIEW_INVALID,
      message:
        "The review workspace changed while its revision seal was being captured",
    });
  });

  test("maps malformed Codex decision shapes and provenance to review errors", async () => {
    const item = await repository();
    const service = new SddReviewService(
      configFor(item),
      new GitClient(configFor(item)),
    );
    const prepared = await service.prepare(strictInput(item), item.root);
    const blockingFinding = {
      id: "codex-blocker",
      severity: "high",
      requirement: "The plan must remain bounded.",
      summary: "The plan is not bounded.",
      artifactPath: "README.md",
      nextAction: "Bound the affected plan section.",
    };
    const cases: readonly {
      readonly raw: unknown;
      readonly model?: string;
      readonly effort?: ReasoningEffort;
    }[] = [
      { raw: null },
      { raw: "[]" },
      {
        raw: JSON.stringify({
          schemaVersion: 1,
          verdict: "approved",
          summary: "Unexpected property.",
          findings: [],
          authority: "write",
        }),
      },
      {
        raw: JSON.stringify({
          schemaVersion: 2,
          verdict: "approved",
          summary: "Wrong schema.",
          findings: [],
        }),
      },
      {
        raw: JSON.stringify({
          schemaVersion: 1,
          verdict: "changes-requested",
          summary: "Missing finding.",
          findings: [],
        }),
      },
      {
        raw: JSON.stringify({
          schemaVersion: 1,
          verdict: "approved",
          summary: "Invalid approval.",
          findings: [blockingFinding],
        }),
      },
      {
        raw: JSON.stringify({
          schemaVersion: 1,
          verdict: "approved",
          summary: "Invalid model provenance.",
          findings: [],
        }),
        model: "model with spaces",
      },
      {
        raw: JSON.stringify({
          schemaVersion: 1,
          verdict: "approved",
          summary: "Invalid effort provenance.",
          findings: [],
        }),
        effort: "extreme" as ReasoningEffort,
      },
    ];

    for (const itemCase of cases) {
      await expect(
        service.finalize(
          prepared,
          itemCase.raw as string,
          itemCase.model,
          itemCase.effort,
        ),
      ).rejects.toMatchObject({ code: ERROR_CODES.REVIEW_INVALID });
    }
  });
});
