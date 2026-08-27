import type { WorkerConfig } from "../config/worker-config.js";

const BASE_ENVIRONMENT = [
  "CODEX_HOME",
  "COLORTERM",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
] as const;

const AUTH_ENVIRONMENT = [
  "CODEX_ACCESS_TOKEN",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
] as const;

const AUTH_ENVIRONMENT_SET = new Set<string>(AUTH_ENVIRONMENT);

export function buildChildEnvironment(
  source: NodeJS.ProcessEnv,
  config: Pick<WorkerConfig, "forwardAuthEnvironment" | "forwardEnvironment">,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const names = new Set<string>([
    ...BASE_ENVIRONMENT,
    ...config.forwardEnvironment,
  ]);

  if (config.forwardAuthEnvironment) {
    for (const name of AUTH_ENVIRONMENT) {
      names.add(name);
    }
  }

  for (const name of names) {
    if (AUTH_ENVIRONMENT_SET.has(name) && !config.forwardAuthEnvironment) {
      continue;
    }
    const value = source[name];
    if (value !== undefined) {
      result[name] = value;
    }
  }

  return result;
}
