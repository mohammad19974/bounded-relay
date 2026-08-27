import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  createFileSystemArtifactReader,
  createRevisionSeal,
  evaluateDualPlanReviewGate,
  evaluateRevisionSealFreshness,
  parseCodexReviewEvidenceJson,
  parseHostReviewEvidenceJson,
  validateCodexReviewEvidence,
  validateHostReviewEvidence,
  type ArtifactReader,
  type CodexReviewEvidence,
  type HostReviewEvidence,
  type ReviewWorkspaceSnapshot,
  type RevisionSealDependencies,
} from "../src/sdd/review/index.js";

const cleanupPaths: string[] = [];
const REVISION_A = "a".repeat(40);
const REVISION_B = "b".repeat(40);

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
});

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function memoryDependencies(
  files: Readonly<Record<string, string>>,
  snapshot: ReviewWorkspaceSnapshot = {
    revision: REVISION_A,
    clean: true,
    fingerprint: digest("clean-a"),
  },
): RevisionSealDependencies {
  const reader: ArtifactReader = async (path) => {
    const content = files[path];
    if (content === undefined) {
      throw new Error("missing fixture artifact");
    }
    return {
      content: Buffer.from(content),
      type: "file",
      symbolicLink: false,
    };
  };
  return {
    snapshotWorkspace: async () => snapshot,
    readArtifact: reader,
  };
}

function hostEvidence(sealId: string): HostReviewEvidence {
  return validateHostReviewEvidence({
    schemaVersion: 1,
    reviewId: "host-plan-review",
    phase: "plan",
    sealId,
    reviewer: {
      provider: "claude",
      lane: "claude-host",
      modelSource: "host-selected",
      attestation: "host-declared",
    },
    verdict: "approved",
    summary: "The frozen plan satisfies the reviewed requirements.",
    findings: [],
  });
}

function codexEvidence(sealId: string): CodexReviewEvidence {
  return validateCodexReviewEvidence({
    schemaVersion: 1,
    reviewId: "codex-plan-review",
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
    summary: "The independent review found no blocking plan defects.",
    findings: [],
  });
}

