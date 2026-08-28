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
  config: Pick<
    WorkerConfig,
    "codexExecutable" | "codexLauncherExecutable" | "codexLauncherArguments"
  >,
): CodexInvocation {
  const args: string[] = [
    ...(config.codexLauncherArguments ?? []),
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

  args.push("exec");
  if (request.resumeSessionId !== undefined) {
    args.push("resume", request.resumeSessionId);
  }
  args.push("--json");
  // A recorded session is what makes a later `exec resume` possible, so
  // ephemeral execution is dropped only when the caller opted into a
  // continuable thread.
  if (
    request.resumeSessionId === undefined &&
    request.persistSession !== true
  ) {
    args.push("--ephemeral");
  }
  args.push("--ignore-user-config", "--ignore-rules");
  // `exec resume` does not accept `--color`; passing it aborts the run.
  if (request.resumeSessionId === undefined) {
    args.push("--color", "never");
  }
  if (request.sddReview !== undefined) {
    args.push("--output-schema", SDD_REVIEW_OUTPUT_SCHEMA);
  }
  args.push("-");

  return {
    executable: config.codexLauncherExecutable ?? config.codexExecutable,
    args,
    cwd: request.executionRoot,
  };
}
