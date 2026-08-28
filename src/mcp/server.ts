import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import type { JobResult } from "../core/types.js";
import { JOB_STATUSES, REASONING_EFFORTS } from "../core/types.js";
import { ERROR_CODES, WorkerError, toWorkerError } from "../core/errors.js";
import type { WorkerApplication } from "../worker-application.js";
import {
  SDD_CAPABILITY_FIT_POLICY_VERSION,
  SDD_FIT_POLICY_VERSION,
  SDD_PROFILED_ROUTING_POLICY_VERSION,
  SDD_ROUTING_POLICY_VERSION,
  SddRoutingError,
  routeProfiledSddTasks,
  routeSddTasks,
  type ProfiledSddRoutingPlan,
  type SddProjectProfileInput,
} from "../sdd/routing/index.js";
import { REVIEW_PHASES } from "../sdd/review/index.js";
import {
  profiledRoutingTaskSchema,
  projectProfileSchema,
} from "./project-profile-schema.js";

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
  const runtimeJobShape = {
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
  const commonJobShape = {
    task: z
      .string()
      .min(1)
      .max(application.config.maxTaskChars)
      .describe("Bounded objective for the Codex worker"),
    ...runtimeJobShape,
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
          routingPolicies: {
            legacy: {
              routingPolicyVersion: SDD_ROUTING_POLICY_VERSION,
              fitPolicyVersion: SDD_FIT_POLICY_VERSION,
            },
            profiled: {
              routingPolicyVersion: SDD_PROFILED_ROUTING_POLICY_VERSION,
              fitPolicyVersion: SDD_CAPABILITY_FIT_POLICY_VERSION,
              projectProfileSchemaVersion: 1,
              modelPolicy: "Codex only; server allowlist required",
            },
          },
          proposalSemantics:
            "isolated clone -> validated patch -> caller review; never auto-applied",
          tools: [
            "codex_worker_capabilities",
            "codex_worker_workspace",
            "codex_worker_sdd_route",
            "codex_worker_sdd_review",
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
    "codex_worker_sdd_route",
    {
      title: "Route approved SDD tasks",
      description:
        "Deterministically route a bounded task DAG. Without projectProfile it preserves legacy task-kind fit; with a strict profile it uses capability fit, narrower write policy, required check digests, and Codex-only model policy. No model is called and no file is changed.",
      inputSchema: {
        tasks: z.array(profiledRoutingTaskSchema).min(1).max(64),
        neutralCodexShareBps: z.number().int().min(0).max(10_000).optional(),
        projectProfile: projectProfileSchema.optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      await safeResult(async () => {
        try {
          const request = {
            tasks: input.tasks.map((task) => ({
              id: task.id,
              effortPoints: task.effortPoints,
              risk: task.risk,
              authority: task.authority,
              kind: task.kind,
              ...(task.dependencies === undefined
                ? {}
                : { dependencies: task.dependencies }),
              ...(task.writeScopes === undefined
                ? {}
                : { writeScopes: task.writeScopes }),
              ...(task.eligibleLanes === undefined
                ? {}
                : { eligibleLanes: task.eligibleLanes }),
              ...(task.preferredLane === undefined
                ? {}
                : { preferredLane: task.preferredLane }),
            })),
            ...(input.neutralCodexShareBps === undefined
              ? {}
              : { neutralCodexShareBps: input.neutralCodexShareBps }),
          };
          if (input.projectProfile === undefined) {
            return routeSddTasks(request);
          }
          const plan = routeProfiledSddTasks({
            ...request,
            projectProfile: input.projectProfile as SddProjectProfileInput,
          });
          assertProfiledModelsAllowed(plan, application.config.allowedModels);
          return plan;
        } catch (error) {
          if (error instanceof SddRoutingError) {
            throw new WorkerError(ERROR_CODES.INVALID_REQUEST, error.message);
          }
          throw error;
        }
      }),
  );

  server.registerTool(
    "codex_worker_sdd_review",
    {
      title: "Start an independent structured SDD review",
      description:
        "Freeze Claude host evidence, seal exact artifacts, and queue a fresh read-only schema-constrained Codex review. Only a current strict dual approval satisfies its gate.",
      inputSchema: {
        phase: z.enum(REVIEW_PHASES),
        mode: z.enum(["strict", "draft"]),
        artifactPaths: z.array(z.string().min(1).max(4_096)).min(1).max(64),
        expectedRevision: z
          .string()
          .regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/)
          .optional(),
        baseRevision: z
          .string()
          .regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/)
          .optional(),
        hostReview: z
          .object({
            reviewId: z.string().min(1).max(128),
            verdict: z.enum(["approved", "changes-requested"]),
            summary: z.string().min(1).max(8_000),
            findings: z
              .array(
                z
                  .object({
                    id: z.string().min(1).max(128),
                    severity: z.enum(["low", "medium", "high", "critical"]),
                    requirement: z.string().min(1).max(512),
                    summary: z.string().min(1).max(2_000),
                    artifactPath: z.string().min(1).max(4_096),
                    line: z.number().int().min(1).max(10_000_000).optional(),
                    nextAction: z.string().min(1).max(2_000),
                  })
                  .strict(),
              )
              .max(100),
            declaredModelLabel: z.string().min(1).max(128).optional(),
          })
          .strict(),
        focus: z.string().min(1).max(4_000).optional(),
        ...runtimeJobShape,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) =>
      await safeResult(
        async () =>
          await application.jobs.submitReview({
            phase: input.phase,
            mode: input.mode,
            artifactPaths: input.artifactPaths,
            hostReview: {
              reviewId: input.hostReview.reviewId,
              verdict: input.hostReview.verdict,
              summary: input.hostReview.summary,
              findings: input.hostReview.findings.map((finding) => ({
                id: finding.id,
                severity: finding.severity,
                requirement: finding.requirement,
                summary: finding.summary,
                artifactPath: finding.artifactPath,
                ...(finding.line === undefined ? {} : { line: finding.line }),
                nextAction: finding.nextAction,
              })),
              ...(input.hostReview.declaredModelLabel === undefined
                ? {}
                : {
                    declaredModelLabel: input.hostReview.declaredModelLabel,
                  }),
            },
            ...(input.expectedRevision === undefined
              ? {}
              : { expectedRevision: input.expectedRevision }),
            ...(input.baseRevision === undefined
              ? {}
              : { baseRevision: input.baseRevision }),
            ...(input.focus === undefined ? {} : { focus: input.focus }),
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
        openWorldHint: true,
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
          openWorldHint: true,
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

function assertProfiledModelsAllowed(
  plan: ProfiledSddRoutingPlan,
  allowedModels: readonly string[],
): void {
  const allowed = new Set(allowedModels);
  const requested = [
    ...new Set(
      [
        plan.crossReviewPolicy.model,
        ...plan.assignments.map((assignment) => assignment.codexPolicy.model),
      ].filter((model): model is string => model !== null),
    ),
  ];
  const refused = requested.find((model) => !allowed.has(model));
  if (refused !== undefined) {
    throw new WorkerError(
      ERROR_CODES.INVALID_REQUEST,
      `Project profile Codex model is not server-allowlisted: ${refused}`,
    );
  }
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