describe("revision seals", () => {
  test("creates a canonical content-addressed strict seal", async () => {
    const files = {
      "specs/001-feature/plan.md": "# Plan\n",
      "specs/001-feature/spec.md": "# Spec\n",
    };
    const dependencies = memoryDependencies(files);

    const first = await createRevisionSeal(
      {
        mode: "strict",
        artifactPaths: [
          "specs/001-feature/spec.md",
          "specs/001-feature/plan.md",
        ],
      },
      dependencies,
    );
    const second = await createRevisionSeal(
      {
        mode: "strict",
        artifactPaths: [
          "specs/001-feature/plan.md",
          "specs/001-feature/spec.md",
        ],
      },
      dependencies,
    );

    expect(first).toEqual(second);
    expect(first.revision).toBe(REVISION_A);
    expect(first.clean).toBe(true);
    expect(first.artifacts.map((artifact) => artifact.path)).toEqual([
      "specs/001-feature/plan.md",
      "specs/001-feature/spec.md",
    ]);
    expect(first.artifacts[0]?.sha256).toBe(digest("# Plan\n"));
    expect(first.sealId).toMatch(/^[a-f0-9]{64}$/);
  });

  test("rejects unsafe paths, duplicates, dirty strict state, and abbreviated revisions", async () => {
    const files = { "specs/plan.md": "# Plan\n" };

    await expect(
      createRevisionSeal(
        {
          mode: "strict",
          artifactPaths: ["specs/plan.md", "specs/plan.md"],
        },
        memoryDependencies(files),
      ),
    ).rejects.toThrow(/duplicate/i);

    await expect(
      createRevisionSeal(
        { mode: "strict", artifactPaths: ["specs/../secret.md"] },
        memoryDependencies(files),
      ),
    ).rejects.toThrow(/safe repository-relative path/i);

    await expect(
      createRevisionSeal(
        { mode: "strict", artifactPaths: ["specs/plan\n.md"] },
        memoryDependencies(files),
      ),
    ).rejects.toThrow(/safe repository-relative path/i);

    await expect(
      createRevisionSeal(
        { mode: "strict", artifactPaths: ["specs/plan.md"] },
        memoryDependencies(files, {
          revision: REVISION_A,
          clean: false,
          fingerprint: digest("dirty"),
        }),
      ),
    ).rejects.toThrow(/clean workspace/i);

    await expect(
      createRevisionSeal(
        { mode: "strict", artifactPaths: ["specs/plan.md"] },
        memoryDependencies(files, {
          revision: "abc123",
          clean: true,
          fingerprint: digest("clean"),
        }),
      ),
    ).rejects.toThrow(/full Git revision/i);
  });

  test("detects artifact and workspace drift", async () => {
    const original = { "specs/plan.md": "# Original\n" };
    const seal = await createRevisionSeal(
      { mode: "strict", artifactPaths: ["specs/plan.md"] },
      memoryDependencies(original),
    );

    const contentDrift = await evaluateRevisionSealFreshness(
      seal,
      memoryDependencies({ "specs/plan.md": "# Revised\n" }),
    );
    expect(contentDrift.current).toBe(false);
    expect(contentDrift.reasons).toContain("artifact-changed:specs/plan.md");

    const workspaceDrift = await evaluateRevisionSealFreshness(
      seal,
      memoryDependencies(original, {
        revision: REVISION_B,
        clean: true,
        fingerprint: digest("clean-b"),
      }),
    );
    expect(workspaceDrift.current).toBe(false);
    expect(workspaceDrift.reasons).toContain("revision-changed");
    expect(workspaceDrift.reasons).toContain("workspace-fingerprint-changed");
  });

  test("binds implementation findings to a canonical Git comparison scope", async () => {
    const files = { "specs/plan.md": "# Current plan\n" };
    const comparison = {
      baseRevision: REVISION_B,
      changedPaths: ["src/deleted.ts", "src/updated.ts"],
      diffSha256: digest("base-to-current"),
    };
    const dependencies: RevisionSealDependencies = {
      ...memoryDependencies(files),
      compareRevision: async () => comparison,
    };
    const seal = await createRevisionSeal(
      {
        mode: "strict",
        artifactPaths: ["specs/plan.md"],
        baseRevision: REVISION_B,
      },
      dependencies,
    );
    expect(seal.comparison).toEqual(comparison);

    const host = {
      ...hostEvidence(seal.sealId),
      findings: [
        {
          id: "deleted-contract",
          severity: "medium" as const,
          requirement: "Preserve the removed contract",
          summary: "The deletion needs explicit compatibility evidence.",
          artifactPath: "src/deleted.ts",
          nextAction: "Document or restore the contract.",
        },
      ],
    };
    const gate = await evaluateDualPlanReviewGate(
      {
        seal,
        hostEvidence: host,
        codexEvidence: codexEvidence(seal.sealId),
      },
      dependencies,
    );
    expect(gate).toMatchObject({ passed: true, status: "ready" });

    const stale = await evaluateRevisionSealFreshness(seal, {
      ...memoryDependencies(files),
      compareRevision: async () => ({
        ...comparison,
        diffSha256: digest("changed-diff"),
      }),
    });
    expect(stale).toEqual({
      current: false,
      reasons: ["comparison-changed"],
    });
  });

  test.runIf(process.platform !== "win32")(
    "filesystem reader rejects symlink and non-regular artifacts",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "boundedrelay-review-"));
      cleanupPaths.push(root);
      await mkdir(join(root, "specs"));
      await writeFile(join(root, "outside.md"), "outside\n");
      await symlink(join(root, "outside.md"), join(root, "specs", "linked.md"));
      await mkdir(join(root, "specs", "directory.md"));
      const reader = await createFileSystemArtifactReader(root);

      await expect(reader("specs/linked.md")).rejects.toThrow(/symbolic link/i);
      await expect(reader("specs/directory.md")).rejects.toThrow(
        /regular file/i,
      );
    },
  );
});

