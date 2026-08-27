# Troubleshooting

Start with non-secret diagnostics:

```bash
boundedrelay doctor
boundedrelay config
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

## `WORKTREE_DIRTY`

Proposal mode requires a clean source worktree, including no untracked files,
because the binary patch must target one exact committed revision. Review and
resolve the source state yourself. The worker will not stash, discard, commit,
or copy uncommitted changes.

Analyze mode remains available for dirty repositories.

## `REVISION_MISMATCH`

Call `codex_worker_workspace` again and compare its `revision` to
`expectedRevision`. Do not shorten the object ID. If `HEAD` changed, decide
whether the task and write-path scope are still valid before submitting a new
proposal.

## `SUBMODULES_UNSUPPORTED`

Proposal mode refuses any repository with `.gitmodules` in v0.1. Use read-only
analysis, or create a separate disposable repository without submodules outside
this worker. Do not remove project submodule configuration merely to bypass the
check.

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
