import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

import type { RunMode } from "../core/types.js";
import { ERROR_CODES, WorkerError, toErrorMessage } from "../core/errors.js";

export interface ResolvedWorkingSet {
  readonly cwd: string;
  readonly repositoryRoot: string;
  readonly executionRoot: string;
  readonly writePaths?: readonly string[];
}

export interface PathOperations {
  readonly isAbsolute: (path: string) => boolean;
  readonly relative: (from: string, to: string) => string;
  readonly sep: string;
}

const NATIVE_PATH_OPERATIONS: PathOperations = {
  isAbsolute,
  relative,
  sep,
};

export function isPathInside(
  parent: string,
  candidate: string,
  pathOperations: PathOperations = NATIVE_PATH_OPERATIONS,
): boolean {
  const pathFromParent = pathOperations.relative(parent, candidate);
  return (
    pathFromParent === "" ||
    (!pathOperations.isAbsolute(pathFromParent) &&
      pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${pathOperations.sep}`) &&
      !pathFromParent.startsWith(pathOperations.sep))
  );
}

export function pathsOverlap(
  left: string,
  right: string,
  pathOperations: PathOperations = NATIVE_PATH_OPERATIONS,
): boolean {
  return (
    isPathInside(left, right, pathOperations) ||
    isPathInside(right, left, pathOperations)
  );
}

async function canonicalDirectory(
  path: string,
  label: string,
): Promise<string> {
  const requestedPath = resolve(path);
  try {
    const requestedStat = await lstat(requestedPath);
    if (requestedStat.isSymbolicLink() || !requestedStat.isDirectory()) {
      throw new WorkerError(
        ERROR_CODES.INVALID_PATH,
        `${label} must be an existing, non-symlink directory`,
      );
    }
    return await realpath(requestedPath);
  } catch (error) {
    if (error instanceof WorkerError) {
      throw error;
    }
    throw new WorkerError(
      ERROR_CODES.INVALID_PATH,
      `${label} could not be resolved: ${toErrorMessage(error)}`,
    );
  }
}

async function findRepositoryRoot(start: string): Promise<string> {
  let current = start;
  const root = parse(start).root;

  while (current !== root) {
    try {
      const gitEntry = await lstat(resolve(current, ".git"));
      if (gitEntry.isDirectory() || gitEntry.isFile()) {
        return current;
      }
    } catch {
      // Continue walking toward the filesystem root.
    }

    current = dirname(current);
  }

  try {
    const gitEntry = await lstat(resolve(root, ".git"));
    if (gitEntry.isDirectory() || gitEntry.isFile()) {
      return root;
    }
  } catch {
    // The filesystem root is not a Git repository.
  }

  throw new WorkerError(
    ERROR_CODES.INVALID_PATH,
    "cwd must be inside an existing Git repository",
  );
}

async function canonicalAllowedRoots(
  allowedRoots: readonly string[],
): Promise<readonly string[]> {
  return await Promise.all(
    allowedRoots.map(
      async (root) => await canonicalDirectory(root, "allowed root"),
    ),
  );
}

export async function resolveWorkingSet(input: {
  readonly cwd: string;
  readonly mode: RunMode;
  readonly writePaths?: readonly string[];
  readonly allowedRoots: readonly string[];
}): Promise<ResolvedWorkingSet> {
  const allowedRoots = await canonicalAllowedRoots(input.allowedRoots);
  const cwd = await canonicalDirectory(input.cwd, "cwd");

  if (!allowedRoots.some((allowedRoot) => isPathInside(allowedRoot, cwd))) {
    throw new WorkerError(
      ERROR_CODES.INVALID_PATH,
      "cwd is outside CCW_ALLOWED_ROOTS",
    );
  }

  const repositoryRoot = await findRepositoryRoot(cwd);
  if (
    !allowedRoots.some((allowedRoot) =>
      isPathInside(allowedRoot, repositoryRoot),
    )
  ) {
    throw new WorkerError(
      ERROR_CODES.INVALID_PATH,
      "The resolved Git repository is outside CCW_ALLOWED_ROOTS",
    );
  }

  if (input.mode === "analyze") {
    if (input.writePaths !== undefined) {
      throw new WorkerError(
        ERROR_CODES.INVALID_REQUEST,
        "writePaths is valid only for proposal jobs",
      );
    }
    // Analysis executes from the repository root — already validated against
    // CCW_ALLOWED_ROOTS above — so Codex sees root-level configuration and
    // sibling packages. The requested cwd remains a prompt focus hint only.
    return { cwd, repositoryRoot, executionRoot: repositoryRoot };
  }

  if (input.writePaths === undefined || input.writePaths.length === 0) {
    throw new WorkerError(
      ERROR_CODES.INVALID_REQUEST,
      "proposal jobs require at least one explicit write path",
    );
  }

  return {
    cwd,
    repositoryRoot,
    executionRoot: repositoryRoot,
    writePaths: validateWritePaths(input.writePaths),
  };
}

export function isProtectedProposalPath(path: string): boolean {
  const segments = path.replaceAll("\\", "/").split("/");
  const basename = segments.at(-1)?.toLowerCase() ?? "";
  const protectedEnvironmentFile =
    (basename === ".env" || basename.startsWith(".env.")) &&
    ![".env.example", ".env.sample", ".env.template"].includes(basename);
  return (
    segments.some((segment) => segment.toLowerCase() === ".git") ||
    basename === ".gitmodules" ||
    basename === ".npmrc" ||
    basename === ".pypirc" ||
    basename === "credentials.json" ||
    basename === "id_rsa" ||
    basename === "id_ed25519" ||
    protectedEnvironmentFile ||
    basename.endsWith(".pem") ||
    basename.endsWith(".key")
  );
}

function validateWritePaths(paths: readonly string[]): readonly string[] {
  const normalized = paths.map((path) => path.replaceAll("\\", "/"));
  for (const path of normalized) {
    const segments = path.split("/");
    if (
      path === "" ||
      path === "." ||
      path.startsWith("/") ||
      path.includes("\0") ||
      /^[A-Za-z]:/.test(path) ||
      segments.some(
        (segment) => segment === "" || segment === "." || segment === "..",
      ) ||
      isProtectedProposalPath(path)
    ) {
      throw new WorkerError(
        ERROR_CODES.INVALID_PATH,
        `Unsafe proposal write path: ${JSON.stringify(path)}`,
      );
    }
  }

  return [...new Set(normalized)].sort();
}
