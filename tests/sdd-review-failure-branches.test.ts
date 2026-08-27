import { createHash } from "node:crypto";

import { describe, expect, test, vi } from "vitest";

import {
  MAX_ARTIFACT_BYTES,
  createRevisionSeal,
  evaluateDualReviewGate,
  evaluateRevisionSealFreshness,
  validateRevisionSeal,
  type ArtifactReadResult,
  type RevisionComparison,
  type RevisionSeal,
  type RevisionSealDependencies,
  type ReviewWorkspaceSnapshot,
} from "../src/sdd/review/index.js";

const REVISION_A = "a".repeat(40);
const REVISION_B = "b".repeat(40);
const DEFAULT_SNAPSHOT: ReviewWorkspaceSnapshot = {
  revision: REVISION_A,
  clean: true,
  fingerprint: digest("clean-a"),
};

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function dependencies(
  files: Readonly<Record<string, string | Uint8Array>>,
  options: {
    readonly snapshot?: ReviewWorkspaceSnapshot;
    readonly snapshotWorkspace?: () => Promise<ReviewWorkspaceSnapshot>;
    readonly compareRevision?: (
      baseRevision: string,
      currentRevision: string,
    ) => Promise<RevisionComparison>;
  } = {},
): RevisionSealDependencies {
  return {
    snapshotWorkspace:
      options.snapshotWorkspace ??
      (async () => options.snapshot ?? DEFAULT_SNAPSHOT),
    readArtifact: async (path) => {
      const content = files[path];
      if (content === undefined) {
        throw new Error(`missing fixture artifact: ${path}`);
      }
      return {
        content: typeof content === "string" ? Buffer.from(content) : content,
        type: "file",
        symbolicLink: false,
      };
    },
    ...(options.compareRevision === undefined
      ? {}
      : { compareRevision: options.compareRevision }),
  };
}

function hostReview(
  sealId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    reviewId: "host-review",
    phase: "plan",
    sealId,
    reviewer: {
      provider: "claude",
      lane: "claude-host",
      modelSource: "host-selected",
      attestation: "host-declared",
    },
    verdict: "approved",
    summary: "The host approved the sealed revision.",
    findings: [],
    ...overrides,
  };
}

function codexReview(
  sealId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    reviewId: "codex-review",
    phase: "plan",
    sealId,
    reviewer: {
      provider: "codex",
      lane: "codex",
      modelSource: "worker-resolved",
      model: "gpt-review",
      reasoningEffort: "server-default",
    },
    execution: {
      fresh: true,
      sandbox: "read-only",
      approvalPolicy: "never",
      ephemeral: true,
    },
    verdict: "approved",
    summary: "Codex approved the sealed revision.",
    findings: [],
    ...overrides,
  };
}

function mutableSeal(seal: RevisionSeal): Record<string, unknown> {
  return structuredClone(seal) as unknown as Record<string, unknown>;
}

describe("dual review gate failure branches", () => {
  test("rejects an invalid seal before reading workspace or provider evidence", async () => {
    const snapshotWorkspace = vi.fn(async () => DEFAULT_SNAPSHOT);

    const result = await evaluateDualReviewGate(
      {
        seal: null,
        hostEvidence: null,
        codexEvidence: null,
      },
      dependencies({ "specs/plan.md": "# Plan\n" }, { snapshotWorkspace }),
    );

    expect(result).toEqual({
      passed: false,
      status: "blocked",
      sealId: null,
      reasons: ["invalid-revision-seal"],
      freshnessReasons: [],
      evidenceDigests: { host: null, codex: null },
    });
    expect(snapshotWorkspace).not.toHaveBeenCalled();
  });

  test("reports malformed provider evidence without manufacturing digests", async () => {
    const files = { "specs/plan.md": "# Plan\n" };
    const seal = await createRevisionSeal(
      { mode: "strict", artifactPaths: ["specs/plan.md"] },
      dependencies(files),
    );

    const result = await evaluateDualReviewGate(
      { seal, hostEvidence: null, codexEvidence: { malformed: true } },
      dependencies(files),
    );

    expect(result).toMatchObject({
      passed: false,
      status: "blocked",
      reasons: ["invalid-host-evidence", "invalid-codex-evidence"],
      evidenceDigests: { host: null, codex: null },
    });
  });

  test("blocks host mismatch, requested changes, phase drift, and out-of-scope findings", async () => {
    const files = { "specs/plan.md": "# Plan\n" };
    const seal = await createRevisionSeal(
      { mode: "strict", artifactPaths: ["specs/plan.md"] },
      dependencies(files),
    );
    const hostFinding = {
      id: "host-outside-scope",
      severity: "medium",
      requirement: "Review only sealed paths",
      summary: "The host finding names an unsealed file.",
      artifactPath: "src/outside.ts",
      nextAction: "Start a correctly scoped review.",
    };
    const codexFinding = {
      id: "codex-outside-scope",
      severity: "medium",
      requirement: "Review only sealed paths",
      summary: "The Codex finding names another unsealed file.",
      artifactPath: "src/also-outside.ts",
      nextAction: "Start a correctly scoped review.",
    };

    const result = await evaluateDualReviewGate(
      {
        seal,
        hostEvidence: hostReview(digest("wrong-seal"), {
          phase: "implementation",
          verdict: "changes-requested",
          findings: [hostFinding],
        }),
        codexEvidence: codexReview(seal.sealId, {
          findings: [codexFinding],
        }),
      },
      dependencies(files),
    );

    expect(result).toMatchObject({ passed: false, status: "blocked" });
    expect(result.reasons).toEqual([
      "host-seal-mismatch",
      "host-changes-requested",
      "review-phase-mismatch",
      "host-finding-outside-seal",
      "codex-finding-outside-seal",
    ]);
  });

  test("fails closed when freshness evaluation itself throws", async () => {
    const files = { "specs/plan.md": "# Plan\n" };
    const comparison = {
      baseRevision: REVISION_B,
      changedPaths: ["src/index.ts"],
      diffSha256: digest("comparison"),
    };
    const seal = await createRevisionSeal(
      {
        mode: "strict",
        artifactPaths: ["specs/plan.md"],
        baseRevision: REVISION_B,
      },
      dependencies(files, { compareRevision: async () => comparison }),
    );
    const unstableDependencies = dependencies(files);
    Object.defineProperty(unstableDependencies, "compareRevision", {
      get() {
        throw new Error("comparator lookup failed");
      },
    });

    const result = await evaluateDualReviewGate(
      {
        seal,
        hostEvidence: hostReview(seal.sealId),
        codexEvidence: codexReview(seal.sealId),
      },
      unstableDependencies,
    );

    expect(result).toMatchObject({
      passed: false,
      status: "stale",
      reasons: [],
      freshnessReasons: ["freshness-check-failed"],
    });
  });
});

