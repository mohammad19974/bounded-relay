import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import type { JobResult } from "../core/types.js";
import { JOB_STATUSES, REASONING_EFFORTS } from "../core/types.js";
import { toWorkerError } from "../core/errors.js";
import type { WorkerApplication } from "../worker-application.js";

export interface RunningMcpServer {
  close(): Promise<void>;
}

export async function startMcpServer(
  application: WorkerApplication,
): Promise<RunningMcpServer> {
  const server = new McpServer({
    name: "boundedrelay",
    version: application.config.version,
  });
  const commonJobShape = {
    task: z
      .string()
      .min(1)
      .max(application.config.maxTaskChars)
      .describe("Bounded objective for the Codex worker"),
    cwd: z
      .string()
      .max(4_096)
      .optional()
      .describe("Existing directory inside a configured allowed root"),
    model: z
      .string()
      .max(128)
      .optional()
      .describe("Optional model from the server-owned CCW_ALLOWED_MODELS list"),
    reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(application.config.maxTimeoutMs)
      .optional(),
    idempotencyKey: z.string().min(1).max(128).optional(),
  };

  server.registerTool(
    "codex_worker_capabilities",
    {
      title: "Codex worker capabilities",
      description:
        "Inspect effective policy, dependency health, and the tools exposed by this local worker.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      await safeResult(async () => {
        const health = await application.health();
        return {
          ...health,
          transport: "stdio",
          persistence: "process-lifetime memory only",
          proposalSemantics:
            "isolated clone -> validated patch -> caller review; never auto-applied",
          tools: [
            "codex_worker_capabilities",
            "codex_worker_workspace",
            "codex_worker_analyze",
            ...(application.config.enableProposals
              ? ["codex_worker_propose"]
              : []),
            "codex_worker_status",
            "codex_worker_result",
            "codex_worker_cancel",
            "codex_worker_list",
          ],
        };
      }),
  );

  server.registerTool(
    "codex_worker_workspace",
    {
      title: "Inspect a workspace",
      description:
        "Resolve the repository, revision, clean state, and proposal readiness without changing it.",
      inputSchema: {
        cwd: z.string().max(4_096).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ cwd }) =>
      await safeResult(async () => await application.workspaces.inspect(cwd)),
  );

  server.registerTool(
    "codex_worker_analyze",
    {
      title: "Start a read-only Codex analysis",
      description:
        "Queue a bounded, read-only Codex job and return immediately with its job ID.",
      inputSchema: commonJobShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      await safeResult(async () =>
        application.jobs.submit({
          task: input.task,
          mode: "analyze",
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: input.reasoningEffort }),
          ...(input.timeoutMs === undefined
            ? {}
            : { timeoutMs: input.timeoutMs }),
          ...(input.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: input.idempotencyKey }),
        }),
      ),
  );

  if (application.config.enableProposals) {
    server.registerTool(
      "codex_worker_propose",
      {
        title: "Start an isolated Codex patch proposal",
        description:
          "Run Codex in a disposable clone and return a validated patch. The source checkout is never modified.",
        inputSchema: {
          ...commonJobShape,
          writePaths: z
            .array(z.string().min(1).max(4_096))
            .min(1)
            .max(application.config.maxChangedFiles),
          expectedRevision: z
            .string()
            .regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (input) =>
        await safeResult(async () =>
          application.jobs.submit({
            task: input.task,
            mode: "proposal",
            writePaths: input.writePaths,
            expectedRevision: input.expectedRevision,
            ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(input.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: input.reasoningEffort }),
            ...(input.timeoutMs === undefined
              ? {}
              : { timeoutMs: input.timeoutMs }),
            ...(input.idempotencyKey === undefined
              ? {}
              : { idempotencyKey: input.idempotencyKey }),
          }),
        ),
    );
  }

  server.registerTool(
    "codex_worker_status",
    {
      title: "Get Codex job status",
      description:
        "Return sanitized live activity, timing, real event counters, and lifecycle state; optionally wait for a newer revision.",
      inputSchema: {
        jobId: z.uuid(),
        waitMs: z.number().int().min(0).max(30_000).optional(),
        afterRevision: z.number().int().min(1).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ jobId, waitMs, afterRevision }) =>
      await safeResult(
        async () =>
          await application.jobs.status(jobId, waitMs ?? 0, afterRevision),
      ),
  );

  server.registerTool(
    "codex_worker_result",
    {
      title: "Get a Codex job result",
      description:
        "Return the terminal result. Proposal patch content is omitted unless includePatch is true.",
      inputSchema: {
        jobId: z.uuid(),
        includePatch: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ jobId, includePatch }) =>
      await safeResult(async () =>
        presentJobResult(application.jobs.result(jobId), includePatch),
      ),
  );

  server.registerTool(
    "codex_worker_cancel",
    {
      title: "Cancel a Codex job",
      description:
        "Cancel a queued or running job and terminate its child process tree.",
      inputSchema: { jobId: z.uuid() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ jobId }) =>
      await safeResult(async () => await application.jobs.cancel(jobId)),
  );

  server.registerTool(
    "codex_worker_list",
    {
      title: "List Codex jobs",
      description:
        "List bounded in-memory job metadata for this server process.",
      inputSchema: {
        status: z.enum(JOB_STATUSES).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      await safeResult(async () => ({
        jobs: application.jobs.list({
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        }),
      })),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  return {
    close: async () => {
      await server.close();
    },
  };
}

function presentJobResult(result: JobResult, includePatch: boolean): unknown {
  if (result.proposal === undefined) {
    return result;
  }
  const { patch, ...metadata } = result.proposal;
  return {
    ...result,
    proposal: {
      ...metadata,
      patchAvailable: patch !== undefined,
      ...(includePatch && patch !== undefined ? { patch } : {}),
    },
  };
}

interface ToolCallResult {
  readonly [key: string]: unknown;
  readonly content: { readonly type: "text"; readonly text: string }[];
  readonly structuredContent: Record<string, unknown>;
  readonly isError?: true;
}

async function safeResult(action: () => unknown): Promise<ToolCallResult> {
  try {
    return makeToolResult(await action(), false);
  } catch (error) {
    const workerError = toWorkerError(error);
    return makeToolResult(
      { error: { code: workerError.code, message: workerError.message } },
      true,
    );
  }
}

function makeToolResult(value: unknown, isError: boolean): ToolCallResult {
  const normalized = JSON.parse(JSON.stringify(value)) as unknown;
  const structuredContent = isRecord(normalized)
    ? normalized
    : { value: normalized };
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
