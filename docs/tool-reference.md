# MCP Tool Reference

All tools return JSON in a text content block and as MCP structured content. If
a request fails validation, policy, lookup, or execution before it can return
its normal payload, the tool sets `isError: true` and returns:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Sanitized explanation"
  }
}
```

`codex_worker_result` also uses `isError: true` for an unsuccessful retrieved
job or SDD gate while preserving the normal structured job/review payload for
diagnosis; see its result semantics below.

Tool calls cannot change server configuration. `cwd` values must resolve inside
the startup allowlist and an existing Git repository.

## `codex_worker_capabilities`

Inspects dependency health and effective non-secret policy. It accepts no input.

The result includes:

- worker, Codex, and Git versions when available;
- Codex required-flag compatibility and login readiness;
- canonical executable paths and allowed roots;
- allowed explicit models;
- proposal availability;
- concurrency and queue limits;
- auth-environment forwarding state;
- stdio transport and process-memory persistence declarations;
- the exact tools registered in this process;
- warnings for unavailable login, incompatible Codex flags, enabled proposals,
  or forwarded auth environment.

This tool runs `codex --version`, `codex --help`, `codex exec --help`,
`git --version`, and `codex login status`. It does not start a model job.

## `codex_worker_workspace`

Resolves a directory and reports proposal preconditions without changing the
repository.

Input:

```json
{
  "cwd": "/absolute/path/inside/an/allowed/repository"
}
```

`cwd` is optional and defaults to the first configured allowed root.

Example result:

```json
{
  "cwd": "/work/project/packages/core",
  "repositoryRoot": "/work/project",
  "revision": "0123456789abcdef0123456789abcdef01234567",
  "clean": true,
  "proposalReady": false,
  "proposalBlockers": ["Proposal mode is disabled at server startup"]
}
```

`proposalReady` means only that the worker's visible preconditions currently
pass. It is not an approval and can become stale immediately.

## `codex_worker_sdd_route`

Validates and routes a bounded task DAG synchronously. It does not start a model
job, read repository files, or change the filesystem.

Input:

```json
{
  "neutralCodexShareBps": 5000,
  "tasks": [
    {
      "id": "plan-contract",
      "effortPoints": 3,
      "risk": "high",
      "authority": "read-only",
      "kind": "planning",
      "eligibleLanes": ["claude-host"]
    },
    {
      "id": "implement-parser",
      "effortPoints": 5,
      "risk": "medium",
      "authority": "write",
      "kind": "implementation",
      "dependencies": ["plan-contract"],
      "writeScopes": ["src/parser", "tests/parser"],
      "preferredLane": "codex"
    },
    {
      "id": "review-parser",
      "effortPoints": 2,
      "risk": "high",
      "authority": "read-only",
      "kind": "review",
      "dependencies": ["implement-parser"]
    }
  ]
}
```

`tasks` contains 1–64 entries. Every task requires:

| Field          | Contract                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | Unique 1–64 character safe identifier.                                                                                                                        |
| `effortPoints` | Integer `1..100`; a planning estimate, not observed tokens, price, or time.                                                                                   |
| `risk`         | `low`, `medium`, `high`, or `critical`.                                                                                                                       |
| `authority`    | `read-only` or `write`. A write task requires `writeScopes`; a read-only task must not declare them.                                                          |
| `kind`         | `analysis`, `planning`, `architecture`, `implementation`, `debugging`, `testing`, `refactor`, `review`, `security-review`, `documentation`, or `integration`. |

Optional `dependencies` must name known tasks and form an acyclic graph.
`writeScopes` are normalized repository-relative paths. `eligibleLanes` is a
hard subset of `codex` and `claude-host`; omitting it allows both.
`preferredLane` is soft: it applies only when both eligible lanes have the same
base task-kind fit. Hard eligibility or stronger fit overrides it.

`neutralCodexShareBps` is an integer `0..10000` and defaults to `5000`. It is
neutral metadata, not a required workload quota. The router evaluates valid
plans in this versioned order:

1. hard eligibility and graph/scope validity;
2. minimum regret against versioned task-kind lane fit;
3. `preferredLane`, only for an exact base-fit tie;
4. absolute estimated-effort deviation from the neutral share;
5. task-count deviation from the same neutral share;
6. at a true neutral 50/50 odd tie, the extra task to Codex;
7. lexical task-ID tie-break.

The result identifies `sdd-routing-v2` and `sdd-task-fit-v1`, preserves its
exact `selectionOrder`, and returns canonical `tasks`, `assignments`, stable
reasons, `balance`, dependency-safe `waves`, and `planFingerprint`. Each
assignment includes `laneFit` and a `decisionStage`: `hard-eligibility`,
`quality-fit`, `preferred-lane-tie-break`, or `neutral-balance`. Balance
evidence includes the actual share, total weighted fit score, decision counts,
and deviations.

`sdd-task-fit-v1` is intentionally small and auditable:

| Task kind                                              | Codex fit | Claude-host fit | Default decision |
| ------------------------------------------------------ | --------- | --------------- | ---------------- |
| `analysis`, `review`, `security-review`, `integration` | 3         | 3               | neutral          |
| `planning`                                             | 1         | 4               | Claude host      |
| `architecture`, `documentation`                        | 2         | 4               | Claude host      |
| `implementation`, `debugging`, `testing`, `refactor`   | 4         | 2               | Codex            |

These are routing policy values, not vendor benchmarks. Changing them requires a
new fit-policy version and regression fixtures. A real capability or safety
constraint belongs in `eligibleLanes`; a preference cannot override stronger
base fit.

A wave may contain ready read-only tasks but at most one writer. The default
50/50 value is consulted only after fit and an applicable preference tie.
Eligibility or fit may produce any actual share, including 100% on one lane; the
router reports it instead of forcing balance.

Stable reason codes include `HARD_ELIGIBILITY`, `QUALITY_FIT_SELECTED`,
`PREFERRED_LANE_TIE_BREAK`, `PREFERRED_LANE_INELIGIBLE`,
`PREFERRED_LANE_OVERRIDDEN_BY_FIT`, `NEUTRAL_EFFORT_BALANCE`,
`NEUTRAL_TASK_COUNT_BALANCE`, `ODD_NEUTRAL_TIE_TO_CODEX`, `LEXICAL_TIE_BREAK`,
and `SINGLE_WRITER_WAVE`.

Risk does not bias lane fit. The optional workflow treats `critical` as a
cross-provider review and explicit profile requirement instead.

`claude-host` means the current Claude Code session and its selected model. This
tool never selects, invokes, or verifies a Claude model.

### Profiled routing

Adding `projectProfile` dispatches to the separate `routeProfiledSddTasks`
contract. The profile must satisfy the strict project profile schema; unknown
fields fail. Omitting it still returns the unchanged schema-version-1
`sdd-routing-v2` plan and legacy fingerprint.

```json
{
  "projectProfile": {
    "schemaVersion": 1,
    "profileId": "reviewed-project-policy",
    "profileVersion": "1.0.0",
    "laneCapabilities": {
      "codex": [{ "id": "general-engineering", "score": 2 }],
      "claude-host": [{ "id": "general-engineering", "score": 2 }]
    },
    "taskPolicies": [
      {
        "kind": "analysis",
        "requirements": [
          {
            "capabilityId": "general-engineering",
            "minimumScore": 1,
            "weight": 1
          }
        ]
      }
    ],
    "checkProfiles": [],
    "codexPolicy": {
      "default": { "model": null, "reasoningEffort": null }
    },
    "writePolicy": {
      "allowedRoots": [],
      "additionalDeniedRoots": []
    }
  },
  "tasks": [
    {
      "id": "inspect-contract",
      "effortPoints": 2,
      "risk": "medium",
      "authority": "read-only",
      "kind": "analysis"
    }
  ]
}
```

Profiled output uses schema version `2`, routing policy `sdd-routing-v3`, and
fit policy `sdd-capability-fit-v1`. It adds:

- `projectProfile` identity plus the normalized content fingerprint;
- fixed executor descriptors that preserve the Claude Code host and local Codex
  worker roles;
- explicit and capability-effective eligible lanes, weighted fit, requirements,
  and decision stage per assignment;
- required check IDs, working directories, and canonical command digests for
  matching write tasks;
- resolved Codex execution/cross-review policy and whether a server allowlist is
  required; and
- a plan fingerprint binding those projections, tasks, waves, and policy
  versions.

Hard task eligibility precedes capability minimums and fit. Required checks are
evidence descriptors and are never executed by this tool. Write policy can only
narrow task scopes. A non-null resolved Codex model must be present in the
running server's `CCW_ALLOWED_MODELS`; otherwise the MCP request fails before a
plan is returned. This check is server-owned—calling the pure TypeScript router
directly only reports `serverAllowlistRequired`.

The profile fingerprint is a content address, not a signature or approval. Read
[Portable project profiles](project-profiles.md) for the full contract, threat
boundary, CLI template/validation workflow, and safe adoption checklist.

## `codex_worker_sdd_review`

Freezes already-completed host evidence, seals exact repository artifacts, and
queues a fresh schema-constrained Codex review. It uses the existing
status/result/cancel/list lifecycle.

Input:

```json
{
  "phase": "plan",
  "mode": "strict",
  "artifactPaths": ["specs/001-example/spec.md", "specs/001-example/plan.md"],
  "expectedRevision": "0123456789abcdef0123456789abcdef01234567",
  "hostReview": {
    "reviewId": "host-plan-review-v1",
    "verdict": "approved",
    "summary": "Requirements and architecture boundaries are covered.",
    "findings": []
  },
  "focus": "Check requirement coverage, boundaries, and verification.",
  "reasoningEffort": "high",
  "timeoutMs": 600000,
  "idempotencyKey": "plan-review-01234567"
}
```

| Field              | Required | Contract                                                                                                                                    |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `phase`            | Yes      | `plan`, `artifacts`, `implementation`, or `convergence`.                                                                                    |
| `mode`             | Yes      | `strict` or `draft`. Draft evidence is advisory and never passes the gate.                                                                  |
| `artifactPaths`    | Yes      | 1–64 safe repository-relative regular files; no symlinks, traversal, `.git` segment, absolute path, or drive path.                          |
| `expectedRevision` | Strict   | Exact 40- or 64-character Git object ID. It is optional for a draft but must match when supplied.                                           |
| `hostReview`       | Yes      | Frozen host `reviewId`, verdict, bounded summary, and up to 100 structured findings. Optional model labels are host-declared metadata only. |
| `focus`            | No       | Neutral bounded review focus. Do not copy host conclusions into it.                                                                         |
| Runtime fields     | No       | `cwd`, explicit allowlisted Codex `model`, `reasoningEffort`, `timeoutMs`, and `idempotencyKey` follow normal read-only job policy.         |

Each finding needs `id`, `severity`, `requirement`, `summary`, `artifactPath`,
optional `line`, and `nextAction`. `changes-requested` evidence must contain at
least one finding. A finding must refer to a reviewed artifact.

Strict preparation requires a clean tree and binds the exact Git revision,
workspace fingerprint, canonical artifact paths, sizes, and SHA-256 digests to
one `sealId`. BoundedRelay validates and hashes the host review before Codex
starts, but does not include its summary or findings in the Codex prompt. In
strict mode, Codex reads a detached origin-free local clone proven to match the
seal, with hooks disabled. It runs fresh with `read-only`, approval policy
`never`, ephemeral state, and the packaged JSON output schema. Draft mode stays
in the source checkout and cannot approve a gate.

The initial response is a job snapshot. Its optional `sddReview` projection
contains only phase, mode, seal ID, and host-evidence digest. At terminal state,
`codex_worker_result` adds `review` with the seal, normalized host and Codex
evidence, and:

```json
{
  "gate": {
    "passed": true,
    "status": "ready",
    "sealId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "reasons": [],
    "freshnessReasons": [],
    "evidenceDigests": {
      "host": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "codex": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    }
  }
}
```

Only `passed: true` with `status: "ready"` on a strict seal satisfies the gate.
A completed job can legitimately return `blocked` or `stale`; retrieving either
result sets MCP `isError: true` while retaining the complete review artifact.
Changing HEAD, clean state, or one reviewed byte invalidates the gate. Generic
`codex_worker_analyze` output cannot substitute for this artifact.

## `codex_worker_analyze`

Queues a read-only job and returns its snapshot immediately.

Input fields:

| Field             | Required | Contract                                                                        |
| ----------------- | -------- | ------------------------------------------------------------------------------- |
| `task`            | Yes      | Non-empty bounded objective, up to `CCW_MAX_TASK_CHARS`.                        |
| `cwd`             | No       | Existing directory inside an allowed Git repository.                            |
| `model`           | No       | Must be present in `CCW_ALLOWED_MODELS`; omit to use Codex's effective default. |
| `reasoningEffort` | No       | `low`, `medium`, `high`, `xhigh`, `max`, or `ultra`.                            |
| `timeoutMs`       | No       | Integer `1000..CCW_MAX_TIMEOUT_MS`; defaults to `CCW_DEFAULT_TIMEOUT_MS`.       |
| `idempotencyKey`  | No       | 1–128 characters matching the worker's conservative identifier format.          |

Example:

```json
{
  "task": "Review the parser for state-machine bugs. Do not propose edits.",
  "cwd": "/work/project",
  "reasoningEffort": "high",
  "timeoutMs": 600000,
  "idempotencyKey": "parser-review-2026-08-27"
}
```

An idempotency key returns the existing job only when the complete normalized
request fingerprint matches. Reusing it for another request fails with
`DUPLICATE_IDEMPOTENCY_KEY`.

## `codex_worker_propose`

Registered only when `CCW_ENABLE_PROPOSALS=true`. It queues a proposal in a
disposable clone; it never edits the source repository.

It accepts all analyze fields plus:

| Field              | Required | Contract                                                                                                                                              |
| ------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `writePaths`       | Yes      | One or more normalized repository-relative path scopes. Absolute paths, `..`, protected paths, empty segments, and drive-prefixed paths are rejected. |
| `expectedRevision` | Yes      | Exact 40- or 64-character Git object ID from `codex_worker_workspace`.                                                                                |

Example:

```json
{
  "task": "Propose the smallest fix for the parser race and update its focused tests.",
  "cwd": "/work/project",
  "writePaths": ["src/parser", "tests/parser"],
  "expectedRevision": "0123456789abcdef0123456789abcdef01234567",
  "reasoningEffort": "high",
  "timeoutMs": 900000,
  "idempotencyKey": "parser-race-proposal-v1"
}
```

Submission does not prove that a patch will be accepted. Clean-tree, revision,
submodule, lease, ref, changed-path, symlink, file-count, and patch-size
validation occur during execution and finalization.

Protected paths include any `.git` segment, `.gitmodules`, `.npmrc`, `.pypirc`,
`credentials.json`, `id_rsa`, `id_ed25519`, private `.env`/`.env.*` files,
`*.pem`, and `*.key`. The explicit templates `.env.example`, `.env.sample`, and
`.env.template` are allowed.

## `codex_worker_status`

Returns the current public snapshot, including sanitized live activity. Use
`afterRevision` with `waitMs` to wait only when the caller has already observed
the current revision.

```json
{
  "jobId": "00000000-0000-4000-8000-000000000000",
  "afterRevision": 14,
  "waitMs": 10000
}
```

| Field           | Required | Contract                                                                                                |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `jobId`         | Yes      | Existing job UUID from analyze, SDD review, or propose.                                                 |
| `afterRevision` | No       | A previously observed positive revision. A stale value returns immediately; the current value may wait. |
| `waitMs`        | No       | `0..30000`, default `0`. Maximum time to wait for a newer revision.                                     |

A future or otherwise unobserved `afterRevision` fails with `INVALID_REQUEST`.
Waiting ends on the next material update, terminal state, or timeout. Timing
fields are computed when the snapshot is returned and may advance without
incrementing `revision`.

This is bounded long-polling, not a completion estimate. The worker never
returns a percentage or ETA.

## `codex_worker_result`

Returns `{ "ready": false, "job": ... }` while a job is non-terminal. Terminal
jobs return the snapshot and available final message or failure information. The
MCP outcome is classified from that payload:

- non-terminal retrieval remains `isError: false`;
- a successfully completed ordinary job remains `isError: false`;
- a completed SDD review is successful only when `review.gate.passed` is exactly
  `true`; and
- a `failed` or `cancelled` job, or a completed SDD review whose gate did not
  pass, sets `isError: true`.

Semantic failure does not replace the result with a generic error object. The
response retains `ready`, the complete public `job` snapshot, and any available
`finalMessage`, `proposal`, or `review`, so callers can report the actual
failed, cancelled, blocked, or stale outcome.

A failed job that salvaged a partial final message returns it with
`finalMessagePartial: true` and a server-owned `notice` so it cannot be mistaken
for a complete result; the snapshot additionally reports
`partialResultAvailable: true` and the failure may carry numeric `diagnostics`
(stop reason, exit code, event and command counters, byte counts, elapsed time).
When the job's Codex session is recorded — `persistSession` was true or the job
resumed an earlier session — the result adds a `resumeHint` and the snapshot
marks `sessionPersisted: true`; pass `job.sessionId` as `resumeSessionId` on a
follow-up job to continue that thread sequentially.

An SDD review result also includes the validated `review` artifact described
above. `finalMessage` is its normalized Codex summary. Gate readiness comes from
`review.gate`, not from job completion or the summary text.

```json
{
  "jobId": "00000000-0000-4000-8000-000000000000",
  "includePatch": false
}
```

`includePatch` defaults to `false`. For a proposal, the normal result includes:

- `effect`: `none` or `proposal`; validation rejection fails the job with a
  typed error instead of returning an artifact;
- exact `baselineRevision`;
- validated `changedFiles`;
- `patchBytes`;
- `patchSha256` when a patch exists;
- `patchAvailable`.

Only `includePatch=true` adds the patch string. Requesting it does not apply it.

## `codex_worker_cancel`

Cancels a queued or running job:

```json
{
  "jobId": "00000000-0000-4000-8000-000000000000"
}
```

Queued jobs become `cancelled`. Running jobs receive graceful process-tree
termination followed by a forced kill after `CCW_CANCEL_GRACE_MS`. Repeating
cancellation for a terminal job returns its existing snapshot.

## `codex_worker_list`

Lists the bounded in-memory history.

```json
{
  "status": "failed",
  "limit": 20
}
```

Both fields are optional. `status` is one of `queued`, `running`, `completed`,
`failed`, or `cancelled`; `limit` is `1..100` and defaults to `20`.

The result is an object with a `jobs` array:

```json
{
  "jobs": []
}
```

## Public job snapshot

```json
{
  "id": "00000000-0000-4000-8000-000000000000",
  "revision": 4,
  "status": "running",
  "mode": "analyze",
  "cwd": "/work/project",
  "repositoryRoot": "/work/project",
  "createdAt": "2026-08-27T12:00:00.000Z",
  "startedAt": "2026-08-27T12:00:00.100Z",
  "progress": {
    "phase": "working",
    "activity": "running_command",
    "activityLabel": "Codex is running a sandboxed command",
    "eventCount": 5,
    "commandCount": 1,
    "messageCount": 0,
    "lastEventType": "item.started",
    "updatedAt": "2026-08-27T12:00:03.500Z",
    "elapsedMs": 3600,
    "sinceLastUpdateMs": 200
  },
  "resultAvailable": false,
  "resultTruncated": false
}
```

`codex_worker_capabilities` additionally reports `buildId`, the running worker
module's build fingerprint. The package version is a frozen constant, so
`buildId` is the field that reveals a long-lived server still running code from
before a rebuild.

Optional fields appear only when relevant: `writePaths`, `expectedRevision`,
`model`, `reasoningEffort`, `idempotencyKey`, `completedAt`, `queuePosition`,
`sessionId`, `sessionPersisted`, `usage`, `partialResultAvailable`, `sddReview`,
and `error`. `sddReview` exposes the review phase, mode, seal ID, and frozen
host-evidence digest without raw findings. `queuePosition` is one-based and
appears only while queued. `error.diagnostics`, when present, contains only
server-derived numbers and fixed enums.

The `revision` is an in-memory job-update counter, not a Git revision. Progress
phases are `queued`, `starting`, `working`, `finalizing`, and `terminal`.

### Activity vocabulary

Every `activityLabel` comes from a fixed server map. The value summarizes the
observed lifecycle category; it is not private reasoning content or proof that
the underlying operation succeeded.

| `activity`                   | Public label                                   |
| ---------------------------- | ---------------------------------------------- |
| `queued`                     | Waiting for an available worker slot           |
| `starting`                   | Starting the bounded job                       |
| `preparing_workspace`        | Preparing the isolated proposal workspace      |
| `preparing_review_workspace` | Preparing the detached strict-review workspace |
| `codex_started`              | Codex started                                  |
| `reasoning`                  | Codex is reasoning                             |
| `planning`                   | Codex is updating its plan                     |
| `running_command`            | Codex is running a sandboxed command           |
| `command_completed`          | Codex completed a command                      |
| `preparing_changes`          | Codex is preparing isolated changes            |
| `using_tool`                 | Codex is using a tool                          |
| `researching`                | Codex is researching                           |
| `working`                    | Codex is working                               |
| `composing_response`         | Codex is composing the response                |
| `response_ready`             | Codex produced a response                      |
| `validating_proposal`        | Validating the isolated patch                  |
| `validating_review`          | Validating the structured independent review   |
| `completed`                  | Job completed                                  |
| `failed`                     | Job failed                                     |
| `cancelled`                  | Job cancelled                                  |

`lastEventType` is an allowlisted, normalized event identifier. Every
unrecognized identifier becomes `unknown`; unsafe session identifiers are
omitted. Raw JSONL event payloads, command text, tool arguments, and
event-derived paths are never part of the public snapshot.

## Error codes

| Code                        | Meaning                                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `CANCELLED`                 | The job was cancelled.                                                                                    |
| `CODEX_INCOMPATIBLE`        | The installed Codex CLI does not advertise every required non-interactive flag. `serve` refuses to start. |
| `CODEX_NOT_FOUND`           | The configured Codex executable could not be resolved or started.                                         |
| `CONFIG_INVALID`            | Startup configuration violates syntax or security policy.                                                 |
| `DUPLICATE_IDEMPOTENCY_KEY` | A key is already bound to another normalized request.                                                     |
| `INTERNAL_ERROR`            | An unexpected worker error occurred.                                                                      |
| `INVALID_PATH`              | A path is missing, unsafe, symlinked, outside policy, or outside its proposal scope.                      |
| `INVALID_REQUEST`           | Tool input violates the job contract.                                                                     |
| `JOB_NOT_FOUND`             | The job is absent or was evicted from in-memory history.                                                  |
| `LEASE_CONFLICT`            | Another proposal worker holds the repository lease.                                                       |
| `OUTPUT_LIMIT_EXCEEDED`     | Codex stdout/stderr exceeded the configured byte limit.                                                   |
| `PATCH_LIMIT_EXCEEDED`      | Proposal file count or patch bytes exceeded policy.                                                       |
| `PROPOSALS_DISABLED`        | Proposal mode is not enabled. Normally the tool is not registered.                                        |
| `PROTOCOL_ERROR`            | Codex emitted malformed/incomplete JSONL or Git produced inconsistent artifact data.                      |
| `QUEUE_FULL`                | The bounded job queue is full.                                                                            |
| `REVISION_MISMATCH`         | Source or isolated checkout does not match `expectedRevision`.                                            |
| `REVIEW_INVALID`            | SDD review input, artifact, decision, evidence, or seal failed strict validation.                         |
| `RUNTIME_FAILED`            | Codex, Git, proposal, or review finalization failed.                                                      |
| `SUBMODULES_UNSUPPORTED`    | Proposal or isolated strict-review mode found `.gitmodules`.                                              |
| `TIMEOUT`                   | Codex exceeded the job timeout.                                                                           |
| `WORKTREE_DIRTY`            | Proposal or strict-review isolation requires a clean source worktree.                                     |

Messages are intentionally sanitized and bounded. Use local diagnostics and a
minimal reproduction rather than exposing secrets in a public issue.
