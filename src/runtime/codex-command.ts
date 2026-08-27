import type { WorkerConfig } from "../config/worker-config.js";
import type { ResolvedJobRequest } from "../core/types.js";
import { fileURLToPath } from "node:url";

const SDD_REVIEW_OUTPUT_SCHEMA = fileURLToPath(
  new URL(
    "../../schemas/sdd/v1/codex-review-output.schema.json",
    import.meta.url,
  ),
);

export interface CodexInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export function buildCodexInvocation(
  request: ResolvedJobRequest,
  config: Pick<WorkerConfig, "codexExecutable">,
): CodexInvocation {
  const args: string[] = [
    "--strict-config",
    "--sandbox",
    request.mode === "analyze" ? "read-only" : "workspace-write",
    "--ask-for-approval",
    "never",
    "--cd",
    request.executionRoot,
  ];

  if (request.model !== undefined) {
    args.push("--model", request.model);
  }
  if (request.reasoningEffort !== undefined) {
    args.push(
      "--config",
      `model_reasoning_effort=${JSON.stringify(request.reasoningEffort)}`,
    );
  }

  args.push(
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--color",
    "never",
  );
  if (request.sddReview !== undefined) {
    args.push("--output-schema", SDD_REVIEW_OUTPUT_SCHEMA);
  }
  args.push("-");

  return {
    executable: config.codexExecutable,
    args,
    cwd: request.executionRoot,
  };
}
