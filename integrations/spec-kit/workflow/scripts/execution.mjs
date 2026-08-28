#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

import {
  assertDirectory,
  assertInside,
  assertCleanWorkflowWorktree,
  assertIsoDate,
  assertJobId,
  assertModel,
  assertRegularFile,
  assertSafeIdentifier,
  assertSha256,
  canonicalDigest,
  currentGitRevision,
  evidencePath,
  fail,
  failChild,
  fileDigest,
  printSuccess,
  readJson,
  repositoryTree,
  repositoryRevisionComparison,
  requireSchema,
  safeRepositoryPath,
  workflowContext,
  writeJsonAtomic,
} from "./evidence-core.mjs";
import { assertCheckReceipts } from "./check-receipts.mjs";

const RESULT_KEYS = new Set([
  "taskId",
  "provider",
  "wave",
  "status",
  "transport",
  "effect",
  "baselineRevision",
  "modelSource",
  "model",
  "reasoningEffort",
  "jobId",
  "patchFile",
  "patchSha256",
  "changedFiles",
  "verification",
  "checks",
  "startedAt",
  "completedAt",
]);
const CHECKPOINT_KEYS = new Set([
  "wave",
  "writerTaskId",
  "baselineRevision",
  "completedRevision",
  "changedFiles",
  "diffSha256",
  "resultsSha256",
  "checksSha256",
  "verifiedAt",
]);
const DOCUMENT_KEYS = new Set([
  "schemaVersion",
  "kind",
  "runId",
  "mode",
  "state",
  "routingSha256",
  "routingRevision",
  "activeWave",
  "completedWaves",
  "results",
  "checkpoints",
  "preparedAt",
  "completedAt",
]);
const FULL_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const REASONING_EFFORTS = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const MAX_WRITER_CHECK_RECEIPTS = 256;
const ROUTING_SCRIPT = fileURLToPath(new URL("./routing.mjs", import.meta.url));

function assertStaticRouting(runId) {
  const result = spawnSync(
    process.execPath,
    [ROUTING_SCRIPT, "verify-static", runId],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      shell: false,
    },
  );
  if (result.error || result.status !== 0) {
    failChild(
      "wave execution requires fully verified routing evidence",
      result,
    );
  }
}

function loadRouting(context, runId) {
  const path = evidencePath(context, "routing");
  const document = readJson(path, "routing evidence");
  requireSchema(document, runId, "routing");
  if (
    document.state !== "complete" ||
    !Array.isArray(document.assignments) ||
    !Array.isArray(document.router?.result?.waves)
  ) {
    fail("wave execution requires complete verified routing evidence");
  }
  const waves = [...document.router.result.waves].sort(
    (left, right) => left.wave - right.wave,
  );
  if (
    waves.length === 0 ||
    waves.length > 64 ||
    waves.some((wave, index) => wave.wave !== index + 1)
  ) {
    fail("routing waves must be a canonical contiguous sequence");
  }
  return { document, path, waves };
}

function assignmentMap(routing) {
  return new Map(
    routing.assignments.map((assignment) => [assignment.taskId, assignment]),
  );
}

function tasksForWave(routing, wave) {
  return routing.assignments
    .filter((assignment) => assignment.wave === wave.wave)
    .sort((left, right) => compareCodeUnits(left.taskId, right.taskId));
}

function writerForWave(assignments) {
  const writers = assignments.filter(
    (assignment) => assignment.authority === "write",
  );
  if (writers.length > 1) {
    fail("each routed wave may contain at most one writer");
  }
  return writers[0] ?? null;
}

function assertDocumentIdentity(document, runId, routingSha256) {
  requireSchema(document, runId, "execution");
  if (
    Object.keys(document).some((key) => !DOCUMENT_KEYS.has(key)) ||
    document.mode !== "wave-ordered" ||
    document.routingSha256 !== routingSha256 ||
    !FULL_REVISION.test(document.routingRevision) ||
    !Array.isArray(document.completedWaves) ||
    !Array.isArray(document.results) ||
    !Array.isArray(document.checkpoints)
  ) {
    fail("execution evidence is stale or malformed");
  }
}

