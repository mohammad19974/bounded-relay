import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ERROR_CODES, WorkerError } from "../core/errors.js";

const INTEGRATION_ROOT = fileURLToPath(
  new URL("../../integrations", import.meta.url),
);

const REQUIRED_FILES = [
  "claude-code-plugin/.claude-plugin/plugin.json",
  "claude-code-plugin/.mcp.json",
  "claude-code-plugin/skills/adaptive-sdd/SKILL.md",
  "claude-code-plugin/skills/setup/SKILL.md",
  "spec-kit/README.md",
  "spec-kit/extension/extension.yml",
  "spec-kit/workflow/workflow.yml",
  "spec-kit/workflow/scripts/evidence-core.mjs",
  "spec-kit/workflow/scripts/check-receipts.mjs",
  "spec-kit/workflow/scripts/preflight.mjs",
  "spec-kit/workflow/scripts/plan-review.mjs",
  "spec-kit/workflow/scripts/routing.mjs",
  "spec-kit/workflow/scripts/execution.mjs",
  "spec-kit/workflow/scripts/convergence.mjs",
  "spec-kit/workflow/scripts/implementation-review.mjs",
  "spec-kit/workflow/scripts/strict-review.mjs",
  "spec-kit/workflow/scripts/proof-pack.mjs",
  "spec-kit/workflow/scripts/handoff.mjs",
  "spec-kit/workflow/schemas/plan-review.schema.json",
  "spec-kit/workflow/schemas/routing.schema.json",
  "spec-kit/workflow/schemas/execution.schema.json",
  "spec-kit/workflow/schemas/implementation-review.schema.json",
  "spec-kit/workflow/schemas/proof-pack.schema.json",
  "spec-kit/workflow/schemas/handoff-context.schema.json",
] as const;

export interface IntegrationPackValidation {
  readonly ok: true;
  readonly root: string;
  readonly requiredFiles: readonly string[];
  readonly jsonManifests: readonly string[];
}

export async function locateIntegrationPack(): Promise<string> {
  return await realpath(INTEGRATION_ROOT);
}

export async function validateIntegrationPack(): Promise<IntegrationPackValidation> {
  const root = await locateIntegrationPack();
  const jsonManifests: string[] = [];
  for (const relativePath of REQUIRED_FILES) {
    const path = resolve(root, relativePath);
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new WorkerError(
        ERROR_CODES.CONFIG_INVALID,
        `Integration asset is not a regular file: ${relativePath}`,
      );
    }
    if (relativePath.endsWith(".json")) {
      try {
        JSON.parse(await readFile(path, "utf8"));
      } catch {
        throw new WorkerError(
          ERROR_CODES.CONFIG_INVALID,
          `Integration manifest is not valid JSON: ${relativePath}`,
        );
      }
      jsonManifests.push(relativePath);
    }
  }
  return {
    ok: true,
    root,
    requiredFiles: REQUIRED_FILES,
    jsonManifests,
  };
}
