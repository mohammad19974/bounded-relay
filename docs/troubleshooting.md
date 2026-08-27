# Troubleshooting

Start with non-secret diagnostics:

```bash
boundedrelay doctor
boundedrelay config
boundedrelay sdd validate
claude mcp list
```

Inside Claude Code, use `/mcp` to inspect the connection. Never paste provider
tokens, Codex auth files, private prompts, source code, or full event streams
into a public issue.

## Server does not connect

### `spawn node ENOENT` or `spawn ... ENOENT`

- Use an absolute path to `dist/cli.js`.
- Confirm `node` is available in the environment that starts Claude Code.
- Run `node /absolute/path/to/dist/cli.js doctor` directly.
- Rebuild with `npm run build` after changing source.

Relative paths resolve from Claude Code's launch context, not necessarily the
worker clone.

### Server starts and disconnects immediately

Run `doctor` outside MCP. Typical startup failures include:

- `CCW_STATE_DIR` is a home directory, filesystem root, symlink, or overlaps an
  allowed root;
- `CCW_ALLOWED_ROOTS` points to a missing, overly broad, or symlink directory;
- Codex or Git is missing or not executable;
- an integer or boolean environment value is invalid;
- the worker detected recursive delegation.

MCP protocol output must remain on stdout. If a local modification added
`console.log`, remove it or redirect diagnostics to stderr.

## `CODEX_NOT_FOUND`

Run `codex --version` in the same terminal environment. If Claude Code has a
different `PATH`, set `CCW_CODEX_BIN` to a reviewed absolute executable path in
the MCP server environment.

Do not point it at a shell script that interprets task data. The worker expects
an executable that implements the Codex CLI contract.

## `CODEX_INCOMPATIBLE`

The worker found Codex but its global or `exec` help does not advertise every
flag this release requires. Run:

```bash
codex --version
codex --help
codex exec --help
boundedrelay doctor
```

Upgrade or select a compatible Codex CLI, then restart the MCP server. Do not
shim missing flags or remove the worker's sandbox/config flags merely to bypass
the startup check.

## Authentication warning or failed login check

Run:

```bash
codex login
codex login status
```

The normal saved login is discovered through `HOME` and `CODEX_HOME`. Avoid
`CCW_FORWARD_AUTH_ENV=true` unless the deployment intentionally authenticates
through environment tokens. The worker does not perform login inside MCP.

## `INVALID_PATH`

Check that:

- `cwd` exists and is a real directory, not a symlink;
- it is inside a specific `CCW_ALLOWED_ROOTS` entry;
- the resolved Git root is also within the allowed root;
- proposal write paths are repository-relative, use `/`, and contain no empty,
  `.`, `..`, drive, or protected segment/name;
- a proposed changed file is under at least one requested path and is not a
  symlink.

Protected proposal paths include `.git`, `.gitmodules`, `.npmrc`, `.pypirc`,
`credentials.json`, `id_rsa`, `id_ed25519`, private `.env`/`.env.*` files,
`*.pem`, and `*.key`. Safe template files `.env.example`, `.env.sample`, and
`.env.template` are allowed.

Use `codex_worker_workspace` to see the canonical paths the worker recognizes.

## Proposal tool is missing

This is expected unless the MCP server process started with:

```text
CCW_ENABLE_PROPOSALS=true
```

Environment changes require restarting or re-registering the server. Check
`codex_worker_capabilities`; its `tools` list is authoritative for the running
process.

## SDD integration files are missing or invalid

Run:

```bash
boundedrelay sdd validate
boundedrelay sdd path
```

The first command validates the packaged file structure; the second prints the
exact integration root used by this build. If either fails after a source
change, rebuild and inspect the packed artifact. Do not copy an unrelated
`.specify/` directory as a replacement.

This check does not invoke Claude Code. On a host with Claude installed, also
run:

```bash
INTEGRATION_ROOT="$(boundedrelay sdd path)"
claude plugin validate "$INTEGRATION_ROOT/claude-code-plugin"
```

If local plugin loading remains unavailable, use the direct MCP registration in
the [getting-started guide](getting-started.md).

## SDD route request is rejected

Check that task IDs are unique and safe, dependencies name known tasks and are
acyclic, effort is an integer `1..100`, and every task uses a supported risk,
authority, and kind. Read-only tasks must not declare write scopes; write tasks
must declare safe repository-relative scopes. Use `neutralCodexShareBps`, not
the removed target/quota field.

The default 5,000-basis-point value is neutral metadata. `sdd-routing-v2` puts
hard eligibility and versioned task-kind fit first, so a 100% assignment to one
lane can be valid. Risk does not bias the lane; critical risk is handled by the
optional workflow's cross-provider review/profile policy.

## `REVIEW_INVALID`

The specialized SDD review rejected an input, artifact, seal, or structured
Codex decision. Common causes are:

- unsafe, duplicate, missing, symlinked, non-regular, or oversized artifacts;
- dirty strict-mode worktree or missing full `expectedRevision`;
- malformed, fenced, oversized, or schema-invalid Codex JSON;
- duplicate finding IDs or a `changes-requested` verdict with no finding;
- a finding outside the sealed artifact set.

