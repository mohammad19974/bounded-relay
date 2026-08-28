import { describe, expect, test } from "vitest";

import { shutdownWorker } from "../src/core/shutdown.js";

describe("worker shutdown", () => {
  test("closes the transport even when job shutdown fails", async () => {
    let closed = false;
    const jobs = {
      shutdown: async (): Promise<void> => {
        await Promise.resolve();
        throw new Error("cleanup failed");
      },
    };
    const transport = {
      close: async (): Promise<void> => {
        await Promise.resolve();
        closed = true;
      },
    };

    await expect(shutdownWorker(jobs, transport)).rejects.toThrow(
      "cleanup failed",
    );
    expect(closed).toBe(true);
  });

  test("closes the transport after a successful job shutdown", async () => {
    const order: string[] = [];
    const jobs = {
      shutdown: async (): Promise<void> => {
        await Promise.resolve();
        order.push("jobs");
      },
    };
    const transport = {
      close: async (): Promise<void> => {
        await Promise.resolve();
        order.push("transport");
      },
    };

    await shutdownWorker(jobs, transport);

    expect(order).toEqual(["jobs", "transport"]);
  });
});
