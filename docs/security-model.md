# Security Model

This document describes what BoundedRelay v0.1 enforces, what it delegates to
Codex and the operating system, and what remains the user's responsibility.

## Trust boundaries

### Trusted

- the local operating-system account running Claude Code;
- the installed worker package or reviewed local checkout;
- the configured Codex and Git executables after canonical resolution;
- explicit environment configuration supplied when the MCP server starts;
- the selected allowed project roots.

### Untrusted or potentially adversarial

- task text generated or forwarded by a model;
- repository content, including agent instructions and build scripts;
- Codex model output and JSONL event payloads;
- a proposed patch;
- project-scoped MCP configuration from a repository not yet trusted;
- paths, model identifiers, revisions, idempotency keys, and limits received
  through MCP.
- task-graph metadata, effort estimates, host review evidence, reviewed
  artifacts, and run-local workflow evidence.

The task body supplies an objective only. The worker-generated prompt places
authority and hard constraints outside that body; task text cannot enable
proposals, widen paths, change the sandbox, forward secrets, or authorize remote
actions.

## Enforced controls

### Process execution

- Executables are resolved and canonicalized before use.
- Codex is launched with an argument array and `shell: false`.
- Task text is sent over stdin rather than interpolated into shell or
  command-line text.
- MCP stdout is reserved for protocol traffic; subprocess output is captured,
  parsed, and bounded.
- Jobs have configured timeouts and cancellation terminates the child process
  tree.
- A delegation-depth marker prevents the worker from recursively starting itself
  through Codex.
- When `reasoningEffort` is explicitly `ultra`, the worker prompt permits only
  Codex-managed read-only internal subagents inside the same invocation,
  sandbox, authority, and path boundary. The parent invocation remains the only
  proposal writer; Claude calls, nested workers, and authority expansion remain
  prohibited.

### Analyze mode

- Analyze is the default and always requests Codex's `read-only` sandbox.
- Analyze requests cannot include proposal write paths.
- The working directory must be a canonical non-symlink directory in an allowed
  root and Git repository.

This project requests the supported Codex sandbox; it is not an independent
kernel sandbox. Codex may read repository content and communicate with OpenAI
according to Codex CLI and account policy.

Generic analysis is advisory. Even when it reviews Spec Kit files, it cannot
produce the sealed evidence required by a strict SDD gate.

### SDD routing

`codex_worker_sdd_route` performs no provider call and no filesystem write. It
rejects duplicate or unsafe task IDs, unknown or cyclic dependencies, invalid
effort/authority/kind values, unsafe write scopes, and an invalid lane set. The
result follows a fixed policy version and includes a recomputable fingerprint.

Routing never grants execution authority. A `codex` write assignment must still
use the isolated proposal path, and the `claude-host` coordinator remains
responsible for honoring its assigned scope. Each returned wave contains at most
one writer; unrelated programs are outside that cooperative schedule.

### SDD review

The specialized review path enforces these additional controls:

- strict mode requires a clean workspace and an exact full Git revision;
- 1–64 canonical repository-relative artifact paths are accepted;
- artifact traversal, `.git` segments, backslashes, absolute/drive paths,
  symlinks, non-regular files, and paths outside the repository are rejected;
- each artifact is limited to 2 MiB and the set to 8 MiB;
- artifact bytes, clean state, revision, workspace fingerprint, review mode, and
  schema version are content-addressed;
- Claude host evidence is validated and frozen before Codex starts, but its
  summary and findings are not included in the Codex task;
- strict mode rejects submodules, creates a detached origin-free local clone at
  the sealed revision, disables hooks, proves it matches the seal, and rechecks
  the source before Codex starts;
- Codex runs in that clone fresh with `read-only`, approval policy `never`,
  ephemeral state, and the packaged output schema;
- draft mode remains source-based and cannot approve a gate;
- raw Codex review output must be one unfenced JSON object, at most 64 KiB, with
  at most 100 bounded findings;
- finalization rechecks Git state and every artifact before evaluating the gate.

The gate fails closed when evidence is missing, malformed, stale, belongs to a
different seal or phase, reuses a review ID, requests changes, or came from
draft mode. A job can complete successfully while its gate remains blocked or
stale. Host evidence is an attestation supplied by the host; BoundedRelay does
not authenticate Claude, launch it, or verify a declared model label.

### Proposal mode

Proposal mode is absent unless the process starts with
`CCW_ENABLE_PROPOSALS=true`.

Before execution, the worker requires:

- an exact 40- or 64-character Git object ID;
- source `HEAD` equal to that object ID;
- a completely clean source working tree, including untracked files;
- no `.gitmodules` file;
- one or more normalized, repository-relative write paths;
- an exclusive proposal lease for the source Git repository.

The worker rejects proposal scopes and resulting changes that target protected
paths: any `.git` segment, `.gitmodules`, `.npmrc`, `.pypirc`,
`credentials.json`, `id_rsa`, `id_ed25519`, private `.env`/`.env.*` files,
`*.pem`, and `*.key`. The explicit non-secret templates `.env.example`,
`.env.sample`, and `.env.template` are allowed.

The worker then:

1. creates a clean, disposable local clone;
2. checks out the exact revision detached;
3. removes the clone's origin;
4. disables repository Git hooks and global/system Git configuration for worker
   Git commands;
