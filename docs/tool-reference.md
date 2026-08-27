# MCP Tool Reference

All tools return JSON in a text content block and as MCP structured content. On
failure, the tool sets `isError: true` and returns:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Sanitized explanation"
  }
}
```

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

## `codex_worker_analyze`

Queues a read-only job and returns its snapshot immediately.

Input fields:

| Field             | Required | Contract                                                                        |
| ----------------- | -------- | ------------------------------------------------------------------------------- |
| `task`            | Yes      | Non-empty bounded objective, up to `CCW_MAX_TASK_CHARS`.                        |
| `cwd`             | No       | Existing directory inside an allowed Git repository.                            |
| `model`           | No       | Must be present in `CCW_ALLOWED_MODELS`; omit to use Codex's effective default. |
| `reasoningEffort` | No       | `low`, `medium`, `high`, `xhigh`, or `max`.                                     |
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
| `jobId`         | Yes      | Existing job UUID from analyze or propose.                                                              |
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
jobs return the snapshot and available final message or failure information.

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

Optional fields appear only when relevant: `writePaths`, `expectedRevision`,
`model`, `reasoningEffort`, `idempotencyKey`, `completedAt`, `queuePosition`,
`sessionId`, `usage`, and `error`. `queuePosition` is one-based and appears only
while queued.

The `revision` is an in-memory job-update counter, not a Git revision. Progress
phases are `queued`, `starting`, `working`, `finalizing`, and `terminal`.

### Activity vocabulary

Every `activityLabel` comes from a fixed server map. The value summarizes the
observed lifecycle category; it is not private reasoning content or proof that
the underlying operation succeeded.

| `activity`            | Public label                              |
| --------------------- | ----------------------------------------- |
| `queued`              | Waiting for an available worker slot      |
| `starting`            | Starting the bounded job                  |
| `preparing_workspace` | Preparing the isolated proposal workspace |
| `codex_started`       | Codex started                             |
| `reasoning`           | Codex is reasoning                        |
| `planning`            | Codex is updating its plan                |
| `running_command`     | Codex is running a sandboxed command      |
| `command_completed`   | Codex completed a command                 |
| `preparing_changes`   | Codex is preparing isolated changes       |
| `using_tool`          | Codex is using a tool                     |
| `researching`         | Codex is researching                      |
| `working`             | Codex is working                          |
| `composing_response`  | Codex is composing the response           |
| `response_ready`      | Codex produced a response                 |
| `validating_proposal` | Validating the isolated patch             |
| `completed`           | Job completed                             |
| `failed`              | Job failed                                |
| `cancelled`           | Job cancelled                             |

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
| `RUNTIME_FAILED`            | Codex, Git, or proposal finalization failed.                                                              |
| `SUBMODULES_UNSUPPORTED`    | Proposal mode found `.gitmodules`.                                                                        |
| `TIMEOUT`                   | Codex exceeded the job timeout.                                                                           |
| `WORKTREE_DIRTY`            | Proposal mode requires a clean source worktree.                                                           |

Messages are intentionally sanitized and bounded. Use local diagnostics and a
minimal reproduction rather than exposing secrets in a public issue.
