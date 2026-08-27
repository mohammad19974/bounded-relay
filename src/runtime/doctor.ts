import { execFile } from "node:child_process";

import type { WorkerConfig } from "../config/worker-config.js";
import type { WorkerHealth } from "../core/types.js";
import { buildChildEnvironment } from "../security/environment-policy.js";

interface ProbeResult {
  readonly ok: boolean;
  readonly output: string;
}

export async function collectWorkerHealth(
  config: WorkerConfig,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<WorkerHealth> {
  const childEnvironment = buildChildEnvironment(environment, config);
  const [codexVersion, gitVersion, loginStatus, globalHelp, execHelp] =
    await Promise.all([
      runProbe(config.codexExecutable, ["--version"], childEnvironment),
      runProbe(config.gitExecutable, ["--version"], childEnvironment),
      runProbe(config.codexExecutable, ["login", "status"], childEnvironment),
      runProbe(config.codexExecutable, ["--help"], childEnvironment),
      runProbe(config.codexExecutable, ["exec", "--help"], childEnvironment),
    ]);
  const compatible =
    globalHelp.ok &&
    execHelp.ok &&
    ["--strict-config", "--sandbox", "--ask-for-approval", "--cd"].every(
      (flag) => globalHelp.output.includes(flag),
    ) &&
    [
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--color",
    ].every((flag) => execHelp.output.includes(flag));
  const warnings = [
    ...(!loginStatus.ok
      ? [
          "Codex authentication is not ready; run `codex login` outside the worker",
        ]
      : []),
    ...(config.enableProposals
      ? [
          "Proposal mode is enabled; only validated patches are returned and never applied",
        ]
      : []),
    ...(config.forwardAuthEnvironment
      ? ["Explicit authentication environment forwarding is enabled"]
      : []),
    ...(!compatible
      ? ["This Codex CLI does not advertise every flag required by the worker"]
      : []),
  ];

  return {
    ok: codexVersion.ok && gitVersion.ok && loginStatus.ok && compatible,
    version: config.version,
    codexExecutable: config.codexExecutable,
    gitExecutable: config.gitExecutable,
    ...(codexVersion.output === ""
      ? {}
      : { codexVersion: summarizeProbeOutput(codexVersion.output) }),
    ...(gitVersion.output === ""
      ? {}
      : { gitVersion: summarizeProbeOutput(gitVersion.output) }),
    compatible,
    authenticated: loginStatus.ok,
    allowedRoots: config.allowedRoots,
    allowedModels: config.allowedModels,
    proposalsEnabled: config.enableProposals,
    maxConcurrent: config.maxConcurrent,
    maxQueued: config.maxQueued,
    authEnvironmentForwarding: config.forwardAuthEnvironment,
    warnings,
  };
}

async function runProbe(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<ProbeResult> {
  return await new Promise<ProbeResult>((resolvePromise) => {
    execFile(
      executable,
      [...args],
      {
        encoding: "utf8",
        env: environment,
        maxBuffer: 64 * 1024,
        timeout: 10_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const output = sanitizeProbeOutput(stdout || stderr);
        resolvePromise({ ok: error === null, output });
      },
    );
  });
}

function sanitizeProbeOutput(value: string): string {
  return value
    .replaceAll(/\p{Cc}+/gu, " ")
    .trim()
    .slice(0, 64 * 1024);
}

function summarizeProbeOutput(value: string): string {
  return value.slice(0, 256);
}
