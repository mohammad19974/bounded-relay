import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ERROR_CODES } from "../src/core/errors.js";
import {
  LEASE_CLEANUP_OPTIONS,
  LeaseManager,
} from "../src/core/lease-manager.js";
import { makeStateDirectory } from "./helpers.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
});

describe("LeaseManager", () => {
  test("bounds retries for transient lock cleanup failures", () => {
    expect(LEASE_CLEANUP_OPTIONS).toEqual({
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  });

  test("allows exactly one repository owner and makes release idempotent", async () => {
    const state = await makeStateDirectory();
    cleanupPaths.push(state);
    const firstManager = new LeaseManager(state);
    const secondManager = new LeaseManager(state);
    await Promise.all([firstManager.initialize(), secondManager.initialize()]);

    const first = await firstManager.acquire("/repository", "job-one");
    await expect(
      secondManager.acquire("/repository", "job-two"),
    ).rejects.toMatchObject({ code: ERROR_CODES.LEASE_CONFLICT });

    await first.release();
    await first.release();
    const second = await secondManager.acquire("/repository", "job-two");
    await second.release();
  });

  test("does not conflict across different repository roots", async () => {
    const state = await makeStateDirectory();
    cleanupPaths.push(state);
    const manager = new LeaseManager(state);
    await manager.initialize();

    const left = await manager.acquire("/repository/left", "left");
    const right = await manager.acquire("/repository/right", "right");
    await Promise.all([left.release(), right.release()]);
  });

  test.runIf(process.platform !== "win32")(
    "recovers a well-formed lease whose owner process is gone",
    async () => {
      const state = await makeStateDirectory();
      cleanupPaths.push(state);
      const manager = new LeaseManager(state);
      await manager.initialize();
      const repository = "/repository/stale";
      const key = createHash("sha256").update(repository).digest("hex");
      const lockDirectory = join(state, "locks", key);
      await mkdir(lockDirectory);
      await writeFile(
        join(lockDirectory, "owner.json"),
        JSON.stringify({
          schemaVersion: 1,
          jobId: "dead-job",
          pid: 2_147_483_647,
          acquiredAt: new Date(0).toISOString(),
        }),
        "utf8",
      );

      const recovered = await manager.acquire(repository, "replacement-job");
      await recovered.release();
    },
  );

  test("fails closed for a malformed existing lease", async () => {
    const state = await makeStateDirectory();
    cleanupPaths.push(state);
    const manager = new LeaseManager(state);
    await manager.initialize();
    const repository = "/repository/malformed";
    const key = createHash("sha256").update(repository).digest("hex");
    const lockDirectory = join(state, "locks", key);
    await mkdir(lockDirectory);
    await writeFile(join(lockDirectory, "owner.json"), "not-json", "utf8");

    await expect(manager.acquire(repository, "new-job")).rejects.toMatchObject({
      code: ERROR_CODES.LEASE_CONFLICT,
    });
  });
});
