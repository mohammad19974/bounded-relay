import { chmod, rm } from "node:fs/promises";
import { delimiter, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

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

  it("returns proposal metadata first and patch text only on explicit request", async () => {
    const testClient = await startTestClient(true, "proposal");
    try {
      const tools = await testClient.client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain(
        "codex_worker_propose",
      );

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
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      resolve("node_modules/tsx/dist/loader.mjs"),
      resolve("src/cli.ts"),
      "serve",
    ],
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
      expect(status).toBe("completed");
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
