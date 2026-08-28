import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { ERROR_CODES, WorkerError } from "./errors.js";

export const LEASE_CLEANUP_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 3,
  retryDelay: 100,
} as const;

interface LeaseOwner {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly pid: number;
  readonly acquiredAt: string;
}

export interface LeaseHandle {
  release(): Promise<void>;
}

export class LeaseManager {
  readonly #locksDirectory: string;

  public constructor(stateDirectory: string) {
    this.#locksDirectory = resolve(stateDirectory, "locks");
  }

  public async initialize(): Promise<void> {
    await mkdir(this.#locksDirectory, { recursive: true, mode: 0o700 });
  }

  public async acquire(
    repositoryRoot: string,
    jobId: string,
  ): Promise<LeaseHandle> {
    const key = createHash("sha256").update(repositoryRoot).digest("hex");
    const lockDirectory = resolve(this.#locksDirectory, key);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await mkdir(lockDirectory, { mode: 0o700 });
        const owner: LeaseOwner = {
          schemaVersion: 1,
          jobId,
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
        };
        await writeFile(
          resolve(lockDirectory, "owner.json"),
          JSON.stringify(owner),
          {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          },
        );
        let released = false;
        return {
          release: async () => {
            if (released) {
              return;
            }
            released = true;
            await rm(lockDirectory, LEASE_CLEANUP_OPTIONS);
          },
        };
      } catch (error) {
        if (!isAlreadyExists(error)) {
          throw error;
        }
        const owner = await this.#readOwner(lockDirectory);
        if (owner !== undefined && !isProcessAlive(owner.pid)) {
          const staleDirectory = `${lockDirectory}.stale-${randomUUID()}`;
          try {
            await rename(lockDirectory, staleDirectory);
            await rm(staleDirectory, LEASE_CLEANUP_OPTIONS);
            continue;
          } catch {
            // Another process may have recovered or replaced the lock.
          }
        }
        throw new WorkerError(
          ERROR_CODES.LEASE_CONFLICT,
          "Another proposal worker holds the repository lease",
        );
      }
    }

    throw new WorkerError(
      ERROR_CODES.LEASE_CONFLICT,
      "The repository lease could not be acquired",
    );
  }

  async #readOwner(lockDirectory: string): Promise<LeaseOwner | undefined> {
    try {
      const content = await readFile(
        resolve(lockDirectory, "owner.json"),
        "utf8",
      );
      if (content.length > 4_096) {
        return undefined;
      }
      const value = JSON.parse(content) as Partial<LeaseOwner>;
      if (
        value.schemaVersion === 1 &&
        typeof value.jobId === "string" &&
        typeof value.pid === "number" &&
        Number.isInteger(value.pid) &&
        typeof value.acquiredAt === "string"
      ) {
        return value as LeaseOwner;
      }
    } catch {
      // Malformed or concurrently removed locks fail closed below.
    }
    return undefined;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    );
  }
}