function assertVerification(value, label) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 32 ||
    value.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.trim() === "" ||
        entry.length > 1000 ||
        // eslint-disable-next-line no-control-regex -- evidence text must reject every ASCII control character.
        /[\u0000-\u001f\u007f]/u.test(entry),
    )
  ) {
    fail(`${label} requires 1-32 bounded verification statements`);
  }
}

function normalizedPaths(value, label, required) {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    (required && value.length === 0)
  ) {
    fail(`${label} contains an invalid changed-file list`);
  }
  const paths = value
    .map((path) => safeRepositoryPath(path, label))
    .sort(compareCodeUnits);
  if (new Set(paths).size !== paths.length) {
    fail(`${label} contains duplicate paths`);
  }
  return paths;
}

function pathInLease(path, leases) {
  return leases.some((scope) => path === scope || path.startsWith(`${scope}/`));
}

function assertProfileCheckCoverage(receipts, assignment, projectProfile) {
  if (projectProfile === null) {
    return;
  }
  const definitions = new Map(
    projectProfile.checkProfiles.map((profile) => [profile.id, profile]),
  );
  for (const receipt of receipts) {
    const definition = definitions.get(receipt.profile);
    if (
      definition === undefined ||
      receipt.cwd !== definition.cwd ||
      receipt.commandSha256 !== definition.commandSha256
    ) {
      fail(
        `task ${assignment.taskId} has a receipt outside its sealed project check profiles`,
      );
    }
  }
  for (const required of assignment.requiredCheckProfiles) {
    const definition = definitions.get(required.id);
    if (
      definition === undefined ||
      canonicalDigest(definition) !== canonicalDigest(required) ||
      !receipts.some(
        (receipt) =>
          receipt.profile === required.id &&
          receipt.cwd === required.cwd &&
          receipt.commandSha256 === required.commandSha256,
      )
    ) {
      fail(
        `task ${assignment.taskId} is missing required project check ${required.id}`,
      );
    }
  }
}

