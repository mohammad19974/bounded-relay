import type { WorkerConfig } from "./config/worker-config.js";
import { loadWorkerConfig } from "./config/worker-config.js";
import { JobManager } from "./core/job-manager.js";
import type { WorkerHealth } from "./core/types.js";
import { LeaseManager } from "./core/lease-manager.js";
import { collectWorkerHealth } from "./runtime/doctor.js";
import { CodexRuntime } from "./runtime/codex-runtime.js";
import { GitClient } from "./runtime/git-client.js";
import { ProposalWorkspace } from "./runtime/proposal-workspace.js";
import { ReviewWorkspace } from "./runtime/review-workspace.js";
import { WorkspaceInspector } from "./runtime/workspace-inspector.js";
import { resolveWorkerExecutables } from "./security/executable-policy.js";
import { initializeSecurityPolicy } from "./security/state-policy.js";
import { SddReviewService } from "./sdd/review-job.js";

export interface WorkerApplication {
  readonly config: WorkerConfig;
  readonly jobs: JobManager;
  readonly workspaces: WorkspaceInspector;
  health(): Promise<WorkerHealth>;
}

export async function createWorkerApplication(
  options: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly processDirectory?: string;
  } = {},
): Promise<WorkerApplication> {
  const environment = options.environment ?? process.env;
  const configured = loadWorkerConfig(
    environment,
    options.processDirectory ?? process.cwd(),
  );
  const secured = await initializeSecurityPolicy(configured);
  const config = await resolveWorkerExecutables(secured, environment);
  const git = new GitClient(config, environment);
  const proposalWorkspace = new ProposalWorkspace(config, git);
  const reviewWorkspace = new ReviewWorkspace(config, git);
  const leases = new LeaseManager(config.stateDirectory);
  const runtime = new CodexRuntime(config, environment);
  const reviews = new SddReviewService(config, git);
  const jobs = new JobManager({
    config,
    runtime,
    proposalWorkspace,
    reviewWorkspace,
    leases,
    reviews,
  });
  await jobs.initialize();

  // Each health collection spawns several probe subprocesses. Concurrent
  // callers share one round so repeated capability calls cannot multiply them.
  let inFlightHealth: Promise<WorkerHealth> | undefined;

  return {
    config,
    jobs,
    workspaces: new WorkspaceInspector(config, git),
    health: async () => {
      inFlightHealth ??= collectWorkerHealth(config, environment).finally(
        () => {
          inFlightHealth = undefined;
        },
      );
      return await inFlightHealth;
    },
  };
}
