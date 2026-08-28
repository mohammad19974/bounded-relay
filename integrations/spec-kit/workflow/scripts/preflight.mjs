#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import {
  assertDirectory,
  assertInside,
  assertSafeIdentifier,
  fail,
  optionalProjectProfilePath,
  printSuccess,
  readJson,
} from "./evidence-core.mjs";

function safeFeatureDirectory(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value.startsWith("/") ||
    value.includes("\0") ||
    value.includes("\\") ||
    /^[A-Za-z]:/u.test(value) ||
    value
      .split("/")
      .some(
        (part) =>
          part === "" ||
          part === "." ||
          part === ".." ||
          part.toLowerCase() === ".git",
      )
  ) {
    fail("feature_directory must be a safe repository-relative path");
  }
  return value;
}

function boundedInput(value, label, maximum) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > maximum ||
    // eslint-disable-next-line no-control-regex -- multiline input permits only tab, LF, and CR controls.
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    fail(`${label} must contain 1-${maximum} safe characters`);
  }
}

try {
  const [runId] = process.argv.slice(2);
  if (!runId) {
    fail("usage: preflight.mjs <run-id>");
  }
  assertSafeIdentifier(runId, "workflow run id");
  const projectRoot = realpathSync(resolve(process.cwd()));
  const runsRoot = resolve(projectRoot, ".specify/workflows/runs");
  assertDirectory(runsRoot, "workflow runs directory");
  const runDirectory = resolve(runsRoot, runId);
  assertInside(runsRoot, runDirectory, "workflow run directory");
  assertDirectory(runDirectory, "workflow run directory");
  const document = readJson(
    resolve(runDirectory, "inputs.json"),
    "workflow inputs",
    128 * 1024,
  );
  const inputs = document?.inputs;
  if (typeof inputs !== "object" || inputs === null || Array.isArray(inputs)) {
    fail("workflow inputs must contain an inputs object");
  }
  const featureDirectory = safeFeatureDirectory(inputs.feature_directory);
  boundedInput(inputs.spec, "spec", 32_000);
  boundedInput(inputs.scope, "scope", 4_096);
  const codexShare =
    inputs.codex_share === "" ? 50 : Number(inputs.codex_share);
  if (!Number.isInteger(codexShare) || codexShare < 0 || codexShare > 100) {
    fail("codex_share must be an integer from 0 to 100");
  }
  const candidate = resolve(projectRoot, featureDirectory);
  assertInside(projectRoot, candidate, "feature directory");
  const projectProfile = optionalProjectProfilePath({ projectRoot, inputs });
  printSuccess({
    runId,
    featureDirectory,
    codexShare,
    projectProfile,
    valid: true,
  });
} catch (error) {
  process.stderr.write(`Workflow preflight error: ${error.message}\n`);
  process.exitCode = 1;
}