function validateResult(
  result,
  assignment,
  baselineRevision,
  context,
  projectProfile,
) {
  if (
    typeof result !== "object" ||
    result === null ||
    Array.isArray(result) ||
    Object.keys(result).some((key) => !RESULT_KEYS.has(key))
  ) {
    fail(`task ${assignment.taskId} result contains unsupported fields`);
  }
  assertSafeIdentifier(result.taskId, "execution task id");
  if (
    result.taskId !== assignment.taskId ||
    result.provider !== assignment.provider ||
    result.wave !== assignment.wave ||
    result.status !== "accepted" ||
    result.baselineRevision !== baselineRevision
  ) {
    fail(`task ${assignment.taskId} result does not match its routed wave`);
  }
  assertVerification(result.verification, `task ${assignment.taskId}`);
  assertIsoDate(result.startedAt, `task ${assignment.taskId}.startedAt`);
  assertIsoDate(result.completedAt, `task ${assignment.taskId}.completedAt`);
  if (Date.parse(result.completedAt) < Date.parse(result.startedAt)) {
    fail(`task ${assignment.taskId} completion precedes its start`);
  }

  if (assignment.provider === "codex") {
    const expectedPolicy =
      projectProfile === null ? assignment.modelPolicy : assignment.codexPolicy;
    if (
      result.transport !== "boundedrelay" ||
      result.modelSource !== "worker-resolved" ||
      result.model !== expectedPolicy?.model ||
      result.reasoningEffort !== (expectedPolicy?.reasoningEffort ?? null)
    ) {
      fail(
        `task ${assignment.taskId} does not match its routed BoundedRelay model policy`,
      );
    }
    assertJobId(result.jobId, `task ${assignment.taskId}.jobId`);
    assertModel(result.model ?? null, `task ${assignment.taskId}.model`);
    if (
      result.reasoningEffort !== null &&
      !REASONING_EFFORTS.has(result.reasoningEffort)
    ) {
      fail(`task ${assignment.taskId}.reasoningEffort is invalid`);
    }
  } else {
    if (
      result.transport !== "claude-host" ||
      result.modelSource !== "host-selected" ||
      result.model !== null ||
      result.reasoningEffort !== null ||
      result.jobId !== undefined
    ) {
      fail(`task ${assignment.taskId} must inherit the Claude host model`);
    }
  }

  if (assignment.authority === "read-only") {
    if (
      result.effect !== "analysis" ||
      result.patchSha256 !== undefined ||
      result.patchFile !== undefined ||
      result.changedFiles !== undefined
    ) {
      fail(`read-only task ${assignment.taskId} contains write evidence`);
    }
    assertCheckReceipts(
      result.checks,
      `task ${assignment.taskId}.checks`,
      false,
    );
    if (result.checks.length !== 0) {
      fail(`read-only task ${assignment.taskId} must not own write checks`);
    }
    return;
  }

  const changedFiles = normalizedPaths(
    result.changedFiles,
    `task ${assignment.taskId}.changedFiles`,
    true,
  );
  if (changedFiles.some((path) => !pathInLease(path, assignment.writePaths))) {
    fail(`task ${assignment.taskId} changed a path outside its lease`);
  }
  assertCheckReceipts(result.checks, `task ${assignment.taskId}.checks`, true);
  assertProfileCheckCoverage(result.checks, assignment, projectProfile);
  if (assignment.provider === "codex") {
    if (result.effect !== "proposal-integrated") {
      fail(`Codex writer ${assignment.taskId} requires an integrated proposal`);
    }
    assertSha256(result.patchSha256, `task ${assignment.taskId}.patchSha256`);
    const expectedPatchFile = `patches/${assignment.taskId}.patch`;
    if (result.patchFile !== expectedPatchFile) {
      fail(`task ${assignment.taskId} patch file is not canonical`);
    }
    const patchDirectory = resolve(context.runDirectory, "patches");
    assertInside(context.runDirectory, patchDirectory, "patch directory");
    assertDirectory(patchDirectory, "patch directory");
    const patchPath = resolve(
      context.runDirectory,
      ...expectedPatchFile.split("/"),
    );
    assertInside(context.runDirectory, patchPath, "proposal patch file");
    const patchStat = assertRegularFile(
      patchPath,
      `task ${assignment.taskId} proposal patch`,
      8 * 1024 * 1024,
    );
    if (process.platform !== "win32" && (patchStat.mode & 0o077) !== 0) {
      fail(`task ${assignment.taskId} proposal patch must be owner-only`);
    }
    if (
      fileDigest(
        patchPath,
        `task ${assignment.taskId} proposal patch`,
        8 * 1024 * 1024,
      ) !== result.patchSha256
    ) {
      fail(
        `task ${assignment.taskId} patch digest does not match persisted bytes`,
      );
    }
  } else if (
    result.effect !== "host-write" ||
    result.patchSha256 !== undefined ||
    result.patchFile !== undefined
  ) {
    fail(`Claude writer ${assignment.taskId} requires host-write evidence`);
  }
}

function validateWaveResults(
  document,
  routing,
  wave,
  baselineRevision,
  context,
) {
  const assignments = tasksForWave(routing, wave);
  const expectedIds = assignments.map((assignment) => assignment.taskId);
  const results = document.results
    .filter((result) => result.wave === wave.wave)
    .sort((left, right) => compareCodeUnits(left.taskId, right.taskId));
  const resultIds = results.map((result) => result.taskId);
  if (canonicalDigest(resultIds) !== canonicalDigest(expectedIds)) {
    fail(`wave ${wave.wave} must report every routed task exactly once`);
  }
  for (const [index, result] of results.entries()) {
    const assignment = assignments[index];
    if (assignment === undefined) {
      fail(`wave ${wave.wave} contains an unexpected result`);
    }
    validateResult(
      result,
      assignment,
      baselineRevision,
      context,
      routing.projectProfile ?? null,
    );
  }
  return { assignments, results };
}

