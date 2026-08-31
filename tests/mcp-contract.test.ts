import { chmod, rm } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

import { createProjectProfileTemplate } from "../src/sdd/routing/index.js";
import {
  createTestRepository,
  makeStateDirectory,
  type TestRepository,
} from "./helpers.js";

interface TestClient {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly repository: TestRepository;
  readonly stateDirectory: string;
  close(): Promise<void>;
}

describe("MCP stdio contract", () => {
  it("completes a clean handshake and hides the proposal tool by default", async () => {
    const testClient = await startTestClient(false);
    try {
      const tools = await testClient.client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toEqual([
        "codex_worker_capabilities",
        "codex_worker_workspace",
        "codex_worker_sdd_route",
        "codex_worker_sdd_review",
        "codex_worker_analyze",
        "codex_worker_status",
        "codex_worker_result",
        "codex_worker_cancel",
        "codex_worker_list",
      ]);
      const annotations = Object.fromEntries(
        tools.tools.map((tool) => [tool.name, tool.annotations]),
      );
      expect(annotations).toMatchObject({
        codex_worker_capabilities: { openWorldHint: false },
        codex_worker_workspace: { openWorldHint: false },
        codex_worker_sdd_route: { openWorldHint: false },
        codex_worker_sdd_review: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: true,
        },
        codex_worker_analyze: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: true,
        },
        codex_worker_status: { openWorldHint: false },
        codex_worker_result: { openWorldHint: false },
        codex_worker_cancel: { openWorldHint: false },
        codex_worker_list: { openWorldHint: false },
      });

      const capabilities = await testClient.client.callTool({
        name: "codex_worker_capabilities",
        arguments: {},
      });
      expect(capabilities.isError).not.toBe(true);
      expect(capabilities.structuredContent).toMatchObject({
        compatible: true,
        authenticated: true,
        proposalsEnabled: false,
        transport: "stdio",
        routingPolicies: {
          legacy: { routingPolicyVersion: "sdd-routing-v2" },
          profiled: { routingPolicyVersion: "sdd-routing-v3" },
        },
      });
      const parsedText = JSON.parse(
        extractText(firstContent(capabilities)),
      ) as unknown;
      expect(parsedText).toEqual(capabilities.structuredContent);

      const invalid = await testClient.client.callTool({
        name: "codex_worker_analyze",
        arguments: { task: "" },
      });
      expect(invalid.isError).toBe(true);
      expect(extractText(firstContent(invalid))).toContain(
        "Input validation error",
      );

      const missing = await testClient.client.callTool({
        name: "codex_worker_result",
        arguments: { jobId: "00000000-0000-4000-8000-000000000000" },
      });
      expect(missing.isError).toBe(true);
      expect(missing.structuredContent).toMatchObject({
        error: { code: "JOB_NOT_FOUND" },
      });

      const submitted = await testClient.client.callTool({
        name: "codex_worker_analyze",
        arguments: {
          task: "Return one bounded read-only observation.",
          cwd: testClient.repository.root,
        },
      });
      expect(submitted.isError).not.toBe(true);
      expect(submitted.structuredContent).toMatchObject({ mode: "analyze" });
      const submittedSnapshot = asRecord(submitted.structuredContent);
      const submittedProgress = asRecord(submittedSnapshot.progress);
      expect(typeof submittedProgress.activity).toBe("string");
      expect(typeof submittedProgress.activityLabel).toBe("string");
      expect(typeof submittedProgress.updatedAt).toBe("string");
      expect(Number.isInteger(submittedProgress.elapsedMs)).toBe(true);
      expect(Number.isInteger(submittedProgress.sinceLastUpdateMs)).toBe(true);
      expect(typeof submittedSnapshot.id).toBe("string");

      const routed = await testClient.client.callTool({
        name: "codex_worker_sdd_route",
        arguments: {
          tasks: ["a", "b", "c"].map((id) => ({
            id,
            effortPoints: 1,
            risk: "medium",
            authority: "read-only",
            kind: "review",
          })),
        },
      });
      expect(routed.isError).not.toBe(true);
      expect(routed.structuredContent).toMatchObject({
        schemaVersion: 1,
        routingPolicyVersion: "sdd-routing-v2",
        fitPolicyVersion: "sdd-task-fit-v1",
        balance: {
          neutralCodexShareBps: 5_000,
          taskCount: { codex: 2, "claude-host": 1 },
        },
      });

      const projectProfile = createProjectProfileTemplate();
      const profiled = await testClient.client.callTool({
        name: "codex_worker_sdd_route",
        arguments: {
          tasks: [
            {
              id: "profiled-review",
              effortPoints: 2,
              risk: "medium",
              authority: "read-only",
              kind: "review",
            },
          ],
          projectProfile,
        },
      });
      expect(profiled.isError).not.toBe(true);
      expect(profiled.structuredContent).toMatchObject({
        schemaVersion: 2,
        routingPolicyVersion: "sdd-routing-v3",
        fitPolicyVersion: "sdd-capability-fit-v1",
        projectProfile: {
          profileId: projectProfile.profileId,
          profileVersion: projectProfile.profileVersion,
        },
        crossReviewPolicy: {
          source: "project-profile",
          purpose: "cross-review",
          model: null,
          reasoningEffort: null,
          serverAllowlistRequired: false,
        },
      });

      const refusedProfile = {
        ...projectProfile,
        codexPolicy: {
          ...projectProfile.codexPolicy,
          default: {
            model: "not-server-allowlisted",
            reasoningEffort: "high" as const,
          },
        },
      };
      const refused = await testClient.client.callTool({
        name: "codex_worker_sdd_route",
        arguments: {
          tasks: [
            {
              id: "refused-profile",
              effortPoints: 1,
              risk: "medium",
              authority: "read-only",
              kind: "review",
            },
          ],
          projectProfile: refusedProfile,
        },
      });
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toMatchObject({
        error: { code: "INVALID_REQUEST" },
      });

      const refusedCrossReviewProfile = {
        ...projectProfile,
        codexPolicy: {
          ...projectProfile.codexPolicy,
          byKind: {
            review: {
              model: "review-model-not-server-allowlisted",
              reasoningEffort: "high" as const,
            },
          },
        },
      };
      const refusedCrossReview = await testClient.client.callTool({
        name: "codex_worker_sdd_route",
        arguments: {
          tasks: [
            {
              id: "refused-cross-review-profile",
              effortPoints: 1,
              risk: "medium",
              authority: "read-only",
              kind: "implementation",
            },
          ],
          projectProfile: refusedCrossReviewProfile,
        },
      });
      expect(refusedCrossReview.isError).toBe(true);
      expect(refusedCrossReview.structuredContent).toMatchObject({
        error: { code: "INVALID_REQUEST" },
      });

      const listed = await testClient.client.callTool({
        name: "codex_worker_list",
        arguments: { limit: 1 },
      });
      const jobs = asRecord(listed.structuredContent).jobs;
      if (!Array.isArray(jobs)) {
        throw new TypeError(
          "Expected codex_worker_list to return a jobs array",
        );
      }
      const matchingJob = jobs
        .map((job) => asRecord(job))
        .find((job) => job.id === submittedSnapshot.id);
      expect(matchingJob).toBeDefined();
      expect(typeof asRecord(matchingJob?.progress).activityLabel).toBe(
        "string",
      );
    } finally {
      await testClient.close();
    }
  }, 20_000);

  it("returns a current strict dual-review artifact from the specialized review tool", async () => {
    const testClient = await startTestClient(false, "sdd-review-approved");
    try {
      const submitted = await testClient.client.callTool({
        name: "codex_worker_sdd_review",
        arguments: {
          phase: "plan",
          mode: "strict",
          cwd: testClient.repository.root,
          artifactPaths: ["README.md"],
          expectedRevision: testClient.repository.revision,
          hostReview: {
            reviewId: "claude-plan-review",
            verdict: "approved",
            summary: "The host review approves the frozen plan artifact.",
            findings: [],
          },
        },
      });
      expect(submitted.isError).not.toBe(true);
      expect(submitted.structuredContent).toMatchObject({
        mode: "analyze",
        expectedRevision: testClient.repository.revision,
        sddReview: { phase: "plan", mode: "strict" },
      });
      const jobId = asRecord(submitted.structuredContent).id;
      expect(jobId).toEqual(expect.any(String));
      await waitForMcpTerminal(testClient.client, String(jobId));

      const result = await testClient.client.callTool({
        name: "codex_worker_result",
        arguments: { jobId },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        ready: true,
        finalMessage: "The independently reviewed artifacts satisfy the gate.",
        review: {
          schemaVersion: 1,
          phase: "plan",
          hostEvidence: {
            reviewer: {
              lane: "claude-host",
              modelSource: "host-selected",
            },
          },
          codexEvidence: {
            execution: {
              fresh: true,
              sandbox: "read-only",
              approvalPolicy: "never",
              ephemeral: true,
            },
          },
          gate: { passed: true, status: "ready" },
        },
      });
    } finally {
      await testClient.close();
    }
  }, 20_000);

  it("marks a completed but blocked SDD review result as an MCP error while preserving the review", async () => {
    const testClient = await startTestClient(false, "sdd-review-approved");
    try {
      const submitted = await testClient.client.callTool({
        name: "codex_worker_sdd_review",
        arguments: {
          phase: "plan",
          mode: "strict",
          cwd: testClient.repository.root,
          artifactPaths: ["README.md"],
          expectedRevision: testClient.repository.revision,
          hostReview: {
            reviewId: "claude-plan-review-blocked",
            verdict: "changes-requested",
            summary: "The host review found a blocking plan defect.",
            findings: [
              {
                id: "host-plan-blocker",
                severity: "high",
                requirement: "The plan must satisfy the review contract.",
                summary: "The plan omits a required failure-path check.",
                artifactPath: "README.md",
                line: 1,
                nextAction: "Add and verify the missing failure-path check.",
              },
            ],
          },
        },
      });
      const jobId = String(asRecord(submitted.structuredContent).id);
      await waitForMcpTerminal(testClient.client, jobId);

      const result = await testClient.client.callTool({
        name: "codex_worker_result",
        arguments: { jobId },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        ready: true,
        job: { status: "completed" },
        finalMessage: "The independently reviewed artifacts satisfy the gate.",
        review: {
          gate: {
            passed: false,
            status: "blocked",
          },
        },
      });
      const review = asRecord(asRecord(result.structuredContent).review);
      const gate = asRecord(review.gate);
      const reasons = asStringArray(gate.reasons);
      expect(reasons).toContain("host-changes-requested");
    } finally {
      await testClient.close();
    }
  }, 20_000);

  it("marks an all-commands-failed terminal result as an MCP error while preserving the failure payload", async () => {
    const testClient = await startTestClient(
      false,
      "failed-command-outer-zero",
    );
    try {
      const submitted = await testClient.client.callTool({
        name: "codex_worker_analyze",
        arguments: {
          task: "Exercise the failed terminal result contract.",
          cwd: testClient.repository.root,
        },
      });
      const jobId = String(asRecord(submitted.structuredContent).id);
      await waitForMcpTerminal(testClient.client, jobId, "failed");

      const result = await testClient.client.callTool({
        name: "codex_worker_result",
        arguments: { jobId },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        ready: true,
        finalMessage: "All checks passed even though none ran successfully.",
        finalMessagePartial: true,
        job: {
          status: "failed",
          error: {
            code: "RUNTIME_FAILED",
            message: "Codex command execution failed",
          },
        },
      });
      expect(String(asRecord(result.structuredContent).notice)).toContain(
        "PARTIAL RESULT",
      );
    } finally {
      await testClient.close();
    }
  }, 20_000);

  it("advertises a resumable session for a persisted completed job", async () => {
    const testClient = await startTestClient(false);
    try {
      const submitted = await testClient.client.callTool({
        name: "codex_worker_analyze",
        arguments: {
          task: "Analyze with a resumable session.",
          cwd: testClient.repository.root,
          persistSession: true,
        },
      });
      const jobId = String(asRecord(submitted.structuredContent).id);
      await waitForMcpTerminal(testClient.client, jobId);

      const result = await testClient.client.callTool({
        name: "codex_worker_result",
        arguments: { jobId },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        ready: true,
        job: { sessionPersisted: true, sessionId: "thread-test" },
      });
      expect(String(asRecord(result.structuredContent).resumeHint)).toContain(
        "resumeSessionId",
      );
    } finally {
      await testClient.close();
    }
  }, 20_000);

  it("keeps nonterminal result retrieval successful but marks the cancelled terminal result as an MCP error", async () => {
    const testClient = await startTestClient(false, "cancel");
    try {
      const submitted = await testClient.client.callTool({
        name: "codex_worker_analyze",
        arguments: {
          task: "Exercise the cancelled terminal result contract.",
          cwd: testClient.repository.root,
        },
      });
      const jobId = String(asRecord(submitted.structuredContent).id);

      const pending = await testClient.client.callTool({
        name: "codex_worker_result",
        arguments: { jobId },
      });
      expect(pending.isError).not.toBe(true);
      expect(pending.structuredContent).toMatchObject({ ready: false });

      await testClient.client.callTool({
        name: "codex_worker_cancel",
        arguments: { jobId },
      });
      await waitForMcpTerminal(testClient.client, jobId, "cancelled");

      const result = await testClient.client.callTool({
        name: "codex_worker_result",
        arguments: { jobId },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        ready: true,
        job: {
          status: "cancelled",
          error: { code: "CANCELLED" },
        },
      });
    } finally {
      await testClient.close();
    }
  }, 20_000);

  it("returns proposal metadata first and patch text only on explicit request", async () => {
    const testClient = await startTestClient(true, "proposal");
    try {
      const tools = await testClient.client.listTools();
      const proposalTool = tools.tools.find(
        (tool) => tool.name === "codex_worker_propose",
      );
      expect(proposalTool).toBeDefined();
      expect(proposalTool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      });

      const submitted = await testClient.client.callTool({
        name: "codex_worker_propose",
        arguments: {
          task: "Propose the bounded fixture change.",
          cwd: testClient.repository.root,
          writePaths: ["src/allowed.ts"],
          expectedRevision: testClient.repository.revision,
        },
      });
      const jobId = asRecord(submitted.structuredContent).id;
      expect(jobId).toEqual(expect.any(String));
      await waitForMcpTerminal(testClient.client, String(jobId));

      const metadata = await testClient.client.callTool({
        name: "codex_worker_result",
        arguments: { jobId, includePatch: false },
      });
      expect(metadata.structuredContent).toMatchObject({
        ready: true,
        proposal: {
          effect: "proposal",
          patchAvailable: true,
          changedFiles: ["src/allowed.ts"],
        },
      });
      expect(
        asRecord(asRecord(metadata.structuredContent).proposal).patch,
      ).toBeUndefined();

      const withPatch = await testClient.client.callTool({
        name: "codex_worker_result",
        arguments: { jobId, includePatch: true },
      });
      expect(
        asRecord(asRecord(withPatch.structuredContent).proposal).patch,
      ).toEqual(expect.stringContaining("diff --git"));
    } finally {
      await testClient.close();
    }
  }, 20_000);

  it("rejects an empty cwd instead of silently using the server directory", async () => {
    const testClient = await startTestClient(false);
    try {
      const response = await testClient.client.callTool({
        name: "codex_worker_analyze",
        arguments: { task: "Review the fixture.", cwd: "" },
      });
      expect(response.isError).toBe(true);
    } finally {
      await testClient.close();
    }
  }, 20_000);

  it("keeps the stdio connection usable when a policy-valid patch is large", async () => {
    const testClient = await startTestClient(true, "proposal-large", {
      CCW_MAX_PATCH_BYTES: "20000000",
    });
    try {
      const submitted = await testClient.client.callTool({
        name: "codex_worker_propose",
        arguments: {
          task: "Propose the large bounded fixture change.",
          cwd: testClient.repository.root,
          writePaths: ["src/allowed.ts"],
          expectedRevision: testClient.repository.revision,
        },
      });
      const jobId = String(asRecord(submitted.structuredContent).id);
      await waitForMcpTerminal(testClient.client, jobId);

      // The worker accepted this patch under its own configured limit, so the
      // result must come back as a bounded answer instead of breaking stdio.
      const withPatch = await testClient.client.callTool({
        name: "codex_worker_result",
        arguments: { jobId, includePatch: true },
      });
      const structured = asRecord(withPatch.structuredContent);
      if (structured.error === undefined) {
        expect(asRecord(structured.proposal).patch).toEqual(
          expect.stringContaining("diff --git"),
        );
      } else {
        expect(asRecord(structured.error).code).toBe("OUTPUT_LIMIT_EXCEEDED");
      }

      // The connection must still serve the next call.
      const followUp = await testClient.client.callTool({
        name: "codex_worker_result",
        arguments: { jobId, includePatch: false },
      });
      expect(asRecord(followUp.structuredContent).ready).toBe(true);
    } finally {
      await testClient.close();
    }
  }, 60_000);

  it("does not expose unknown event payloads or unsafe session identifiers", async () => {
    const testClient = await startTestClient(false, "unsafe-event-type");
    try {
      const submitted = await testClient.client.callTool({
        name: "codex_worker_analyze",
        arguments: {
          task: "Return one bounded read-only observation.",
          cwd: testClient.repository.root,
        },
      });
      const jobId = asRecord(submitted.structuredContent).id;
      expect(jobId).toEqual(expect.any(String));
      await waitForMcpTerminal(testClient.client, String(jobId));

      const result = await testClient.client.callTool({
        name: "codex_worker_result",
        arguments: { jobId },
      });
      const serialized = JSON.stringify(result.structuredContent);
      expect(serialized).not.toContain("must-not-reach-status");
      expect(serialized).not.toContain("thread-unsafe");
      expect(
        asRecord(asRecord(result.structuredContent).job).sessionId,
      ).toBeUndefined();
    } finally {
      await testClient.close();
    }
  }, 20_000);
});

