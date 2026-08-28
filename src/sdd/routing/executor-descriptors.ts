import type { RoutingLane } from "./types.js";

export interface SddExecutorDescriptor {
  readonly id: "claude-host" | "codex-worker";
  readonly lane: RoutingLane;
  readonly role: "host-orchestrator" | "bounded-worker";
  readonly adapter: "claude-code" | "codex-exec-jsonl";
  readonly transport: "host-managed" | "boundedrelay-mcp-stdio";
  readonly modelSource: "host-selected" | "server-allowlisted";
  readonly launchedByWorker: boolean;
}

/**
 * These descriptors document the supported v0.1 topology. They are output
 * evidence, not project-configurable adapters.
 */
export const SDD_EXECUTOR_DESCRIPTORS: readonly SddExecutorDescriptor[] = [
  {
    id: "claude-host",
    lane: "claude-host",
    role: "host-orchestrator",
    adapter: "claude-code",
    transport: "host-managed",
    modelSource: "host-selected",
    launchedByWorker: false,
  },
  {
    id: "codex-worker",
    lane: "codex",
    role: "bounded-worker",
    adapter: "codex-exec-jsonl",
    transport: "boundedrelay-mcp-stdio",
    modelSource: "server-allowlisted",
    launchedByWorker: true,
  },
] as const;

export function executorIdForLane(
  lane: RoutingLane,
): SddExecutorDescriptor["id"] {
  return lane === "codex" ? "codex-worker" : "claude-host";
}