function validateDependencyOrder(document, routing) {
  const assignments = assignmentMap(routing);
  const results = new Map(
    document.results.map((result) => [result.taskId, result]),
  );
  for (const assignment of routing.assignments) {
    const result = results.get(assignment.taskId);
    if (result === undefined) {
      continue;
    }
    for (const dependencyId of assignment.dependencies) {
      const dependency = assignments.get(dependencyId);
      const dependencyResult = results.get(dependencyId);
      if (
        dependency === undefined ||
        dependencyResult === undefined ||
        dependency.wave >= assignment.wave ||
        Date.parse(dependencyResult.completedAt) > Date.parse(result.startedAt)
      ) {
        fail(`task ${assignment.taskId} ran before dependency ${dependencyId}`);
      }
    }
  }
}

function assertAggregateWriterReceiptLimit(document, routing, maximumWave) {
  const assignments = assignmentMap(routing);
  let receiptCount = 0;
  for (const result of document.results) {
    const assignment = assignments.get(result.taskId);
    if (
      assignment?.authority === "write" &&
      assignment.wave <= maximumWave &&
      result.wave === assignment.wave
    ) {
      receiptCount += result.checks.length;
    }
  }
  if (receiptCount > MAX_WRITER_CHECK_RECEIPTS) {
    fail(
      `execution exceeds aggregate limit of ${MAX_WRITER_CHECK_RECEIPTS} writer check receipts`,
    );
  }
}

function runCheckpointGit(context, args, environment = undefined) {
  const result = spawnSync("git", args, {
    cwd: context.projectRoot,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
    ...(environment === undefined
      ? {}
      : { env: { ...process.env, ...environment } }),
  });
  if (result.error || result.status !== 0) {
    failChild("Git could not verify the exact writer checkpoint", result);
  }
  return result.stdout.trim().toLowerCase();
}

function assertSingleWriterCommit(
  context,
  baselineRevision,
  completedRevision,
) {
  const commit = runCheckpointGit(context, [
    "rev-list",
    "--parents",
    "-n",
    "1",
    completedRevision,
  ]).split(/\s+/u);
  if (
    commit.length !== 2 ||
    commit[0] !== completedRevision ||
    commit[1] !== baselineRevision
  ) {
    fail(
      "a writer wave requires exactly one non-merge commit whose parent is the active baseline",
    );
  }
}

function assertCheckTrees(receipts, expectedTree, label) {
  if (receipts.some((receipt) => receipt.testedTree !== expectedTree)) {
    fail(`${label} contains a check receipt for a different Git tree`);
  }
}

function assertPatchProducesTree(
  context,
  patchFile,
  baselineRevision,
  completedRevision,
) {
  const indexPath = resolve(
    context.runDirectory,
    `.proposal-index-${randomUUID()}`,
  );
  assertInside(context.runDirectory, indexPath, "proposal verification index");
  const environment = { GIT_INDEX_FILE: indexPath };
  try {
    runCheckpointGit(context, ["read-tree", baselineRevision], environment);
    runCheckpointGit(
      context,
      ["apply", "--cached", "--whitespace=nowarn", "--", patchFile],
      environment,
    );
    const proposedTree = runCheckpointGit(context, ["write-tree"], environment);
    const completedTree = repositoryTree(context, completedRevision);
    if (proposedTree !== completedTree) {
      fail("persisted Codex proposal bytes do not produce the checkpoint tree");
    }
  } finally {
    for (const temporaryPath of [indexPath, `${indexPath}.lock`]) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Git may not have created the temporary index or lock.
      }
    }
  }
}

