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

const WINDOWS_BASE_ENVIRONMENT = [
  "COMSPEC",
  "PATHEXT",
  "SYSTEMROOT",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
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
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const names = new Set<string>();
  const addName = (name: string): void => {
    names.add(normalizeEnvironmentName(name, platform));
  };

  for (const name of BASE_ENVIRONMENT) {
    addName(name);
  }
  if (platform === "win32") {
    for (const name of WINDOWS_BASE_ENVIRONMENT) {
      addName(name);
    }
  }
  for (const name of config.forwardEnvironment) {
    addName(name);
  }

  if (config.forwardAuthEnvironment) {
    for (const name of AUTH_ENVIRONMENT) {
      addName(name);
    }
  }

  for (const name of names) {
    if (AUTH_ENVIRONMENT_SET.has(name) && !config.forwardAuthEnvironment) {
      continue;
    }
    const value = readEnvironmentValue(source, name, platform);
    if (value !== undefined) {
      result[name] = value;
    }
  }

  return result;
}

function normalizeEnvironmentName(
  name: string,
  platform: NodeJS.Platform,
): string {
  return platform === "win32" ? name.toUpperCase() : name;
}

function readEnvironmentValue(
  source: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  const exactValue = source[name];
  if (exactValue !== undefined || platform !== "win32") {
    return exactValue;
  }

  const normalizedName = name.toUpperCase();
  for (const [candidateName, value] of Object.entries(source)) {
    if (candidateName.toUpperCase() === normalizedName && value !== undefined) {
      return value;
    }
  }
  return undefined;
}