Do not replace `codex_worker_sdd_review` with generic analysis; it cannot
satisfy a strict gate. Correct the evidence or checkout, then submit a fresh
review.

## Review completed but the gate is blocked or stale

Job completion means BoundedRelay parsed and evaluated the review, not that the
gate approved. Continue only for a strict result with `gate.passed: true` and
`gate.status: "ready"`.

- `blocked` means evidence was valid enough to evaluate but a reviewer requested
  changes or the two evidence records did not satisfy one gate.
- `stale` means HEAD, clean state, workspace fingerprint, or reviewed artifact
  content changed.

Resolve findings, create a new authorized clean checkpoint, freeze a new Claude
host review, and start a fresh Codex review. Never edit the old seal or replay
old evidence.

## Critical `gpt-5.6-sol` / `ultra` profile fails

The optional workflow requires this explicit profile for its critical-task Codex
lane. Confirm `gpt-5.6-sol` is in `CCW_ALLOWED_MODELS` and that the local Codex
CLI/account supports `ultra`. If the provider rejects it, the job must fail;
BoundedRelay does not silently downgrade or change the Claude host model.

## `WORKTREE_DIRTY`

Proposal mode requires a clean source worktree, including no untracked files,
because the binary patch must target one exact committed revision. Review and
resolve the source state yourself. The worker will not stash, discard, commit,
or copy uncommitted changes.

Analyze mode and draft SDD review remain available for dirty repositories, but
neither a draft nor generic analysis can satisfy a strict review gate.

## `REVISION_MISMATCH`

Call `codex_worker_workspace` again and compare its `revision` to
`expectedRevision`. Do not shorten the object ID. If `HEAD` changed, decide
whether the task, reviewed artifacts, and write-path scope are still valid
before submitting a new review or proposal.

## `SUBMODULES_UNSUPPORTED`

Proposal mode and isolated strict SDD review refuse any repository with
`.gitmodules` in v0.1. Use read-only analysis or draft advisory review, or
create a separate disposable repository without submodules outside this worker.
Do not remove project submodule configuration merely to bypass the check.

## `LEASE_CONFLICT`

Another proposal worker using the same state directory holds the repository
lease. Wait for it or cancel it through its owning server. A stale lease is
recovered only when its recorded process is no longer alive.

Do not delete locks while a worker may be running. Workers with different state
directories do not share leases, so use one state directory for coordinated
local proposal processes.

## `QUEUE_FULL`

Wait for active jobs, cancel work no longer needed, or raise `CCW_MAX_QUEUED`
within its documented range after evaluating local resource use. Starting more
server processes bypasses the per-process queue limit and is not equivalent to
increasing it safely.

## A running job looks frozen

Use `codex_worker_status` with the last observed `revision` as `afterRevision`
and a bounded `waitMs` such as `10000`. Inspect `progress.activityLabel`,
`elapsedMs`, `sinceLastUpdateMs`, `eventCount`, and `commandCount`.

An unchanged revision means the worker has not observed another material Codex
event; it does not prove a crash. A growing `sinceLastUpdateMs` is a factual
silent-duration signal, not an ETA. Check the configured timeout before
cancelling. BoundedRelay intentionally does not expose raw commands, tool
arguments, private reasoning, a guessed percentage, or a completion estimate.

## `TIMEOUT`

The subprocess exceeded the job timeout. Increase the per-job `timeoutMs` only
up to `CCW_MAX_TIMEOUT_MS`, narrow the task, or split analysis into bounded
jobs. A timeout is not proof that Codex was frozen.

## `OUTPUT_LIMIT_EXCEEDED`

Combined Codex stdout and stderr exceeded `CCW_MAX_OUTPUT_BYTES`. Narrow the
task before increasing the limit. Large output enters local process memory and
may later enter Claude Code context.

## `PATCH_LIMIT_EXCEEDED`

The proposal changed too many files or produced a patch larger than policy.
Narrow `writePaths` and the task. Raising limits increases memory and review
risk; the worker will not split or apply a patch automatically.

## `PROTOCOL_ERROR`

Codex emitted malformed or incomplete JSONL, exited without a terminal
event/final message, or Git reported inconsistent artifact data. Record
sanitized Codex and worker versions, reproduce with a fake repository, and check
[Compatibility](compatibility.md).

## Result says ready but no patch is shown

This is the safe default. First inspect `changedFiles`, `patchBytes`,
`patchSha256`, and `patchAvailable`. Call `codex_worker_result` again with
`includePatch=true` only when the patch may safely enter Claude Code context.

`effect: "none"` means the isolated run produced no changed files.

## Job disappeared

Jobs are in memory only. They disappear when:

- the stdio server restarts or exits;
- terminal history exceeds `CCW_MAX_HISTORY` and older jobs are evicted.

This release has no recovery command or audit ledger. Re-submit with a new
idempotency key after confirming that no proposal process is still active.
