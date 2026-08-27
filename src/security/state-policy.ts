import { homedir } from "node:os";
import { chmod, lstat, mkdir, realpath, stat } from "node:fs/promises";
import { parse, resolve } from "node:path";

import type { WorkerConfig } from "../config/worker-config.js";
import { ERROR_CODES, WorkerError, toErrorMessage } from "../core/errors.js";
import { pathsOverlap } from "./path-policy.js";

async function canonicalDirectory(
  path: string,
  label: string,
): Promise<string> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new WorkerError(
        ERROR_CODES.CONFIG_INVALID,
        `${label} must be a non-symlink directory`,
      );
    }
    return await realpath(path);
  } catch (error) {
    if (error instanceof WorkerError) {
      throw error;
    }
    throw new WorkerError(
      ERROR_CODES.CONFIG_INVALID,
      `${label} could not be resolved: ${toErrorMessage(error)}`,
    );
  }
}

export async function initializeSecurityPolicy(
  config: WorkerConfig,
): Promise<WorkerConfig> {
  const requestedStateDirectory = resolve(config.stateDirectory);
  const requestedHome = resolve(homedir());
  if (
    requestedStateDirectory === parse(requestedStateDirectory).root ||
    requestedStateDirectory === requestedHome
  ) {
    throw new WorkerError(
      ERROR_CODES.CONFIG_INVALID,
      "CCW_STATE_DIR must not be the filesystem root or the user home directory",
    );
  }

  await mkdir(requestedStateDirectory, { recursive: true, mode: 0o700 });
  const stateDirectory = await canonicalDirectory(
    requestedStateDirectory,
    "CCW_STATE_DIR",
  );
  const stateMetadata = await stat(stateDirectory);
  if (
    process.platform !== "win32" &&
    process.getuid !== undefined &&
    stateMetadata.uid !== process.getuid()
  ) {
    throw new WorkerError(
      ERROR_CODES.CONFIG_INVALID,
      "CCW_STATE_DIR must be owned by the current OS user",
    );
  }
  if (process.platform !== "win32") {
    await chmod(stateDirectory, 0o700);
  }

  const canonicalHome = await realpath(requestedHome).catch(
    () => requestedHome,
  );
  const allowedRoots = await Promise.all(
    config.allowedRoots.map(async (root, index) => {
      const canonical = await canonicalDirectory(
        root,
        `allowed root ${index + 1}`,
      );
      if (canonical === parse(canonical).root || canonical === canonicalHome) {
        throw new WorkerError(
          ERROR_CODES.CONFIG_INVALID,
          "CCW_ALLOWED_ROOTS must contain specific project directories, not the filesystem root or user home",
        );
      }
      if (pathsOverlap(canonical, stateDirectory)) {
        throw new WorkerError(
          ERROR_CODES.CONFIG_INVALID,
          "CCW_STATE_DIR must be outside every allowed project root",
        );
      }
      return canonical;
    }),
  );

  return {
    ...config,
    stateDirectory,
    allowedRoots: [...new Set(allowedRoots)],
  };
}