describe("review evidence", () => {
  test("accepts only host-selected, host-declared Claude identity", () => {
    const sealId = digest("seal");
    expect(hostEvidence(sealId).reviewer).toEqual({
      provider: "claude",
      lane: "claude-host",
      modelSource: "host-selected",
      attestation: "host-declared",
    });

    expect(() =>
      validateHostReviewEvidence({
        ...hostEvidence(sealId),
        reviewer: {
          provider: "claude",
          lane: "claude-host",
          modelSource: "inferred",
          attestation: "host-declared",
          model: "opus",
        },
      }),
    ).toThrow(/host-selected/i);
  });

  test("requires structured fresh read-only Codex evidence", () => {
    const sealId = digest("seal");
    expect(codexEvidence(sealId).execution).toEqual({
      fresh: true,
      sandbox: "read-only",
      approvalPolicy: "never",
      ephemeral: true,
    });

    expect(() =>
      validateCodexReviewEvidence({
        ...codexEvidence(sealId),
        execution: {
          fresh: false,
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          ephemeral: false,
        },
      }),
    ).toThrow(/fresh/i);
  });

  test("rejects approved evidence with an unresolved High or Critical finding", () => {
    const sealId = digest("seal");
    const blockingFinding = {
      id: "blocking-contract",
      severity: "high",
      requirement: "Preserve the reviewed contract",
      summary: "The reviewed contract is not implemented.",
      artifactPath: "specs/plan.md",
      nextAction: "Resolve the defect on a new revision and review again.",
    };

    expect(() =>
      validateHostReviewEvidence({
        ...hostEvidence(sealId),
        findings: [blockingFinding],
      }),
    ).toThrow(/cannot approve.*High or Critical/iu);
    expect(() =>
      validateCodexReviewEvidence({
        ...codexEvidence(sealId),
        findings: [{ ...blockingFinding, severity: "critical" }],
      }),
    ).toThrow(/cannot approve.*High or Critical/iu);
  });

  test("rejects fenced, malformed, and empty evidence", () => {
    const sealId = digest("seal");
    const serialized = JSON.stringify(hostEvidence(sealId));

    expect(() =>
      parseHostReviewEvidenceJson(`\`\`\`json\n${serialized}\n\`\`\``),
    ).toThrow(/fenced JSON/i);
    expect(() => parseHostReviewEvidenceJson("{not-json")).toThrow(
      /valid JSON/i,
    );
    expect(() =>
      validateHostReviewEvidence({
        ...hostEvidence(sealId),
        summary: "   ",
      }),
    ).toThrow(/summary/i);
    expect(() =>
      parseCodexReviewEvidenceJson(JSON.stringify(codexEvidence(sealId))),
    ).not.toThrow();
  });

  test("bounds evidence collections and total serialized size", () => {
    const sealId = digest("seal");
    const finding = {
      severity: "low",
      requirement: "Bounded evidence",
      summary: "s".repeat(2_000),
      artifactPath: "specs/plan.md",
      nextAction: "n".repeat(2_000),
    };

    expect(() =>
      validateHostReviewEvidence({
        ...hostEvidence(sealId),
        findings: Array.from({ length: 101 }, (_, index) => ({
          ...finding,
          id: `finding-${index}`,
        })),
      }),
    ).toThrow(/at most 100/i);

    expect(() =>
      validateHostReviewEvidence({
        ...hostEvidence(sealId),
        findings: Array.from({ length: 20 }, (_, index) => ({
          ...finding,
          id: `finding-${index}`,
        })),
      }),
    ).toThrow(/65536-byte limit/i);
  });
});

