import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, extname, isAbsolute, resolve } from "node:path";

import type { WorkerConfig } from "../config/worker-config.js";
import { ERROR_CODES, WorkerError } from "../core/errors.js";

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
): readonly string[] {
  if (process.platform !== "win32" || extname(configured) !== "") {
    return [configured];
  }
  const extensions = (pathExtensions ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean);
  return [
    configured,
    ...extensions.map((extension) => `${configured}${extension}`),
  ];
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

  return { ...config, codexExecutable, gitExecutable };
}