async function startTestClient(
  enableProposals: boolean,
  scenario?: string,
  extraEnvironment: Readonly<Record<string, string>> = {},
): Promise<TestClient> {
  const repository = await createTestRepository();
  const stateDirectory = await makeStateDirectory();
  const fakeCodex = resolve("tests/fixtures/fake-codex.mjs");
  if (process.platform !== "win32") {
    await chmod(fakeCodex, 0o755);
  }
  const path = [process.env.PATH, resolve("node_modules/.bin")]
    .filter((value): value is string => value !== undefined && value !== "")
    .join(delimiter);
  const environment = compactEnvironment({
    ...process.env,
    PATH: path,
    CCW_ALLOWED_ROOTS: repository.root,
    CCW_STATE_DIR: stateDirectory,
    CCW_CODEX_BIN: fakeCodex,
    CCW_ENABLE_PROPOSALS: String(enableProposals),
    ...(scenario === undefined
      ? {}
      : { CCW_FORWARD_ENV: "FAKE_CODEX_SCENARIO" }),
    ...(scenario === undefined ? {} : { FAKE_CODEX_SCENARIO: scenario }),
    ...extraEnvironment,
  });
  // `--import` accepts an ESM specifier. A raw Windows drive path is parsed as
  // a custom URL scheme (for example, `D:`), so always provide a file URL.
  const tsxLoader = pathToFileURL(
    resolve("node_modules/tsx/dist/loader.mjs"),
  ).href;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", tsxLoader, resolve("src/cli.ts"), "serve"],
    cwd: repository.root,
    env: environment,
    stderr: "pipe",
  });
  const client = new Client(
    { name: "boundedrelay-contract-test", version: "0.1.0" },
    { capabilities: {} },
  );
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  try {
    await client.connect(transport);
  } catch (error) {
    await repository.cleanup();
    await rm(stateDirectory, { recursive: true, force: true });
    throw new Error(`MCP test server failed: ${stderr.trim() || "no stderr"}`, {
      cause: error,
    });
  }

  return {
    client,
    transport,
    repository,
    stateDirectory,
    close: async () => {
      await client.close();
      await repository.cleanup();
      await rm(stateDirectory, { recursive: true, force: true });
    },
  };
}