function validateCheckpoint(
  checkpoint,
  wave,
  routing,
  document,
  expectedBase,
  context,
) {
  if (
    typeof checkpoint !== "object" ||
    checkpoint === null ||
    Array.isArray(checkpoint) ||
    Object.keys(checkpoint).some((key) => !CHECKPOINT_KEYS.has(key)) ||
    checkpoint.wave !== wave.wave ||
    checkpoint.baselineRevision !== expectedBase ||
    !FULL_REVISION.test(checkpoint.completedRevision)
  ) {
    fail(`wave ${wave.wave} checkpoint is malformed`);
  }
  const { assignments, results } = validateWaveResults(
    document,
    routing,
    wave,
    expectedBase,
    context,
  );
  const writer = writerForWave(assignments);
  if (checkpoint.writerTaskId !== (writer?.taskId ?? null)) {
    fail(`wave ${wave.wave} checkpoint writer does not match routing`);
  }
  const comparison = repositoryRevisionComparison(
    context,
    expectedBase,
    checkpoint.completedRevision,
  );
  const changedFiles = normalizedPaths(
    checkpoint.changedFiles,
    `wave ${wave.wave} checkpoint paths`,
    writer !== null,
  );
  if (
    canonicalDigest(changedFiles) !==
      canonicalDigest(comparison.changedPaths) ||
    checkpoint.diffSha256 !== comparison.diffSha256
  ) {
    fail(`wave ${wave.wave} checkpoint does not match its committed Git diff`);
  }
  const writerResult =
    writer === null
      ? null
      : results.find((result) => result.taskId === writer.taskId);
  if (
    writer === null
      ? checkpoint.completedRevision !== expectedBase ||
        changedFiles.length !== 0
      : writerResult === undefined ||
        checkpoint.completedRevision === expectedBase ||
        canonicalDigest(changedFiles) !==
          canonicalDigest([...writerResult.changedFiles].sort(compareCodeUnits))
  ) {
    fail(
      `wave ${wave.wave} committed outcome does not match its writer result`,
    );
  }
  if (writer !== null) {
    assertSingleWriterCommit(
      context,
      expectedBase,
      checkpoint.completedRevision,
    );
    const completedTree = repositoryTree(context, checkpoint.completedRevision);
    assertCheckTrees(writerResult.checks, completedTree, `wave ${wave.wave}`);
    if (writer.provider === "codex") {
      const patchPath = resolve(
        context.runDirectory,
        ...writerResult.patchFile.split("/"),
      );
      assertInside(context.runDirectory, patchPath, "proposal patch file");
      assertPatchProducesTree(
        context,
        patchPath,
        expectedBase,
        checkpoint.completedRevision,
      );
    }
  }
  if (
    checkpoint.resultsSha256 !== canonicalDigest(results) ||
    checkpoint.checksSha256 !== canonicalDigest(writerResult?.checks ?? [])
  ) {
    fail(
      `wave ${wave.wave} checkpoint digests do not match execution evidence`,
    );
  }
  assertIsoDate(checkpoint.verifiedAt, `wave ${wave.wave}.verifiedAt`);
  return checkpoint.completedRevision;
}

function validateHistory(document, routing, waves, context) {
  if (
    document.completedWaves.length !== document.checkpoints.length ||
    document.completedWaves.some((wave, index) => wave !== index + 1)
  ) {
    fail("execution completed waves are not canonical");
  }
  let expectedBase = document.routingRevision;
  for (const [index, completedWave] of document.completedWaves.entries()) {
    const wave = waves[index];
    const checkpoint = document.checkpoints[index];
    if (wave === undefined || wave.wave !== completedWave) {
      fail("execution history does not match routed waves");
    }
    expectedBase = validateCheckpoint(
      checkpoint,
      wave,
      routing,
      document,
      expectedBase,
      context,
    );
  }
  const lastCompletedWave = document.completedWaves.at(-1);
  if (lastCompletedWave !== undefined) {
    assertAggregateWriterReceiptLimit(document, routing, lastCompletedWave);
  }
  validateDependencyOrder(document, routing);
  return expectedBase;
}

