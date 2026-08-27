#!/usr/bin/env node

import { ERROR_CODES, WorkerError, toWorkerError } from "./core/errors.js";
import { startMcpServer } from "./mcp/server.js";
import { assertNotRecursing } from "./security/delegation-policy.js";
import { createWorkerApplication } from "./worker-application.js";

const HELP = `BoundedRelay 0.1.0

Usage:
  boundedrelay serve       Start the local stdio MCP server (default)
  boundedrelay doctor      Validate Codex, Git, authentication, and policy
  boundedrelay config      Print the effective non-secret configuration
  boundedrelay --version   Print the worker version
  boundedrelay --help      Show this help

The server writes only MCP protocol messages to stdout. Diagnostics use stderr.
`;

async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args[0] ?? "serve";
  if (args.length > 1) {
    throw new WorkerError(
      ERROR_CODES.INVALID_REQUEST,
      "This command does not accept additional arguments",
    );
  }

  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (command === "--version" || command === "-V" || command === "version") {
    process.stdout.write("0.1.0\n");
    return;
  }

  assertNotRecursing(process.env.CCW_DELEGATION_DEPTH);
  const application = await createWorkerApplication();

  if (command === "doctor") {
    const health = await application.health();
    process.stdout.write(`${JSON.stringify(health, null, 2)}\n`);
    if (!health.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "config") {
    const { config } = application;
    process.stdout.write(
      `${JSON.stringify(
        {
          version: config.version,
          codexExecutable: config.codexExecutable,
          gitExecutable: config.gitExecutable,
          allowedRoots: config.allowedRoots,
          allowedModels: config.allowedModels,
          proposalsEnabled: config.enableProposals,
          authEnvironmentForwarding: config.forwardAuthEnvironment,
          forwardedEnvironmentNames: config.forwardEnvironment,
          limits: {
            maxConcurrent: config.maxConcurrent,
            maxQueued: config.maxQueued,
            maxHistory: config.maxHistory,
            maxTaskChars: config.maxTaskChars,
            maxOutputBytes: config.maxOutputBytes,
            maxPatchBytes: config.maxPatchBytes,
            maxChangedFiles: config.maxChangedFiles,
            defaultTimeoutMs: config.defaultTimeoutMs,
            maxTimeoutMs: config.maxTimeoutMs,
          },
          stateDirectory: config.stateDirectory,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (command !== "serve") {
    throw new WorkerError(
      ERROR_CODES.INVALID_REQUEST,
      `Unknown command: ${command}`,
    );
  }

  const health = await application.health();
  if (!health.compatible) {
    throw new WorkerError(
      ERROR_CODES.CODEX_INCOMPATIBLE,
      "The installed Codex CLI does not support every required non-interactive flag; run `boundedrelay doctor`",
    );
  }

  const mcp = await startMcpServer(application);
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await application.jobs.shutdown();
    await mcp.close();
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
  process.stdin.once("end", () => {
    void shutdown();
  });
}

void main().catch((error: unknown) => {
  const workerError = toWorkerError(error);
  process.stderr.write(
    `[boundedrelay] ${workerError.code}: ${workerError.message}\n`,
  );
  process.exitCode = 1;
});