async function waitForMcpTerminal(
  client: Client,
  jobId: string,
  expectedStatus = "completed",
): Promise<void> {
  let afterRevision: number | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await client.callTool({
      name: "codex_worker_status",
      arguments: {
        jobId,
        waitMs: 50,
        ...(afterRevision === undefined ? {} : { afterRevision }),
      },
    });
    const snapshot = asRecord(response.structuredContent);
    const status = snapshot.status;
    const revision = Number(snapshot.revision);
    expect(Number.isInteger(revision)).toBe(true);
    if (afterRevision !== undefined) {
      expect(revision).toBeGreaterThanOrEqual(afterRevision);
    }
    afterRevision = revision;
    if (["completed", "failed", "cancelled"].includes(String(status))) {
      expect(status).toBe(expectedStatus);
      return;
    }
  }
  throw new Error("MCP job did not reach a terminal state");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected an object in the MCP response");
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new TypeError("Expected an array of strings in the MCP response");
  }
  return value;
}

function extractText(value: unknown): string {
  const content = asRecord(value);
  if (content.type !== "text" || typeof content.text !== "string") {
    throw new TypeError("Expected MCP text content");
  }
  return content.text;
}

function firstContent(response: unknown): unknown {
  const content = asRecord(response).content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new TypeError("Expected MCP response content");
  }
  return content[0];
}

function compactEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