describe("revision seal failure branches", () => {
  test("rejects structurally invalid or content-tampered seals", async () => {
    const seal = await createRevisionSeal(
      {
        mode: "strict",
        artifactPaths: ["specs/a.md", "specs/b.md"],
      },
      dependencies({
        "specs/a.md": "a\n",
        "specs/b.md": "b\n",
      }),
    );
    const cases: readonly {
      readonly expected: RegExp;
      readonly mutate: (value: Record<string, unknown>) => void;
    }[] = [
      {
        expected: /clean must be a boolean/i,
        mutate: (value) => {
          value.clean = "yes";
        },
      },
      {
        expected: /strict review requires a clean workspace/i,
        mutate: (value) => {
          value.clean = false;
        },
      },
      {
        expected: /artifacts must contain/i,
        mutate: (value) => {
          value.artifacts = [];
        },
      },
      {
        expected: /invalid byte count/i,
        mutate: (value) => {
          const artifacts = value.artifacts as Record<string, unknown>[];
          if (artifacts[0] !== undefined) artifacts[0].bytes = -1;
        },
      },
      {
        expected: /duplicate artifact paths/i,
        mutate: (value) => {
          const artifacts = value.artifacts as Record<string, unknown>[];
          if (artifacts[0] !== undefined && artifacts[1] !== undefined) {
            artifacts[1].path = artifacts[0].path;
          }
        },
      },
      {
        expected: /canonical sorted order/i,
        mutate: (value) => {
          const artifacts = value.artifacts as Record<string, unknown>[];
          value.artifacts = [...artifacts].reverse();
        },
      },
      {
        expected: /content does not match its sealId/i,
        mutate: (value) => {
          value.sealId = "f".repeat(64);
        },
      },
    ];

    for (const { expected, mutate } of cases) {
      const candidate = mutableSeal(seal);
      mutate(candidate);
      expect(() => validateRevisionSeal(candidate)).toThrow(expected);
    }
  });

  test("enforces aggregate artifact limits while creating and validating seals", async () => {
    const oversizedSet = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [
        `specs/${index}.md`,
        Buffer.alloc(MAX_ARTIFACT_BYTES),
      ]),
    );

    await expect(
      createRevisionSeal(
        { mode: "strict", artifactPaths: Object.keys(oversizedSet) },
        dependencies(oversizedSet),
      ),
    ).rejects.toThrow(/total limit/i);

    const seal = await createRevisionSeal(
      { mode: "strict", artifactPaths: ["specs/plan.md"] },
      dependencies({ "specs/plan.md": "# Plan\n" }),
    );
    const candidate = mutableSeal(seal);
    candidate.artifacts = Array.from({ length: 5 }, (_, index) => ({
      path: `specs/${index}.md`,
      bytes: MAX_ARTIFACT_BYTES,
      sha256: digest(`artifact-${index}`),
    }));

    expect(() => validateRevisionSeal(candidate)).toThrow(/total limit/i);
  });

  test("rejects invalid modes, empty artifacts, and unavailable comparisons", async () => {
    const files = { "specs/plan.md": "# Plan\n" };

    await expect(
      createRevisionSeal(
        {
          mode: "unsupported" as "strict",
          artifactPaths: ["specs/plan.md"],
        },
        dependencies(files),
      ),
    ).rejects.toThrow(/mode must be strict or draft/i);
    await expect(
      createRevisionSeal(
        { mode: "strict", artifactPaths: [] },
        dependencies(files),
      ),
    ).rejects.toThrow(/must contain/i);
    await expect(
      createRevisionSeal(
        {
          mode: "strict",
          artifactPaths: ["specs/plan.md"],
          baseRevision: REVISION_B,
        },
        dependencies(files),
      ),
    ).rejects.toThrow(/comparison requires two committed revisions/i);
  });

  test("rejects malformed artifact reader results", async () => {
    const createWithResult = async (
      result: ArtifactReadResult,
    ): Promise<RevisionSeal> =>
      await createRevisionSeal(
        { mode: "strict", artifactPaths: ["specs/plan.md"] },
        {
          snapshotWorkspace: async () => DEFAULT_SNAPSHOT,
          readArtifact: async () => result,
        },
      );

    await expect(
      createWithResult({
        content: Buffer.from("plan"),
        type: "file",
        symbolicLink: true,
      }),
    ).rejects.toThrow(/symbolic link/i);
    await expect(
      createWithResult({
        content: Buffer.from("plan"),
        type: "directory",
        symbolicLink: false,
      }),
    ).rejects.toThrow(/regular file/i);
    await expect(
      createWithResult({
        content: "not bytes" as unknown as Uint8Array,
        type: "file",
        symbolicLink: false,
      }),
    ).rejects.toThrow(/did not return bytes/i);
    await expect(
      createWithResult({
        content: Buffer.alloc(MAX_ARTIFACT_BYTES + 1),
        type: "file",
        symbolicLink: false,
      }),
    ).rejects.toThrow(/exceeds/i);
  });

  test("rejects oversized and non-canonical Git comparison scopes", async () => {
    const files = { "specs/plan.md": "# Plan\n" };
    const createWithComparison = async (
      comparison: RevisionComparison,
    ): Promise<RevisionSeal> =>
      await createRevisionSeal(
        {
          mode: "strict",
          artifactPaths: ["specs/plan.md"],
          baseRevision: REVISION_B,
        },
        dependencies(files, { compareRevision: async () => comparison }),
      );

    await expect(
      createWithComparison({
        baseRevision: REVISION_B,
        changedPaths: Array.from(
          { length: 257 },
          (_, index) => `src/${index}.ts`,
        ),
        diffSha256: digest("large-comparison"),
      }),
    ).rejects.toThrow(/at most 256/i);
    await expect(
      createWithComparison({
        baseRevision: REVISION_B,
        changedPaths: ["src/a.ts", "src/a.ts"],
        diffSha256: digest("duplicate-comparison"),
      }),
    ).rejects.toThrow(/unique and canonical/i);
    await expect(
      createWithComparison({
        baseRevision: REVISION_B,
        changedPaths: ["src/z.ts", "src/a.ts"],
        diffSha256: digest("unsorted-comparison"),
      }),
    ).rejects.toThrow(/unique and canonical/i);
  });

  test("reports workspace, artifact, and comparison freshness failures", async () => {
    const files = { "specs/plan.md": "# Plan\n" };
    const comparison = {
      baseRevision: REVISION_B,
      changedPaths: ["src/index.ts"],
      diffSha256: digest("comparison"),
    };
    const seal = await createRevisionSeal(
      {
        mode: "strict",
        artifactPaths: ["specs/plan.md"],
        baseRevision: REVISION_B,
      },
      dependencies(files, { compareRevision: async () => comparison }),
    );

    await expect(
      evaluateRevisionSealFreshness(
        seal,
        dependencies(files, {
          snapshotWorkspace: async () => {
            throw new Error("snapshot unavailable");
          },
        }),
      ),
    ).resolves.toEqual({
      current: false,
      reasons: ["workspace-snapshot-invalid"],
    });

    const dirty = await evaluateRevisionSealFreshness(
      seal,
      dependencies(files, {
        snapshot: { ...DEFAULT_SNAPSHOT, clean: false },
        compareRevision: async () => comparison,
      }),
    );
    expect(dirty.reasons).toEqual([
      "clean-state-changed",
      "strict-workspace-dirty",
    ]);

    const artifactUnavailable = await evaluateRevisionSealFreshness(
      seal,
      dependencies({}, { compareRevision: async () => comparison }),
    );
    expect(artifactUnavailable.reasons).toEqual([
      "artifact-unavailable:specs/plan.md",
    ]);

    const comparisonMissing = await evaluateRevisionSealFreshness(
      seal,
      dependencies(files),
    );
    expect(comparisonMissing.reasons).toEqual(["comparison-unavailable"]);

    const comparisonFailed = await evaluateRevisionSealFreshness(
      seal,
      dependencies(files, {
        compareRevision: async () => {
          throw new Error("comparison failed");
        },
      }),
    );
    expect(comparisonFailed.reasons).toEqual(["comparison-unavailable"]);
  });
});
