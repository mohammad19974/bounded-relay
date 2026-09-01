#!/usr/bin/env node

import { presentEffectiveConfig } from "./config/worker-config.js";
import { ERROR_CODES, WorkerError, toWorkerError } from "./core/errors.js";
import { shutdownWorker } from "./core/shutdown.js";
import { startMcpServer } from "./mcp/server.js";
import { assertNotRecursing } from "./security/delegation-policy.js";
import { createWorkerApplication } from "./worker-application.js";
import { BOUNDEDRELAY_VERSION } from "./version.js";
import {
  locateIntegrationPack,
  validateIntegrationPack,
} from "./sdd/integration-pack.js";
import {
  SddRoutingError,
  createProjectProfileTemplate,
  normalizeProjectProfile,
  projectProfileFingerprint,
  routeProfiledSddTasks,
  routeSddTasks,
  type ProfiledSddRoutingInput,
  type SddProjectProfileInput,
  type SddRoutingInput,
} from "./sdd/routing/index.js";

const HELP = `BoundedRelay ${BOUNDEDRELAY_VERSION}

Usage:
  boundedrelay serve       Start the local stdio MCP server (default)
  boundedrelay doctor      Validate Codex, Git, authentication, and policy
  boundedrelay config      Print the effective non-secret configuration
  boundedrelay sdd path    Print the packaged Spec Kit/Claude integration path
  boundedrelay sdd validate  Validate packaged integration assets without installing
  boundedrelay sdd route   Route one JSON request from stdin without a model call
  boundedrelay profile template  Print a safe generic project-profile template
  boundedrelay profile validate  Normalize and fingerprint one profile from stdin
  boundedrelay --version   Print the worker version
  boundedrelay --help      Show this help

The server writes only MCP protocol messages to stdout. Diagnostics use stderr.
`;

async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args[0] ?? "serve";
  const sddSubcommand = command === "sdd" ? args[1] : undefined;
  const profileSubcommand = command === "profile" ? args[1] : undefined;
  if (
    ((command === "sdd" || command === "profile") && args.length !== 2) ||
    (command !== "sdd" && command !== "profile" && args.length > 1)
  ) {
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
    process.stdout.write(`${BOUNDEDRELAY_VERSION}\n`);
    return;
  }

  if (command === "sdd" && sddSubcommand === "path") {
    process.stdout.write(`${await locateIntegrationPack()}\n`);
    return;
  }
  if (command === "sdd" && sddSubcommand === "validate") {
    process.stdout.write(
      `${JSON.stringify(await validateIntegrationPack(), null, 2)}\n`,
    );
    return;
  }
  if (command === "sdd" && sddSubcommand === "route") {
    const request = await readJsonStdin(256 * 1024);
    process.stdout.write(`${JSON.stringify(routeRequest(request))}\n`);
    return;
  }
  if (command === "sdd") {
    throw new WorkerError(
      ERROR_CODES.INVALID_REQUEST,
      `Unknown SDD command: ${sddSubcommand ?? "missing"}`,
    );
  }
  if (command === "profile" && profileSubcommand === "template") {
    process.stdout.write(
      `${JSON.stringify(createProjectProfileTemplate(), null, 2)}\n`,
    );
    return;
  }
  if (command === "profile" && profileSubcommand === "validate") {
    const input = await readJsonStdin(128 * 1024);
    const profile = normalizeProfile(input);
    process.stdout.write(
      `${JSON.stringify(
        {
          valid: true,
          profile,
          profileFingerprint: projectProfileFingerprint(profile),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (command === "profile") {
    throw new WorkerError(
      ERROR_CODES.INVALID_REQUEST,
      `Unknown profile command: ${profileSubcommand ?? "missing"}`,
    );
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
    process.stdout.write(
      `${JSON.stringify(presentEffectiveConfig(application.config), null, 2)}\n`,
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
  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    // A failing shutdown must still close the transport and report itself
    // instead of surfacing as an unhandled rejection.
    void shutdownWorker(application.jobs, mcp).catch((error: unknown) => {
      const workerError = toWorkerError(error);
      process.stderr.write(
        `[boundedrelay] ${workerError.code}: ${workerError.message}\n`,
      );
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdin.once("end", shutdown);
}

function routeRequest(input: unknown): unknown {
  try {
    if (hasProjectProfile(input)) {
      // Both routing paths perform their own strict runtime validation. The
      // CLI deliberately keeps stdin as `unknown` until that boundary.
      return routeProfiledSddTasks(input as unknown as ProfiledSddRoutingInput);
    }
    return routeSddTasks(input as SddRoutingInput);
  } catch (error) {
    if (error instanceof SddRoutingError) {
      throw new WorkerError(ERROR_CODES.INVALID_REQUEST, error.message);
    }
    throw error;
  }
}

function normalizeProfile(
  input: unknown,
): ReturnType<typeof normalizeProjectProfile> {
  try {
    return normalizeProjectProfile(input as SddProjectProfileInput);
  } catch (error) {
    if (error instanceof SddRoutingError) {
      throw new WorkerError(ERROR_CODES.INVALID_REQUEST, error.message);
    }
    throw error;
  }
}

function hasProjectProfile(
  input: unknown,
): input is Readonly<Record<string, unknown>> & { projectProfile: unknown } {
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    "projectProfile" in input
  );
}

async function readJsonStdin(maximumBytes: number): Promise<unknown> {
  if (process.stdin.isTTY) {
    throw new WorkerError(
      ERROR_CODES.INVALID_REQUEST,
      "SDD route input must be provided as JSON on stdin",
    );
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.byteLength;
    if (totalBytes > maximumBytes) {
      throw new WorkerError(
        ERROR_CODES.INVALID_REQUEST,
        `SDD route input exceeds ${maximumBytes} bytes`,
      );
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new WorkerError(
      ERROR_CODES.INVALID_REQUEST,
      "SDD route input must be valid JSON",
    );
  }
}

void main().catch((error: unknown) => {
  const workerError = toWorkerError(error);
  process.stderr.write(
    `[boundedrelay] ${workerError.code}: ${workerError.message}\n`,
  );
  process.exitCode = 1;
});
