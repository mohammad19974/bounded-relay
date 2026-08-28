import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";

import { ERROR_CODES, WorkerError } from "./errors.js";

export const LEASE_CLEANUP_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 3,
  retryDelay: 100,
} as const;

/**
 * Liveness is proved by a periodic `mtime` refresh rather than by probing the
 * recorded pid. A pid says nothing about another machine sharing the state
 * directory, and a recycled pid makes an abandoned lease look held forever.
 * The refresh doubles as an ownership check, so a worker whose lease was
 * reclaimed underneath it stops believing it still holds one.
 *
 * The heartbeat/stale-threshold approach follows the design of
 * moxystudio/node-proper-lockfile (MIT); this is an independent
 * dependency-free implementation of that idea.
 */
export const DEFAULT_LEASE_STALE_MS = 10_000;
const MINIMUM_LEASE_STALE_MS = 5_000;
const MINIMUM_REFRESH_MS = 1_000;

interface LeaseOwner {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly pid: number;
  readonly acquiredAt: string;
  readonly token?: string;
  readonly hostname?: string;
}

export interface LeaseHandle {
  release(): Promise<void>;
}

export interface LeaseManagerOptions {
  readonly staleMs?: number;
}

export class LeaseManager {
  readonly #locksDirectory: string;
  readonly #staleMs: number;
  readonly #refreshMs: number;

  public constructor(
    stateDirectory: string,
    options: LeaseManagerOptions = {},
  ) {
    this.#locksDirectory = resolve(stateDirectory, "locks");
    this.#staleMs = Math.max(
      MINIMUM_LEASE_STALE_MS,
      options.staleMs ?? DEFAULT_LEASE_STALE_MS,
    );
    this.#refreshMs = Math.max(
      MINIMUM_REFRESH_MS,
      Math.floor(this.#staleMs / 2),
    );
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
      const token = randomUUID();
      if (await this.#publish(lockDirectory, jobId, token)) {
        return this.#handle(lockDirectory, token);
      }

      if (await this.#isReclaimable(lockDirectory)) {
        const staleDirectory = `${lockDirectory}.stale-${randomUUID()}`;
        try {
          await rename(lockDirectory, staleDirectory);
          await rm(staleDirectory, LEASE_CLEANUP_OPTIONS);
          continue;
        } catch {
          // Another worker reclaimed or replaced the lock first.
        }
      }
      throw new WorkerError(
        ERROR_CODES.LEASE_CONFLICT,
        "Another proposal worker holds the repository lease",
      );
    }

    throw new WorkerError(
      ERROR_CODES.LEASE_CONFLICT,
      "The repository lease could not be acquired",
    );
  }

  #handle(lockDirectory: string, token: string): LeaseHandle {
    let released = false;
    const refresh = setInterval(() => {
      void (async () => {
        if (released) {
          return;
        }
        if (!(await this.#stillOwns(lockDirectory, token))) {
          // The lease was reclaimed underneath this worker. Stop refreshing so
          // the new owner's record is never touched again.
          released = true;
          clearInterval(refresh);
          return;
        }
        const now = new Date();
        try {
          await utimes(lockDirectory, now, now);
        } catch {
          // A removed lock is handled by the ownership check above.
        }
      })();
    }, this.#refreshMs);
    refresh.unref();

    return {
      release: async () => {
        if (released) {
          return;
        }
        clearInterval(refresh);
        // Never remove a lock this worker no longer owns: another worker may
        // have reclaimed it and be holding it right now.
        if (await this.#stillOwns(lockDirectory, token)) {
          await rm(lockDirectory, LEASE_CLEANUP_OPTIONS);
        }
        released = true;
      },
    };
  }

  /**
   * Publishes a complete lock in one atomic step. The owner record is written
   * inside a private directory that is then renamed into place, so a lock
   * directory is never visible to another worker without its owner.
   */
  async #publish(
    lockDirectory: string,
    jobId: string,
    token: string,
  ): Promise<boolean> {
    const stagingDirectory = `${lockDirectory}.acquiring-${randomUUID()}`;
    await mkdir(stagingDirectory, { mode: 0o700 });
    try {
      const owner: LeaseOwner = {
        schemaVersion: 1,
        jobId,
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        token,
        hostname: hostname(),
      };
      await writeFile(
        resolve(stagingDirectory, "owner.json"),
        JSON.stringify(owner),
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      await rename(stagingDirectory, lockDirectory);
      return true;
    } catch (error) {
      await rm(stagingDirectory, LEASE_CLEANUP_OPTIONS);
      if (isAlreadyExists(error) || isNotEmpty(error)) {
        return false;
      }
      throw error;
    }
  }

  async #stillOwns(lockDirectory: string, token: string): Promise<boolean> {
    const owner = await this.#readOwner(lockDirectory);
    return (
      owner !== "missing" && owner !== "malformed" && owner.token === token
    );
  }

  async #isReclaimable(lockDirectory: string): Promise<boolean> {
    const owner = await this.#readOwner(lockDirectory);
    // Publication is atomic, so a lock directory without an owner record is
    // never a live acquisition in progress: it is debris. Malformed records
    // stay fail-closed because they may still describe a running owner.
    if (owner === "missing") {
      return true;
    }
    if (owner === "malformed") {
      return false;
    }
    if (await this.#isStale(lockDirectory)) {
      return true;
    }
    // Same-machine fast path: a dead pid is reclaimable without waiting out
    // the staleness window.
    const sameHost =
      owner.hostname === undefined || owner.hostname === hostname();
    return sameHost && !isProcessAlive(owner.pid);
  }

  async #isStale(lockDirectory: string): Promise<boolean> {
    try {
      const stats = await stat(lockDirectory);
      return Date.now() - stats.mtimeMs > this.#staleMs;
    } catch {
      return false;
    }
  }

  async #readOwner(
    lockDirectory: string,
  ): Promise<LeaseOwner | "missing" | "malformed"> {
    let content: string;
    try {
      content = await readFile(resolve(lockDirectory, "owner.json"), "utf8");
    } catch {
      return "missing";
    }
    try {
      if (content.length > 4_096) {
        return "malformed";
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
      // A malformed record may still describe a running owner.
    }
    return "malformed";
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

function isNotEmpty(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOTEMPTY" || code === "EPERM" || code === "EACCES";
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code !== "ESRCH";
  }
}