describe("dual plan review gate", () => {
  test("passes only two approved reviews on the same current strict seal", async () => {
    const dependencies = memoryDependencies({
      "specs/plan.md": "# Frozen plan\n",
    });
    const seal = await createRevisionSeal(
      { mode: "strict", artifactPaths: ["specs/plan.md"] },
      dependencies,
    );

    const result = await evaluateDualPlanReviewGate(
      {
        seal,
        hostEvidence: hostEvidence(seal.sealId),
        codexEvidence: codexEvidence(seal.sealId),
      },
      dependencies,
    );

    expect(result).toMatchObject({
      passed: true,
      status: "ready",
      sealId: seal.sealId,
      reasons: [],
    });
    expect(result.evidenceDigests.host).toMatch(/^[a-f0-9]{64}$/);
    expect(result.evidenceDigests.codex).toMatch(/^[a-f0-9]{64}$/);
  });

  test("fails closed for draft, seal mismatch, requested changes, or stale workspace", async () => {
    const files = { "specs/plan.md": "# Frozen plan\n" };
    const strictDependencies = memoryDependencies(files);
    const strictSeal = await createRevisionSeal(
      { mode: "strict", artifactPaths: ["specs/plan.md"] },
      strictDependencies,
    );
    const wrongSeal = digest("wrong-seal");
    const mismatch = await evaluateDualPlanReviewGate(
      {
        seal: strictSeal,
        hostEvidence: hostEvidence(strictSeal.sealId),
        codexEvidence: codexEvidence(wrongSeal),
      },
      strictDependencies,
    );
    expect(mismatch.passed).toBe(false);
    expect(mismatch.reasons).toContain("codex-seal-mismatch");

    const duplicateReviewId = await evaluateDualPlanReviewGate(
      {
        seal: strictSeal,
        hostEvidence: hostEvidence(strictSeal.sealId),
        codexEvidence: {
          ...codexEvidence(strictSeal.sealId),
          reviewId: "host-plan-review",
        },
      },
      strictDependencies,
    );
    expect(duplicateReviewId.passed).toBe(false);
    expect(duplicateReviewId.reasons).toContain("duplicate-review-id");

    const requestedChanges = await evaluateDualPlanReviewGate(
      {
        seal: strictSeal,
        hostEvidence: hostEvidence(strictSeal.sealId),
        codexEvidence: {
          ...codexEvidence(strictSeal.sealId),
          verdict: "changes-requested",
          findings: [
            {
              id: "missing-check",
              severity: "high",
              requirement: "Verification",
              summary: "The plan omits a required verification gate.",
              artifactPath: "specs/plan.md",
              line: 1,
              nextAction: "Add the missing verification gate.",
            },
          ],
        },
      },
      strictDependencies,
    );
    expect(requestedChanges.passed).toBe(false);
    expect(requestedChanges.reasons).toContain("codex-changes-requested");

    const stale = await evaluateDualPlanReviewGate(
      {
        seal: strictSeal,
        hostEvidence: hostEvidence(strictSeal.sealId),
        codexEvidence: codexEvidence(strictSeal.sealId),
      },
      memoryDependencies(files, {
        revision: REVISION_B,
        clean: true,
        fingerprint: digest("clean-b"),
      }),
    );
    expect(stale.status).toBe("stale");
    expect(stale.passed).toBe(false);

    const draftDependencies = memoryDependencies(files, {
      revision: REVISION_A,
      clean: false,
      fingerprint: digest("draft"),
    });
    const draftSeal = await createRevisionSeal(
      { mode: "draft", artifactPaths: ["specs/plan.md"] },
      draftDependencies,
    );
    const draft = await evaluateDualPlanReviewGate(
      {
        seal: draftSeal,
        hostEvidence: hostEvidence(draftSeal.sealId),
        codexEvidence: codexEvidence(draftSeal.sealId),
      },
      draftDependencies,
    );
    expect(draft.passed).toBe(false);
    expect(draft.reasons).toContain("draft-review-advisory-only");
  });
});
