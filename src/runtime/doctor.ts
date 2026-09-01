import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { WorkerConfig } from "../config/worker-config.js";
import type { WorkerHealth } from "../core/types.js";
import { buildChildEnvironment } from "../security/environment-policy.js";
import { resolveExecutable } from "../security/executable-policy.js";
import { redactKnownValues } from "../security/redaction-policy.js";

interface ProbeResult {
  readonly ok: boolean;
  readonly output: string;
  readonly requiredTextPresent: boolean;
}

const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;

export async function collectWorkerHealth(
  config: WorkerConfig,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<WorkerHealth> {
  const childEnvironment = buildChildEnvironment(environment, config);
  const codexLauncher =
    config.codexLauncherExecutable ?? config.codexExecutable;
  const codexArguments = config.codexLauncherArguments ?? [];
  const probeCodex = async (
    args: readonly string[],
    requiredText: readonly string[] = [],
  ): Promise<ProbeResult> =>
    await runProbe(
      codexLauncher,
      [...codexArguments, ...args],
      childEnvironment,
      requiredText,
    );
  const [codexVersion, gitVersion, loginStatus, globalHelp, execHelp] =
    await Promise.all([
      probeCodex(["--version"]),
      runProbe(config.gitExecutable, ["--version"], childEnvironment),
      probeCodex(["login", "status"]),
      probeCodex(
        ["--help"],
        ["--strict-config", "--sandbox", "--ask-for-approval", "--cd"],
      ),
      probeCodex(
        ["exec", "--help"],
        [
          "--json",
          "--ephemeral",
          "--ignore-user-config",
          "--ignore-rules",
          "--color",
          "--output-schema",
        ],
      ),
    ]);
  const compatible =
    globalHelp.ok &&
    execHelp.ok &&
    globalHelp.requiredTextPresent &&
    execHelp.requiredTextPresent;
  const buildId = moduleBuildId();
  const bootstrapResolvable = await isBootstrapResolvable(
    config,
    childEnvironment,
  );
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
    // A bootstrap that cannot start fails every proposal at preparation time,
    // so surface it before the first delegated write instead of after.
    ...(bootstrapResolvable === false
      ? [
          "The configured proposal bootstrap command could not be resolved on PATH",
        ]
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
    ...(buildId === undefined ? {} : { buildId }),
    authenticated: loginStatus.ok,
    allowedRoots: config.allowedRoots,
    allowedModels: config.allowedModels,
    ...(config.defaultModel === undefined
      ? {}
      : { defaultModel: config.defaultModel }),
    ...(config.defaultReasoningEffort === undefined
      ? {}
      : { defaultReasoningEffort: config.defaultReasoningEffort }),
    proposalsEnabled: config.enableProposals,
    proposalBootstrapConfigured: config.proposalBootstrap !== undefined,
    maxConcurrent: config.maxConcurrent,
    maxQueued: config.maxQueued,
    authEnvironmentForwarding: config.forwardAuthEnvironment,
    warnings,
  };
}

/**
 * Modification time of the running worker module, as a stable build
 * fingerprint. It answers "is this process older than my last build?", which
 * the frozen package version cannot.
 */
function moduleBuildId(): string | undefined {
  try {
    return statSync(fileURLToPath(import.meta.url)).mtime.toISOString();
  } catch {
    return undefined;
  }
}

/**
 * Confirms the operator's bootstrap executable can actually start. It runs no
 * bootstrap: an unresolvable command would otherwise fail every proposal only
 * at preparation time.
 */
async function isBootstrapResolvable(
  config: WorkerConfig,
  childEnvironment: NodeJS.ProcessEnv,
): Promise<boolean | undefined> {
  const executable = config.proposalBootstrap?.[0];
  if (executable === undefined) {
    return undefined;
  }
  try {
    await resolveExecutable(
      executable,
      childEnvironment.PATH,
      "proposal bootstrap command",
    );
    return true;
  } catch {
    return false;
  }
}

async function runProbe(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  requiredText: readonly string[] = [],
): Promise<ProbeResult> {
  return await new Promise<ProbeResult>((resolvePromise) => {
    execFile(
      executable,
      [...args],
      {
        encoding: "utf8",
        env: environment,
        maxBuffer: MAX_PROBE_OUTPUT_BYTES,
        timeout: 10_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        // Decide capability support before redaction: an explicitly forwarded
        // value can legitimately equal a required flag. Only this boolean and
        // the separately sanitized diagnostic leave the probe boundary.
        const boundedRawOutput = (stdout || stderr).slice(
          0,
          MAX_PROBE_OUTPUT_BYTES,
        );
        const output = sanitizeProbeOutput(
          boundedRawOutput,
          Object.values(environment),
        );
        resolvePromise({
          ok: error === null,
          output,
          requiredTextPresent: requiredText.every((value) =>
            boundedRawOutput.includes(value),
          ),
        });
      },
    );
  });
}

function sanitizeProbeOutput(
  value: string,
  knownEnvironmentValues: readonly (string | undefined)[],
): string {
  return redactKnownValues(value, knownEnvironmentValues)
    .replaceAll(/\p{Cc}+/gu, " ")
    .trim()
    .slice(0, 64 * 1024);
}

function summarizeProbeOutput(value: string): string {
  return value.slice(0, 256);
}
