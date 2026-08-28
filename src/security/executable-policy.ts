import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  resolve,
} from "node:path";

import type { WorkerConfig } from "../config/worker-config.js";
import { ERROR_CODES, WorkerError } from "../core/errors.js";

export interface ExecutableLauncher {
  readonly executable: string;
  readonly arguments: readonly string[];
}

const WINDOWS_NODE_SCRIPT_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);
const WINDOWS_SHELL_SCRIPT_EXTENSIONS = new Set([".bat", ".cmd", ".ps1"]);

async function verifyExecutable(
  candidate: string,
  label: string,
): Promise<string> {
  try {
    const canonical = await realpath(candidate);
    const metadata = await stat(canonical);
    if (!metadata.isFile()) {
      throw new Error("not a regular file");
    }
    await access(canonical, constants.X_OK);
    return canonical;
  } catch {
    throw new WorkerError(
      label === "Codex"
        ? ERROR_CODES.CODEX_NOT_FOUND
        : ERROR_CODES.CONFIG_INVALID,
      `${label} executable is unavailable or not executable`,
    );
  }
}

export async function resolveExecutable(
  configured: string,
  pathValue: string | undefined,
  label: string,
  pathExtensions: string | undefined = process.env.PATHEXT,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if (
    isAbsolute(configured) ||
    configured.includes("/") ||
    configured.includes("\\")
  ) {
    return await verifyExecutable(resolve(configured), label);
  }

  for (const directory of (pathValue ?? "").split(delimiter)) {
    if (directory.trim() === "") {
      continue;
    }
    for (const executableName of candidateExecutableNames(
      configured,
      pathExtensions,
      platform,
    )) {
      try {
        return await verifyExecutable(
          resolve(directory, executableName),
          label,
        );
      } catch {
        // Keep searching PATH. The final failure is intentionally generic.
      }
    }
  }

  throw new WorkerError(
    label === "Codex"
      ? ERROR_CODES.CODEX_NOT_FOUND
      : ERROR_CODES.CONFIG_INVALID,
    `${label} executable was not found on PATH`,
  );
}

function candidateExecutableNames(
  configured: string,
  pathExtensions: string | undefined,
  platform: NodeJS.Platform,
): readonly string[] {
  if (platform !== "win32" || extname(configured) !== "") {
    return [configured];
  }
  const extensions = [
    ...new Set(
      (pathExtensions ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((extension) => extension.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].sort(
    (left, right) => windowsExtensionRank(left) - windowsExtensionRank(right),
  );
  return extensions.map((extension) => `${configured}${extension}`);
}

function windowsExtensionRank(extension: string): number {
  if (extension === ".com" || extension === ".exe") {
    return 0;
  }
  if (extension === ".cmd" || extension === ".bat") {
    return 1;
  }
  return 2;
}

async function canonicalRegularFile(path: string): Promise<string | undefined> {
  try {
    const canonical = await realpath(path);
    return (await stat(canonical)).isFile() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

async function resolveNpmCodexEntrypoint(
  commandPath: string,
): Promise<string | undefined> {
  if (basename(commandPath).toLowerCase() !== "codex.cmd") {
    return undefined;
  }

  const commandDirectory = dirname(commandPath);
  const candidates = [
    resolve(commandDirectory, "node_modules/@openai/codex/bin/codex.js"),
    resolve(commandDirectory, "../@openai/codex/bin/codex.js"),
  ];
  for (const candidate of candidates) {
    const canonical = await canonicalRegularFile(candidate);
    if (canonical !== undefined) {
      return canonical;
    }
  }
  return undefined;
}

export async function resolveCodexLauncher(
  codexExecutable: string,
  platform: NodeJS.Platform = process.platform,
): Promise<ExecutableLauncher> {
  if (platform !== "win32") {
    return { executable: codexExecutable, arguments: [] };
  }

  const extension = extname(codexExecutable).toLowerCase();
  if (WINDOWS_NODE_SCRIPT_EXTENSIONS.has(extension)) {
    return {
      executable: process.execPath,
      arguments: [codexExecutable],
    };
  }
  if (extension === ".cmd") {
    const entrypoint = await resolveNpmCodexEntrypoint(codexExecutable);
    if (entrypoint !== undefined) {
      return { executable: process.execPath, arguments: [entrypoint] };
    }
  }
  if (extension === ".exe" || extension === ".com") {
    return { executable: codexExecutable, arguments: [] };
  }

  const unsupported =
    WINDOWS_SHELL_SCRIPT_EXTENSIONS.has(extension) || extension === "";
  throw new WorkerError(
    ERROR_CODES.CODEX_NOT_FOUND,
    unsupported
      ? "Codex resolved to a Windows shell shim that cannot be launched safely; install the official standalone Codex CLI or set CCW_CODEX_BIN to codex.exe"
      : `Codex resolved to an unsupported Windows executable type: ${extension}`,
  );
}

function assertWindowsNativeExecutable(
  executable: string,
  label: string,
  platform: NodeJS.Platform,
): void {
  if (platform !== "win32") {
    return;
  }
  const extension = extname(executable).toLowerCase();
  if (extension !== ".exe" && extension !== ".com") {
    throw new WorkerError(
      ERROR_CODES.CONFIG_INVALID,
      `${label} must resolve to a native .exe or .com file on Windows`,
    );
  }
}

export async function resolveWorkerExecutables(
  config: WorkerConfig,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<WorkerConfig> {
  const [codexExecutable, gitExecutable] = await Promise.all([
    resolveExecutable(
      config.codexExecutable,
      environment.PATH,
      "Codex",
      environment.PATHEXT,
    ),
    resolveExecutable(
      config.gitExecutable,
      environment.PATH,
      "Git",
      environment.PATHEXT,
    ),
  ]);

  const codexLauncher = await resolveCodexLauncher(codexExecutable);
  assertWindowsNativeExecutable(gitExecutable, "Git", process.platform);

  return {
    ...config,
    codexExecutable,
    codexLauncherExecutable: codexLauncher.executable,
    codexLauncherArguments: codexLauncher.arguments,
    gitExecutable,
  };
}