5. runs Codex with `workspace-write` only in the clone;
6. confirms `HEAD` and refs did not change;
7. rejects changes outside the allowlist or in protected paths;
8. rejects changed symlinks and non-regular paths;
9. enforces changed-file and patch-byte limits;
10. creates a full-index binary Git patch and SHA-256 digest;
11. deletes the clone and releases the lease.

The patch is output, not an action. The worker never runs `git apply`, never
copies files back, and never commits, pushes, deploys, or publishes.

### Environment policy

The Codex and Git child environment contains a small operational allowlist such
as `HOME`, `CODEX_HOME`, `PATH`, locale values, and temporary-directory
variables.

These known credential variables are excluded by default:

- `CODEX_ACCESS_TOKEN`;
- `CODEX_API_KEY`;
- `OPENAI_API_KEY`.

`CCW_FORWARD_AUTH_ENV=true` forwards them when present. This is unnecessary for
a normal saved Codex login and expands the secret exposure boundary, so use it
only when the authentication design requires it. `CCW_FORWARD_ENV` forwards only
explicitly named additional variables.

The worker does not print environment values in `doctor`, `config`,
capabilities, or public errors.

### Live-status boundary

Codex JSONL is treated as untrusted input. Public job status is rebuilt from a
small normalized event projection:

- fixed activity enum and server-owned label;
- lifecycle phase and revision;
- event, completed-command, and message counters;
- bounded normalized event type;
- timestamps and computed durations;
- one-based queue position while queued.

Raw event payloads, command text, tool arguments, event-derived file paths, and
private chain-of-thought are not copied into status. Every unrecognized event
identifier becomes `unknown` and maps to `working`. Session identifiers are
exposed only when they match the bounded public identifier format. A status
label is observability metadata, not a correctness or safety claim.

### Resource limits

The server limits active jobs, queued jobs, retained in-memory history, task
characters, JSONL output bytes, timeout values, patch bytes, changed files, Git
command output, and Git command time. These controls reduce accidental or
adversarial resource exhaustion but are not a complete denial- of-service
defense for a local user account.

## Data handling

### In memory

- task text and its hash;
- job lifecycle, sanitized activity, timing, and event counters;
- the final Codex message;
- optional proposal patch;
- frozen host review evidence, revision seals, and validated Codex review
  evidence for SDD review jobs;
- session ID and usage reported by Codex;
- idempotency-key mapping.

History is bounded and evicted, but there is no secure-memory guarantee. All job
data disappears when the server process exits.

### On disk

Only proposal/review workspaces and proposal lease metadata use `CCW_STATE_DIR`.
The project has no persistent job store and no audit ledger. A crash may leave a
temporary directory that requires careful manual cleanup after confirming no
worker is active. Stale proposal leases are evaluated separately by the lease
manager.

### Outside this project

Codex CLI may send task and repository context to OpenAI. Claude Code may retain
MCP inputs and outputs according to Anthropic and local workspace settings. This
worker cannot make either provider offline or change their retention terms.

## Important limitations

- A model can propose unsafe or incorrect code. Validation proves boundaries and
  artifact shape, not correctness.
- A valid binary patch may contain secrets, malware, destructive logic, or
  dependency changes.
- `includePatch=true` places the patch in Claude Code's MCP context; review data
  sensitivity first.
- The proposal lease coordinates worker processes that share the same state
  directory. It does not prevent manual edits, other tools, or workers
  configured with another state directory.
- Analyze jobs do not take a writer lease because they are read-only.
- Routing waves and host write-scope compliance are cooperative. BoundedRelay
  cannot stop Claude Code or an unrelated tool from ignoring them.
- The neutral 50/50 routing value does not override task-kind fit and does not
  measure or guarantee provider tokens, spend, time, quality, or resource
  savings.
- A clean source check is a point-in-time precondition. External processes can
  change the source later; the proposal still targets the pinned revision and is
  never applied automatically.
- No cryptographic identity proves that a request originated from Claude rather
  than another local MCP client.
- The local stdio server inherits the operating-system user's authority.

## Safe deployment checklist

- Install from a reviewed source or a pinned package version.
- Run `boundedrelay doctor` before connecting the server.
- Set `CCW_ALLOWED_ROOTS` to specific projects, never a home directory or
  filesystem root.
- Keep proposals disabled until read-only analysis works as expected.
- Treat `codex_worker_analyze` as advisory; use `codex_worker_sdd_review` for
  strict gates and require `gate.passed: true` with `gate.status: "ready"`.
- Re-run both reviews after any reviewed revision or artifact changes.
- Keep auth environment forwarding disabled when saved Codex login is
  sufficient.
- Inspect `codex_worker_workspace` before proposal submission.
- Pin `expectedRevision` and use the narrowest practical `writePaths`.
- Read result metadata before requesting the patch body.
- Save the patch outside the worker only when necessary, and treat it as
  sensitive.
- Review and test a patch separately; this worker intentionally has no apply
  command.

## Reporting a boundary failure

Unexpected writes to the source repository, command injection, path or symlink
escape, secret disclosure, patch-validation bypass, or access outside allowed
roots are security issues. Follow [SECURITY.md](../SECURITY.md) and do not post
a public reproduction containing secrets.
