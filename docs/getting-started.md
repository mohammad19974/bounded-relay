# Installation and first run

This guide installs BoundedRelay from source and connects it to Claude Code as a
local stdio MCP server. No daemon, container, cloud service, or API key is
required by BoundedRelay itself.

## 1. Prerequisites

Install these tools for the same operating-system user that will run Claude
Code:

| Dependency  | Requirement             | Verify with                                |
| ----------- | ----------------------- | ------------------------------------------ |
| Node.js     | `>=22.13.0`             | `node --version`                           |
| npm         | Included with Node.js   | `npm --version`                            |
| Git         | Available on `PATH`     | `git --version`                            |
| Codex CLI   | Installed and logged in | `codex --version` and `codex login status` |
| Claude Code | Local stdio MCP support | `claude --version`                         |

BoundedRelay calls the locally installed `codex` executable. It does not accept
provider credentials through MCP. A normal saved Codex login is the recommended
authentication path.

## 2. Download the project

### Git

Replace `<repository-url>` with the URL of the published BoundedRelay
repository:

```bash
git clone <repository-url> bounded-relay
cd bounded-relay
```

### GitHub ZIP

If Git is not available for download, use GitHub's **Code → Download ZIP**,
extract the archive, and open a terminal in the extracted directory. Git is
still required for delegated jobs and for proposal isolation.

## 3. Install and build

Use the lockfile for a reproducible dependency graph:

```bash
npm ci
npm run check
```

`npm run check` runs formatting verification, lint, TypeScript checks, tests
with coverage, a production build, and a package dry run. The built MCP entry is
`dist/cli.js`.

For a faster local rebuild after the full gate has already passed:

```bash
npm run build
```

## 4. Run the diagnostics

From the BoundedRelay directory:

```bash
node dist/cli.js doctor
node dist/cli.js config
```

`doctor` should report `ok: true`, `compatible: true`, and an authenticated
Codex login. `config` prints only non-secret effective settings.

Do not start `serve` by hand for normal use. Claude Code owns the stdio process
and restarts it as needed.

## 5. Register BoundedRelay

### macOS and Linux

Run this from the BoundedRelay directory. User scope is the recommended personal
default because it makes the same installation available across your local
projects:

```bash
WORKER_ENTRY="$(pwd)/dist/cli.js"

claude mcp add \
  --transport stdio \
  --scope user \
  bounded-relay \
  -- node "$WORKER_ENTRY" serve
```

### Windows PowerShell

Run this from the BoundedRelay directory:

```powershell
$WorkerEntry = (Resolve-Path ".\dist\cli.js").Path

claude mcp add `
  --transport stdio `
  --scope user `
  bounded-relay `
  -- node $WorkerEntry serve
```

The stored path must be absolute. Relative paths are resolved from Claude Code's
launch directory and commonly cause `ENOENT` failures.

### Registration scope

- `--scope user` is recommended for a personal absolute worker path. It is
  available to your user account across projects and is not committed.
- `--scope local` is available only in the project where it is registered. To
  use it, first change to the **target Git repository**, not the BoundedRelay
  source directory, and then register the already-built absolute worker path:

  ```bash
  cd /absolute/path/to/target-repository

  claude mcp add \
    --transport stdio \
    --scope local \
    bounded-relay \
    -- node /absolute/path/to/bounded-relay/dist/cli.js serve
  ```

- A project-scoped `.mcp.json` is useful for a team only when the command path
  is portable and every contributor reviews the server before trusting it. See
  the [checked-in example](../examples/claude-code/README.md).

## 6. Verify the connection

```bash
claude mcp list
```

Start Claude Code inside the Git repository you want to inspect, then run
`/mcp`. Confirm that `bounded-relay` is connected and exposes seven tools by
default. Enabling proposal mode adds the eighth tool, `codex_worker_propose`.

## 7. First read-only task

Use a prompt that tells Claude to keep status visible and use revision-aware
long-polling:

```text
Use bounded-relay to inspect this Git workspace and submit a read-only architecture review.
After every status response, pass its revision back as afterRevision and wait up to 10000ms
for the next update. Briefly show activityLabel, elapsedMs, eventCount, and commandCount.
Do not invent a percentage or ETA. When terminal, retrieve the result and summarize it.
```

The expected tool flow is:

```text
codex_worker_workspace
  → codex_worker_analyze
  → codex_worker_status (repeat with afterRevision)
  → codex_worker_result
```

Status is intentionally sanitized. It can say that Codex is reasoning,
researching, executing a sandboxed command, preparing isolated changes, or
composing a response. It does not return private chain-of-thought or raw command
arguments.

## 8. Restrict accessible workspaces

By default, the worker uses `CLAUDE_PROJECT_DIR` when Claude supplies it and
otherwise uses the MCP server's current directory. For an explicit boundary,
register the server with `CCW_ALLOWED_ROOTS`.

macOS and Linux use the platform path delimiter (`:`):

```bash
claude mcp remove bounded-relay --scope user

claude mcp add \
  --env CCW_ALLOWED_ROOTS=/absolute/path/to/project-a:/absolute/path/to/project-b \
  --transport stdio \
  --scope user \
  bounded-relay \
  -- node /absolute/path/to/bounded-relay/dist/cli.js serve
```

Windows uses `;` between roots. Do not allow a home directory, filesystem root,
or broad parent folder merely for convenience.

## 9. Optional proposal mode

Read the [security model](security-model.md) before enabling proposals. Then
replace the registration:

```bash
claude mcp remove bounded-relay --scope user

claude mcp add \
  --env CCW_ENABLE_PROPOSALS=true \
  --transport stdio \
  --scope user \
  bounded-relay \
  -- node /absolute/path/to/bounded-relay/dist/cli.js serve
```

A proposal requires:

- a clean source working tree;
- the exact full Git revision returned by `codex_worker_workspace`;
- one or more narrow repository-relative `writePaths`;
- explicit review before requesting or applying patch text.

BoundedRelay creates the change in a disposable clone, returns a validated patch
artifact, and never applies it to the source checkout.

## 10. Upgrade, rebuild, or remove

From the local clone:

```bash
git pull --ff-only
npm ci
npm run check
```

Restart Claude Code so it launches the rebuilt entry. Before a real release,
review `CHANGELOG.md` because v0.x contracts may change.

Remove the personal user-scoped MCP registration with:

```bash
claude mcp remove bounded-relay --scope user
```

This does not delete the BoundedRelay source directory or any target project.

## Common setup failures

### `bounded-relay` is disconnected

Run the configured command directly:

```bash
node /absolute/path/to/bounded-relay/dist/cli.js doctor
```

Then verify the absolute path in `claude mcp list` and rebuild if `dist/cli.js`
does not exist.

### `CODEX_INCOMPATIBLE`

Update the Codex CLI and rerun `doctor`. BoundedRelay fails closed when required
non-interactive or sandbox flags are absent.

### Codex is installed but not found

Claude Code's MCP process may receive a different `PATH` than an interactive
shell. Set `CCW_CODEX_BIN` to a reviewed absolute Codex executable path or fix
the environment used to launch Claude Code.

### Codex is not authenticated

Run `codex login`, confirm `codex login status`, and restart Claude Code. Avoid
placing tokens directly in `.mcp.json`.

### npm cache permission errors

Use a user-owned npm cache rather than `sudo npm`. For one run:

```bash
npm ci --cache /absolute/path/to/a/user-owned/npm-cache
```

For runtime and policy failures after installation, continue with the full
[troubleshooting guide](troubleshooting.md).