function assertExactResultSet(document, routing, maximumWave) {
  const expectedIds = routing.assignments
    .filter((assignment) => assignment.wave <= maximumWave)
    .map((assignment) => assignment.taskId)
    .sort(compareCodeUnits);
  const resultIds = document.results
    .map((result) => result.taskId)
    .sort(compareCodeUnits);
  if (
    new Set(resultIds).size !== resultIds.length ||
    canonicalDigest(resultIds) !== canonicalDigest(expectedIds)
  ) {
    fail(
      "execution results contain missing, duplicate, future, or unknown tasks",
    );
  }
  const canonicalResults = [...document.results].sort(
    (left, right) =>
      left.wave - right.wave || compareCodeUnits(left.taskId, right.taskId),
  );
  if (canonicalDigest(document.results) !== canonicalDigest(canonicalResults)) {
    fail("execution results must be stored in canonical wave and task order");
  }
  const jobIds = document.results
    .filter((result) => result.jobId !== undefined)
    .map((result) => result.jobId);
  if (new Set(jobIds).size !== jobIds.length) {
    fail("execution results repeat a Codex job id");
  }
  const patchFiles = document.results
    .filter((result) => result.patchFile !== undefined)
    .map((result) => result.patchFile);
  if (new Set(patchFiles).size !== patchFiles.length) {
    fail("execution results repeat a proposal patch file");
  }
}

function prepare(runId, context, routing, routingPath, waves, path) {
  assertCleanWorkflowWorktree(context);
  const head = currentGitRevision(context);
  if (head !== routing.revision?.head) {
    fail("execution must start from the exact approved routing revision");
  }
  const firstWave = waves[0];
  writeJsonAtomic(path, {
    schemaVersion: 1,
    kind: "execution",
    runId,
    mode: "wave-ordered",
    state: "active",
    routingSha256: fileDigest(routingPath, "routing evidence"),
    routingRevision: head,
    activeWave: {
      wave: firstWave.wave,
      baselineRevision: head,
      startedAt: new Date().toISOString(),
    },
    completedWaves: [],
    results: [],
    checkpoints: [],
    preparedAt: new Date().toISOString(),
    completedAt: null,
  });
  printSuccess({
    runId,
    state: "active",
    wave: firstWave.wave,
    taskIds: firstWave.taskIds,
    complete: false,
  });
}

function verifyWave(runId, context, routing, waves, document, path) {
  if (document.state !== "active") {
    fail("execution has no active wave to verify");
  }
  const expectedBase = validateHistory(document, routing, waves, context);
  const index = document.completedWaves.length;
  const wave = waves[index];
  if (
    wave === undefined ||
    document.activeWave?.wave !== wave.wave ||
    document.activeWave?.baselineRevision !== expectedBase
  ) {
    fail("active execution wave does not follow the verified history");
  }
  assertIsoDate(document.activeWave.startedAt, "active wave startedAt");
  assertExactResultSet(document, routing, wave.wave);
  const { assignments, results } = validateWaveResults(
    document,
    routing,
    wave,
    expectedBase,
    context,
  );
  assertAggregateWriterReceiptLimit(document, routing, wave.wave);
  validateDependencyOrder(document, routing);
  assertCleanWorkflowWorktree(context);
  const completedRevision = currentGitRevision(context);
  const comparison = repositoryRevisionComparison(
    context,
    expectedBase,
    completedRevision,
  );
  const writer = writerForWave(assignments);
  const writerResult =
    writer === null
      ? null
      : results.find((result) => result.taskId === writer.taskId);
  if (
    writer === null
      ? completedRevision !== expectedBase ||
        comparison.changedPaths.length !== 0
      : writerResult === undefined ||
        completedRevision === expectedBase ||
        canonicalDigest(comparison.changedPaths) !==
          canonicalDigest([...writerResult.changedFiles].sort(compareCodeUnits))
  ) {
    fail(
      `wave ${wave.wave} requires an exact clean committed outcome for its routed writer`,
    );
  }
  if (writer !== null) {
    assertSingleWriterCommit(context, expectedBase, completedRevision);
    const completedTree = repositoryTree(context, completedRevision);
    assertCheckTrees(writerResult.checks, completedTree, `wave ${wave.wave}`);
    if (writer.provider === "codex") {
      const patchPath = resolve(
        context.runDirectory,
        ...writerResult.patchFile.split("/"),
      );
      assertInside(context.runDirectory, patchPath, "proposal patch file");
      assertPatchProducesTree(
        context,
        patchPath,
        expectedBase,
        completedRevision,
      );
    }
  }
  if (
    writer !== null &&
    comparison.changedPaths.some(
      (changed) => !pathInLease(changed, writer.writePaths),
    )
  ) {
    fail(`wave ${wave.wave} committed a path outside the writer lease`);
  }
  const checkpoint = {
    wave: wave.wave,
    writerTaskId: writer?.taskId ?? null,
    baselineRevision: expectedBase,
    completedRevision,
    changedFiles: comparison.changedPaths,
    diffSha256: comparison.diffSha256,
    resultsSha256: canonicalDigest(results),
    checksSha256: canonicalDigest(writerResult?.checks ?? []),
    verifiedAt: new Date().toISOString(),
  };
  const completedWaves = [...document.completedWaves, wave.wave];
  const checkpoints = [...document.checkpoints, checkpoint];
  const nextWave = waves[index + 1];
  const complete = nextWave === undefined;
  writeJsonAtomic(path, {
    ...document,
    state: complete ? "complete" : "active",
    activeWave: complete
      ? null
      : {
          wave: nextWave.wave,
          baselineRevision: completedRevision,
          startedAt: new Date().toISOString(),
        },
    completedWaves,
    checkpoints,
    completedAt: complete ? new Date().toISOString() : null,
  });
  printSuccess(!complete);
}

