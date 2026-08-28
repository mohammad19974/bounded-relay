import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { URL, fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const MAX_PACKED_BYTES = 1_000_000;
const MAX_UNPACKED_BYTES = 3_000_000;
const DEFAULT_CHILD_TIMEOUT_MS = 180_000;
const MCP_OPERATION_TIMEOUT_MS = 30_000;
const MAX_CHILD_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_CHILD_STDIN_BYTES = 512 * 1024;
const packageManifest = JSON.parse(
  await readFile(join(projectRoot, "package.json"), "utf8"),
);
const retainedRoot = process.env.BOUNDEDRELAY_PACKAGE_SMOKE_OUTPUT_DIR?.trim();
const smokeRoot =
  retainedRoot === undefined || retainedRoot === ""
    ? await mkdtemp(join(tmpdir(), "boundedrelay-package-smoke-"))
    : resolve(retainedRoot);
const shouldClean = retainedRoot === undefined || retainedRoot === "";

try {
  if (!shouldClean) {
    await mkdir(smokeRoot);
  }

  const packDirectory = join(smokeRoot, "pack");
  const consumerDirectory = join(smokeRoot, "consumer");
  const cacheDirectory = join(smokeRoot, "npm-cache");
  await Promise.all([
    mkdir(packDirectory),
    mkdir(consumerDirectory),
    mkdir(cacheDirectory),
  ]);

  const packed = await npm(
    [
      "pack",
      "--json",
      "--pack-destination",
      packDirectory,
      "--cache",
      cacheDirectory,
    ],
    projectRoot,
  );
  const packRecords = parseJson(packed.stdout, "npm pack JSON output");
  assert(
    Array.isArray(packRecords) && packRecords.length === 1,
    "npm pack must return exactly one package record",
  );
  const packRecord = packRecords[0];
  assertRecord(packRecord, "npm pack record");
  assert(
    packRecord.name === packageManifest.name &&
      packRecord.version === packageManifest.version,
    "npm pack identity does not match package.json",
  );
  assert(
    typeof packRecord.filename === "string" && packRecord.filename !== "",
    "npm pack did not report a tarball filename",
  );
  assert(
    Array.isArray(packRecord.files),
    "npm pack did not report file metadata",
  );
  assert(
    Number.isInteger(packRecord.size) && packRecord.size <= MAX_PACKED_BYTES,
    `packed tarball exceeds ${MAX_PACKED_BYTES} bytes`,
  );
  assert(
    Number.isInteger(packRecord.unpackedSize) &&
      packRecord.unpackedSize <= MAX_UNPACKED_BYTES,
    `unpacked artifact exceeds ${MAX_UNPACKED_BYTES} bytes`,
  );

  const packedFiles = new Set(
    packRecord.files.map((file, index) => {
      assertRecord(file, `npm pack file ${index}`);
      assert(
        typeof file.path === "string" && file.path !== "",
        `npm pack file ${index} has no path`,
      );
      return file.path;
    }),
  );
  assertPackageContents(packedFiles, packageManifest);

  const tarballPath = join(packDirectory, packRecord.filename);
  await access(tarballPath, constants.R_OK);
  await writeFile(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify({ name: "boundedrelay-package-smoke", private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  );

  await npm(
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--cache",
      cacheDirectory,
      tarballPath,
    ],
    consumerDirectory,
  );

  const installedRoot = join(
    consumerDirectory,
    "node_modules",
    packageManifest.name,
  );
  const installedManifest = parseJson(
    await readFile(join(installedRoot, "package.json"), "utf8"),
    "installed package.json",
  );
  assertRecord(installedManifest, "installed package.json");
  assert(
    installedManifest.name === packageManifest.name &&
      installedManifest.version === packageManifest.version,
    "installed package identity does not match the packed artifact",
  );

  const cliPath = join(installedRoot, "dist", "cli.js");
  const indexPath = join(installedRoot, "dist", "index.js");
  await Promise.all([
    access(cliPath, constants.R_OK),
    access(indexPath, constants.R_OK),
    access(installedShimPath(consumerDirectory), constants.F_OK),
  ]);

  const version = await run(process.execPath, [cliPath, "--version"], {
    cwd: consumerDirectory,
  });
  assert(
    version.stdout.trim() === packageManifest.version,
    "installed CLI returned the wrong version",
  );

  const help = await run(process.execPath, [cliPath, "--help"], {
    cwd: consumerDirectory,
  });
  assert(
    help.stdout.includes("boundedrelay serve") &&
      help.stdout.includes("boundedrelay sdd validate") &&
      help.stdout.includes("boundedrelay profile template"),
    "installed CLI help is incomplete",
  );

  const templateRun = await run(
    process.execPath,
    [cliPath, "profile", "template"],
    { cwd: consumerDirectory },
  );
  const profileTemplate = parseJson(
    templateRun.stdout,
    "installed profile template",
  );
  assertRecord(profileTemplate, "installed profile template");
  assertRecord(profileTemplate.writePolicy, "installed template write policy");
  assertRecord(profileTemplate.codexPolicy, "installed template Codex policy");
  assert(
    Array.isArray(profileTemplate.checkProfiles) &&
      profileTemplate.checkProfiles.length === 0 &&
      Array.isArray(profileTemplate.writePolicy.allowedRoots) &&
      profileTemplate.writePolicy.allowedRoots.length === 0 &&
      profileTemplate.codexPolicy.byRisk === undefined,
    "installed profile template must remain fail-closed for writes and critical work",
  );
  const validationRun = await run(
    process.execPath,
    [cliPath, "profile", "validate"],
    {
      cwd: consumerDirectory,
      stdin: `${JSON.stringify(profileTemplate)}\n`,
    },
  );
  const profileValidation = parseJson(
    validationRun.stdout,
    "installed profile validation",
  );
  assertRecord(profileValidation, "installed profile validation");
  assertRecord(profileValidation.profile, "installed normalized profile");
  assert(
    profileValidation.valid === true &&
      profileValidation.profile.profileId === profileTemplate.profileId &&
      typeof profileValidation.profileFingerprint === "string" &&
      /^[a-f0-9]{64}$/u.test(profileValidation.profileFingerprint),
    "installed profile template did not validate and fingerprint",
  );

  const integration = await run(
    process.execPath,
    [cliPath, "sdd", "validate"],
    { cwd: consumerDirectory },
  );
  const integrationResult = parseJson(
    integration.stdout,
    "installed integration validation",
  );
  const installedIntegrationRoot = await realpath(
    join(installedRoot, "integrations"),
  );
  assertRecord(integrationResult, "installed integration validation");
  assert(
    integrationResult.ok === true &&
      integrationResult.root === installedIntegrationRoot,
    "installed integration pack did not validate from the package root",
  );

  const importUrl = pathToFileURL(indexPath).href;
  const imported = await run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const module = await import(${JSON.stringify(importUrl)}); process.stdout.write(JSON.stringify({ exportedNames: Object.keys(module).sort(), version: module.BOUNDEDRELAY_VERSION }));`,
    ],
    { cwd: consumerDirectory },
  );
  const importedSummary = parseJson(imported.stdout, "installed ESM exports");
  assertRecord(importedSummary, "installed ESM exports");
  const exportedNames = importedSummary.exportedNames;
  assert(
    Array.isArray(exportedNames) &&
      exportedNames.includes("createWorkerApplication") &&
      exportedNames.includes("routeSddTasks") &&
      exportedNames.includes("routeProfiledSddTasks") &&
      exportedNames.includes("createProjectProfileTemplate") &&
      exportedNames.includes("BOUNDEDRELAY_VERSION") &&
      importedSummary.version === packageManifest.version,
    "installed ESM entrypoint is missing required exports",
  );

  const mcpSummary = await smokeInstalledMcp({
    cliPath,
    consumerDirectory,
    smokeRoot,
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        package: `${packageManifest.name}@${packageManifest.version}`,
        packedFiles: packedFiles.size,
        tarball: tarballPath,
        installedRoot,
        mcp: mcpSummary,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (shouldClean) {
    await rm(smokeRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

function assertPackageContents(files, manifest) {
  const required = [
    "package.json",
    "README.md",
    "LICENSE",
    normalizePackagePath(manifest.bin?.boundedrelay),
    normalizePackagePath(manifest.main),
    normalizePackagePath(manifest.types),
    "integrations/claude-code-plugin/.claude-plugin/plugin.json",
    "integrations/claude-code-plugin/.mcp.json",
    "integrations/spec-kit/workflow/workflow.yml",
    "schemas/sdd/v1/route-input.schema.json",
    "schemas/sdd/v1/project-profile.schema.json",
    "schemas/sdd/v1/profiled-route-input.schema.json",
    "schemas/sdd/v1/profiled-route-plan.schema.json",
    "docs/project-profiles.md",
    "examples/profiles/starter.json",
    "benchmarks/routing-conformance-corpus.json",
    "scripts/routing-conformance.mjs",
  ];
  for (const path of required) {
    assert(files.has(path), `packed artifact is missing ${path}`);
  }

  const forbidden = [...files].filter((path) => {
    const segments = path.split("/");
    const leaf = basename(path).toLowerCase();
    return (
      segments.some((segment) =>
        [
          ".git",
          ".github",
          ".specify",
          "coverage",
          "node_modules",
          "src",
          "tests",
        ].includes(segment),
      ) ||
      [
        ".npmrc",
        ".pypirc",
        "credentials.json",
        "id_ed25519",
        "id_rsa",
        "npm-shrinkwrap.json",
        "package-lock.json",
      ].includes(leaf) ||
      leaf === ".env" ||
      leaf.endsWith(".pem") ||
      leaf.endsWith(".key") ||
      path.endsWith(".tgz")
    );
  });
  assert(
    forbidden.length === 0,
    `packed artifact contains forbidden paths: ${forbidden.join(", ")}`,
  );
  assert(
    !files.has("docs/assets/boundedrelay-linkedin-claude-codex.png"),
    "packed artifact includes the development-only LinkedIn image",
  );
}

async function smokeInstalledMcp({ cliPath, consumerDirectory, smokeRoot }) {
  const emptyHome = join(smokeRoot, "empty-home");
  const emptyCodexHome = join(smokeRoot, "empty-codex-home");
  const stateDirectory = join(smokeRoot, "state");
  await Promise.all([
    mkdir(emptyHome),
    mkdir(emptyCodexHome),
    mkdir(stateDirectory),
  ]);
  const fakeCodexPath = join(smokeRoot, "fake-codex.mjs");
  await writeFile(fakeCodexPath, smokeCodexSource(), "utf8");
  await chmod(fakeCodexPath, 0o755);

  const environment = compactEnvironment({
    ...process.env,
    HOME: emptyHome,
    CODEX_HOME: emptyCodexHome,
    CCW_ALLOWED_ROOTS: consumerDirectory,
    CCW_STATE_DIR: stateDirectory,
    CCW_CODEX_BIN: fakeCodexPath,
  });
  delete environment.CODEX_ACCESS_TOKEN;
  delete environment.CODEX_API_KEY;
  delete environment.OPENAI_API_KEY;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "serve"],
    cwd: consumerDirectory,
    env: environment,
    stderr: "pipe",
  });
  const client = new Client(
    { name: "boundedrelay-package-smoke", version: "1.0.0" },
    { capabilities: {} },
  );
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  try {
    await withTimeout(
      client.connect(transport),
      "installed MCP connect",
      MCP_OPERATION_TIMEOUT_MS,
    );
    const tools = await withTimeout(
      client.listTools(),
      "installed MCP tool discovery",
      MCP_OPERATION_TIMEOUT_MS,
    );
    const toolNames = tools.tools.map((tool) => tool.name);
    assert(
      JSON.stringify(toolNames) ===
        JSON.stringify([
          "codex_worker_capabilities",
          "codex_worker_workspace",
          "codex_worker_sdd_route",
          "codex_worker_sdd_review",
          "codex_worker_analyze",
          "codex_worker_status",
          "codex_worker_result",
          "codex_worker_cancel",
          "codex_worker_list",
        ]),
      `installed MCP exposed unexpected tools: ${toolNames.join(", ")}`,
    );

    const capabilities = await withTimeout(
      client.callTool({
        name: "codex_worker_capabilities",
        arguments: {},
      }),
      "installed MCP capabilities call",
      MCP_OPERATION_TIMEOUT_MS,
    );
    assertRecord(capabilities.structuredContent, "MCP capabilities");
    assert(
      capabilities.isError !== true &&
        capabilities.structuredContent.compatible === true &&
        capabilities.structuredContent.authenticated === false &&
        capabilities.structuredContent.proposalsEnabled === false,
      "credential-free installed MCP capabilities are incorrect",
    );

    const route = await withTimeout(
      client.callTool({
        name: "codex_worker_sdd_route",
        arguments: {
          tasks: [
            {
              id: "package-smoke",
              effortPoints: 1,
              risk: "low",
              authority: "read-only",
              kind: "review",
            },
          ],
        },
      }),
      "installed MCP routing call",
      MCP_OPERATION_TIMEOUT_MS,
    );
    assertRecord(route.structuredContent, "MCP route result");
    assert(
      route.isError !== true && route.structuredContent.schemaVersion === 1,
      "credential-free model-free MCP route failed",
    );

    return {
      tools: toolNames.length,
      compatible: true,
      authenticated: false,
      modelCall: false,
    };
  } catch (error) {
    throw new Error(
      `installed MCP smoke failed: ${stderr.trim() || "no stderr"}`,
      { cause: error },
    );
  } finally {
    await withTimeout(
      client.close(),
      "installed MCP close",
      MCP_OPERATION_TIMEOUT_MS,
    );
  }
}

async function withTimeout(operation, label, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      operation,
      new Promise((_, rejectPromise) => {
        timeout = setTimeout(() => {
          rejectPromise(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function npm(args, cwd) {
  const npmExecPath = process.env.npm_execpath;
  assert(
    typeof npmExecPath === "string" && npmExecPath.trim() !== "",
    "npm_execpath is required; run this smoke through npm",
  );
  await access(npmExecPath, constants.R_OK);
  return await run(process.execPath, [npmExecPath, ...args], { cwd });
}

function run(
  command,
  args,
  {
    cwd,
    env = process.env,
    stdin,
    timeoutMs = DEFAULT_CHILD_TIMEOUT_MS,
    maxOutputBytes = MAX_CHILD_OUTPUT_BYTES,
  },
) {
  assert(
    Number.isInteger(timeoutMs) && timeoutMs > 0,
    "child timeout must be a positive integer",
  );
  assert(
    Number.isInteger(maxOutputBytes) && maxOutputBytes > 0,
    "child output limit must be a positive integer",
  );
  if (stdin !== undefined) {
    assert(typeof stdin === "string", "child stdin must be a string");
    assert(
      Buffer.byteLength(stdin, "utf8") <= MAX_CHILD_STDIN_BYTES,
      `child stdin exceeds ${MAX_CHILD_STDIN_BYTES} bytes`,
    );
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let terminationReason;
    let settled = false;
    const finish = (operation) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      operation();
    };
    const terminate = (reason) => {
      if (terminationReason === undefined) {
        terminationReason = reason;
        child.kill("SIGKILL");
      }
    };
    const timeout = setTimeout(() => {
      terminate(`${command} timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (outputBytes > maxOutputBytes) {
        terminate(`${command} exceeded ${maxOutputBytes} output bytes`);
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (outputBytes > maxOutputBytes) {
        terminate(`${command} exceeded ${maxOutputBytes} output bytes`);
        return;
      }
      stderr += chunk;
    });
    child.once("error", (error) => {
      finish(() => rejectPromise(error));
    });
    child.once("close", (code, signal) => {
      if (terminationReason !== undefined) {
        finish(() => rejectPromise(new Error(terminationReason)));
        return;
      }
      if (code === 0) {
        finish(() => resolvePromise({ stdout, stderr }));
        return;
      }
      finish(() =>
        rejectPromise(
          new Error(
            `${command} exited with ${code ?? `signal ${signal ?? "unknown"}`}\n${stderr.trim() || stdout.trim()}`,
          ),
        ),
      );
    });
    if (stdin !== undefined) {
      child.stdin.end(stdin, "utf8");
    }
  });
}

function smokeCodexSource() {
  return `#!/usr/bin/env node
const args = process.argv.slice(2);

if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("codex-cli package-smoke\\n");
  process.exit(0);
}
if (args.length === 1 && args[0] === "--help") {
  process.stdout.write("--strict-config --sandbox --ask-for-approval --cd\\n");
  process.exit(0);
}
if (args[0] === "exec" && args[1] === "--help") {
  process.stdout.write("--json --ephemeral --ignore-user-config --ignore-rules --color --output-schema\\n");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  process.stderr.write("not logged in\\n");
  process.exit(1);
}
process.stderr.write("unsupported package-smoke Codex invocation\\n");
process.exit(2);
`;
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

function normalizePackagePath(value) {
  assert(
    typeof value === "string" && value.trim() !== "",
    "package entry path is missing",
  );
  return value.replace(/^\.\//u, "");
}

function installedShimPath(consumerDirectory) {
  const extension = process.platform === "win32" ? ".cmd" : "";
  return join(
    consumerDirectory,
    "node_modules",
    ".bin",
    `boundedrelay${extension}`,
  );
}

function compactEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter((entry) => entry[1] !== undefined),
  );
}

function assertRecord(value, label) {
  assert(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${label} must be an object`,
  );
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
