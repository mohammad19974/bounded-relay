# Configuration

BoundedRelay v0.1 reads its authoritative server configuration from environment
variables when the process starts. An optional
[project profile](project-profiles.md) can add deterministic routing policy and
restrictions, but it is request data, not server configuration, and no runtime
tool or profile can broaden server policy.

Use `boundedrelay config` to print effective non-secret configuration and
`boundedrelay doctor` to verify Codex, Git, login status, and warnings.

## Complete reference

| Variable                            | Default                                                     | Accepted values                            | Purpose                                                                                                                                                                                                                           |
| ----------------------------------- | ----------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CCW_CODEX_BIN`                     | `codex`                                                     | executable name or path                    | Codex CLI command. It is canonicalized at startup; Windows supports native executables and the standard `@openai/codex` npm shim without a shell.                                                                                 |
| `CCW_GIT_BIN`                       | `git`                                                       | executable name or path                    | Git executable. It is resolved at startup.                                                                                                                                                                                        |
| `CCW_ALLOWED_ROOTS`                 | `CLAUDE_PROJECT_DIR`, then process cwd                      | platform path-delimited directories        | Specific project roots the worker may enter. `:` separates paths on POSIX; `;` on Windows.                                                                                                                                        |
| `CCW_ALLOWED_MODELS`                | empty                                                       | comma-separated model identifiers          | Models callers may explicitly request. Empty means callers must omit `model` and Codex uses its effective default.                                                                                                                |
| `CCW_DEFAULT_MODEL`                 | empty                                                       | one allowlisted model identifier           | Server-owned model applied when a job omits `model`. It must also appear in `CCW_ALLOWED_MODELS`; an explicit caller value always wins.                                                                                           |
| `CCW_DEFAULT_REASONING_EFFORT`      | empty                                                       | `low`..`max` reasoning enum                | Server-owned reasoning effort applied when a job omits `reasoningEffort`. `ultra` is rejected: it stays an explicit per-job opt-in because it arms the relaxed internal-subagent prompt. Neither default applies to resumed jobs. |
| `CCW_ENABLE_PROPOSALS`              | `false`                                                     | boolean                                    | Register `codex_worker_propose`.                                                                                                                                                                                                  |
| `CCW_PROPOSAL_BOOTSTRAP`            | empty                                                       | JSON array of 1..32 command arguments      | Operator-declared argv run once inside each fresh proposal clone so Codex can execute the project's checks there. Fails the job closed on nonzero exit or timeout; output is never surfaced. See the ADR 0003 amendment.          |
| `CCW_PROPOSAL_BOOTSTRAP_TIMEOUT_MS` | `300000`                                                    | integer `1000..1800000`                    | Bootstrap execution timeout.                                                                                                                                                                                                      |
| `CCW_FORWARD_AUTH_ENV`              | `false`                                                     | boolean                                    | Forward known provider-token environment variables to Codex.                                                                                                                                                                      |
| `CCW_FORWARD_ENV`                   | empty                                                       | comma-separated environment variable names | Forward additional named variables; values are never printed by config tools.                                                                                                                                                     |
| `CCW_MAX_CONCURRENT`                | `2`                                                         | integer `1..8`                             | Maximum active Codex jobs in one server process.                                                                                                                                                                                  |
| `CCW_MAX_QUEUED`                    | `32`                                                        | integer `1..256`                           | Maximum queued jobs.                                                                                                                                                                                                              |
| `CCW_MAX_HISTORY`                   | `100`                                                       | integer `10..1000`                         | Target in-memory history bound. Terminal jobs are evicted oldest first; active jobs are never evicted and can temporarily exceed it.                                                                                              |
| `CCW_MAX_TASK_CHARS`                | `20000`                                                     | integer `100..100000`                      | Task-text length limit.                                                                                                                                                                                                           |
| `CCW_MAX_OUTPUT_BYTES`              | `5000000`                                                   | integer `16384..10000000`                  | Codex stdout (JSONL event stream) byte limit per job.                                                                                                                                                                             |
| `CCW_MAX_STDERR_BYTES`              | `10000000`                                                  | integer `16384..100000000`                 | Separate stderr byte budget. stderr is only counted, never parsed or surfaced, so this guards against a runaway process without killing chatty runs.                                                                              |
| `CCW_MAX_PATCH_BYTES`               | `2000000`                                                   | integer `16384..20000000`                  | Maximum returned proposal patch size.                                                                                                                                                                                             |
| `CCW_MAX_CHANGED_FILES`             | `100`                                                       | integer `1..1000`                          | Proposal changed-file limit and maximum write-path entries accepted by the tool schema.                                                                                                                                           |
| `CCW_DEFAULT_TIMEOUT_MS`            | `1200000`                                                   | integer `1000..3600000`                    | Timeout used when a job omits `timeoutMs`.                                                                                                                                                                                        |
| `CCW_MAX_TIMEOUT_MS`                | `1800000`                                                   | integer `1000..7200000`                    | Highest timeout accepted from a caller. Must be at least the default timeout.                                                                                                                                                     |
| `CCW_CANCEL_GRACE_MS`               | `3000`                                                      | integer `100..30000`                       | Grace between process-tree termination and forced kill.                                                                                                                                                                           |
| `CCW_GIT_TIMEOUT_MS`                | `30000`                                                     | integer `1000..300000`                     | Timeout for each worker-owned Git operation.                                                                                                                                                                                      |
| `CCW_STATE_DIR`                     | `$XDG_RUNTIME_DIR/boundedrelay-<uid>` or OS temp equivalent | specific directory path                    | Transient proposal/strict-review clones and proposal lease metadata only. Not a job database.                                                                                                                                     |

Boolean values accept `1`, `true`, `yes`, `on`, `0`, `false`, `no`, and `off`,
case-insensitively.

## Allowed roots

Allowed roots are security boundaries, not convenience search paths.

- Each root must exist and be a non-symlink directory.
- Roots are canonicalized at startup.
- A filesystem root and the user's home directory are rejected.
- The state directory must not overlap an allowed root.
- A requested job `cwd` must be within a root and inside a Git repository.

Claude Code supplies `CLAUDE_PROJECT_DIR` to local stdio MCP servers. With no
explicit `CCW_ALLOWED_ROOTS`, that project is the normal default.

For multiple roots on POSIX:

```bash
CCW_ALLOWED_ROOTS=/work/service-a:/work/service-b
```

For multiple roots on Windows:

```powershell
$env:CCW_ALLOWED_ROOTS = 'C:\work\service-a;D:\work\service-b'
```

Do not use `/`, `C:\`, a home directory, or a broad documents directory.

## Model policy

The worker does not rank models. The deterministic SDD router assigns task
lanes, not model identifiers. A Codex job may omit `model`, in which case Codex
chooses its effective default. The worker invokes Codex with
`--ignore-user-config`, so user configuration is not loaded for the run;
authentication still uses the normal Codex home.

The invocation also uses `--strict-config` and `--ignore-rules`. The latter
disables Codex user/project execpolicy `.rules` files for this subprocess; it is
not a claim that repository content is trusted or ignored. `serve` checks that
the installed CLI advertises all required flags before it opens the MCP
transport.

To permit explicit model choices, list the exact identifiers controlled by the
server owner:

```bash
CCW_ALLOWED_MODELS=model-a,model-b
```

An unlisted model fails before job creation. Model availability, quality,
pricing, and account access remain Codex/provider concerns. Do not publish a
hard-coded “best model” table as worker policy.

Allowed reasoning efforts are `low`, `medium`, `high`, `xhigh`, `max`, and
`ultra`. Availability can depend on the selected Codex/model version; a rejected
value or unsupported combination becomes a failed job rather than a silent
downgrade.

For example, the optional Adaptive SDD pack can require this explicit critical
Codex profile:

```bash
CCW_ALLOWED_MODELS=gpt-5.6-sol
```

The review/proposal request must also specify `model: "gpt-5.6-sol"` and
`reasoningEffort: "ultra"`. The allowlist does not select that profile
automatically and does not prove account availability. There is no fallback.

`claude-host` is not configured here. It always means the model already selected
by the current Claude Code session. BoundedRelay has no Claude executable,
Anthropic API setting, or host-model override.

With `ultra`, the worker prompt permits Codex-managed read-only internal
subagents inside the same invocation, sandbox, authority, and path boundary. The
parent Codex invocation remains the only proposal writer. Cross-provider or
nested BoundedRelay delegation remains prohibited.

### Project-profile intersection

A portable project profile may resolve an exact Codex model/reasoning policy by
risk, task kind, or default. That value is only a request within the configured
boundary:

- a non-null model must appear in `CCW_ALLOWED_MODELS`;
- the profile cannot add a Claude model or change the current Claude Code host;
- the profile cannot change `CCW_ALLOWED_ROOTS`, proposal enablement,
  environment forwarding, timeouts, or resource limits; and
- an unavailable critical profile fails rather than silently falling back.

Profile validation proves structure and computes a content fingerprint. It does
not prove account availability or authorize execution. Read the complete
[project-profile guide](project-profiles.md) before accepting profile data from
a repository.

## Authentication and child environment

The base child environment forwards operational variables including `HOME`,
`CODEX_HOME`, `PATH`, locale, terminal, and temporary-directory values. A saved
`codex login` normally works without forwarding an API key.

Known auth variables are excluded unless explicitly enabled:

```bash
CCW_FORWARD_AUTH_ENV=true
```

This may forward `CODEX_ACCESS_TOKEN`, `CODEX_API_KEY`, and `OPENAI_API_KEY` if
they exist. Enabling it expands what repository commands running under Codex
could observe.

Forward other names only when necessary:

```bash
CCW_FORWARD_ENV=HTTPS_PROXY,NO_PROXY
```

`CCW_FORWARD_ENV` contains names, not values. Never commit secret values to
`.mcp.json`.

## Proposal configuration

Proposal mode has a server-startup gate:

```bash
CCW_ENABLE_PROPOSALS=true
```

The tool still requires a clean source, exact revision, explicit write paths,
size limits, and a repository lease. No environment option enables direct source
writes or automatic patch application.

An optional operator-declared bootstrap can materialize dependencies inside the
fresh clone before Codex starts, so Codex can run the project's own
typecheck/lint/tests against its patch:

```bash
CCW_PROPOSAL_BOOTSTRAP='["pnpm","install","--offline","--frozen-lockfile","--ignore-scripts"]'
```

The argv is server-owned configuration, never caller input, and runs once per
clone without a shell under the standard child-environment allowlist. Prefer an
offline, scripts-ignored recipe: the command executes the pinned revision's
package-manager configuration with worker authority, and the operator accepts
the residual risk of whatever command they declare. A nonzero exit or timeout
fails the preparation closed. Bootstrap artifacts that are not ignored by the
repository still fail the changed-path allowlist at patch validation.

Proposal scopes and resulting changes reject any `.git` segment, `.gitmodules`,
`.npmrc`, `.pypirc`, `credentials.json`, `id_rsa`, `id_ed25519`, private
`.env`/`.env.*` files, `*.pem`, and `*.key`. Only the explicit non-secret
templates `.env.example`, `.env.sample`, and `.env.template` are excepted from
the environment-file rule.

For a conservative local proposal profile:

```bash
CCW_ENABLE_PROPOSALS=true \
CCW_MAX_CONCURRENT=1 \
CCW_MAX_CHANGED_FILES=20 \
CCW_MAX_PATCH_BYTES=500000 \
boundedrelay serve
```

## State directory

The state directory must be a specific path outside all allowed projects. The
worker creates it with owner-only permissions where supported and refuses a
filesystem root, home directory, non-directory, symlink, or directory owned by
another user.

The directory contains transient proposal clones, detached strict-review clones,
and proposal locks. Jobs, prompts, results, and idempotency mappings are not
persisted. A process crash can leave transient entries; inspect the exact
configured directory and ensure no worker is active before any manual cleanup.

## Shared `.mcp.json`

Project-scoped MCP configuration is executable configuration and requires user
approval in Claude Code. Pin versions and review every command and environment
variable before accepting it.

See [the example](../examples/claude-code/README.md). Its absolute paths are
placeholders and it is not usable until they are replaced.