function verifyComplete(runId, context, routing, waves, document) {
  if (
    document.state !== "complete" ||
    document.activeWave !== null ||
    document.completedWaves.length !== waves.length
  ) {
    fail("wave-ordered execution is incomplete");
  }
  assertExactResultSet(document, routing, waves.at(-1).wave);
  const finalRevision = validateHistory(document, routing, waves, context);
  assertCleanWorkflowWorktree(context);
  if (currentGitRevision(context) !== finalRevision) {
    fail("repository state changed after the final execution checkpoint");
  }
  assertIsoDate(document.completedAt, "execution completedAt");
  printSuccess({
    runId,
    state: "complete",
    waves: waves.length,
    tasks: document.results.length,
    finalRevision,
  });
}

function verifyHistory(runId, context, routing, waves, document) {
  if (
    document.state !== "complete" ||
    document.activeWave !== null ||
    document.completedWaves.length !== waves.length
  ) {
    fail("wave-ordered execution is incomplete");
  }
  assertExactResultSet(document, routing, waves.at(-1).wave);
  const finalRevision = validateHistory(document, routing, waves, context);
  assertIsoDate(document.completedAt, "execution completedAt");
  printSuccess({
    runId,
    state: "complete",
    historical: true,
    waves: waves.length,
    tasks: document.results.length,
    finalRevision,
  });
}

try {
  const [action, runId] = process.argv.slice(2);
  if (
    !new Set(["prepare", "verify-wave", "verify", "verify-history"]).has(
      action,
    ) ||
    !runId
  ) {
    fail(
      "usage: execution.mjs <prepare|verify-wave|verify|verify-history> <run-id>",
    );
  }
  const context = workflowContext(runId);
  assertStaticRouting(runId);
  const {
    document: routing,
    path: routingPath,
    waves,
  } = loadRouting(context, runId);
  const path = evidencePath(context, "execution");
  if (action === "prepare") {
    prepare(runId, context, routing, routingPath, waves, path);
  } else {
    const document = readJson(path, "execution evidence");
    const routingSha256 = fileDigest(routingPath, "routing evidence");
    assertDocumentIdentity(document, runId, routingSha256);
    if (document.routingRevision !== routing.revision?.head) {
      fail("execution routing revision no longer matches routing evidence");
    }
    if (action === "verify-wave") {
      verifyWave(runId, context, routing, waves, document, path);
    } else if (action === "verify") {
      verifyComplete(runId, context, routing, waves, document);
    } else {
      verifyHistory(runId, context, routing, waves, document);
    }
  }
} catch (error) {
  process.stderr.write(`Wave execution evidence error: ${error.message}\n`);
  process.exitCode = 1;
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
