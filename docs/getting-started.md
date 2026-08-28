# Installation and first run

This guide installs BoundedRelay from source and connects it to Claude Code as a
local stdio MCP server. No daemon, container, cloud service, or API key is
required by BoundedRelay itself.

## 1. Prerequisites

Install these tools for the same operating-system user that will run Claude
Code:

| Dependency  | Requirement             | Verify with                                |
| ----------- | ----------------------- | ------------------------------------------ |
| Node.js     | Node 22.13+ or 24.x     | `node --version`                           |
| npm         | Included with Node.js   | `npm --version`                            |
| Git         | Available on `PATH`     | `git --version`                            |
| Codex CLI   | Installed and logged in | `codex --version` and `codex login status` |
| Claude Code | Local stdio MCP support | `claude --version`                         |

BoundedRelay calls the locally installed `codex` executable. It does not accept
provider credentials through MCP. A normal saved Codex login is the recommended
authentication path.

On Windows, the recommended Codex installation is OpenAI's standalone PowerShell
installer, which provides a native `codex.exe`:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
codex --version
codex login status
```

The standard `npm install --global @openai/codex` layout is also supported.
BoundedRelay resolves its standard `codex.cmd` shim to the package's Node.js
entrypoint without enabling a command shell. Arbitrary `.cmd`, `.bat`, and
`.ps1` Codex shims are rejected. See OpenAI's
[current Codex installation instructions](https://github.com/openai/codex/blob/main/README.md)
before installing because platform guidance can change.

## 2. Download the project

### Git

Clone the BoundedRelay GitHub repository:

```bash
git clone https://github.com/mohammad19974/bounded-relay.git
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
with coverage, a production build, and a real package-install smoke. The smoke
creates the npm tarball, rejects missing or private files, installs it into an
empty consumer, and starts the installed MCP server without provider credentials
or a model call. The built MCP entry is `dist/cli.js`.

For a faster local rebuild after the full gate has already passed:

```bash
npm run build
```

## 4. Run the diagnostics

From the BoundedRelay directory:

```bash
node dist/cli.js doctor
node dist/cli.js config
node dist/cli.js sdd validate
node dist/cli.js sdd path
```

`doctor` should report `ok: true`, `compatible: true`, and an authenticated
Codex login. `config` prints only non-secret effective settings. `sdd validate`
checks the packaged optional integration files without installing them, while
`sdd path` prints their absolute root.

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
`/mcp`. Confirm that `bounded-relay` is connected and exposes nine tools by
default, including `codex_worker_sdd_route` and `codex_worker_sdd_review`.
Enabling proposal mode adds the tenth tool, `codex_worker_propose`.

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

## 10. Optional Adaptive SDD pack

The source repository uses `.specify/` for its own governance and includes a
generic integration pack for consumer repositories. The MCP runtime does not
load Spec Kit automatically. Do not copy this checkout's `.specify/` directory
into another project.

### Discover and validate the packaged files

From this source checkout:

```bash
npm link
boundedrelay sdd validate
INTEGRATION_ROOT="$(boundedrelay sdd path)"
```

`npm link` is needed only when you want the optional plugin's `.mcp.json` to
resolve the `boundedrelay` executable from `PATH`. Direct MCP registration from
step 5 does not need it.

### Install the local Spec Kit extension and workflow

Initialize a supported Spec Kit consumer repository first, then run:

```bash
specify extension add "$INTEGRATION_ROOT/spec-kit/extension" --dev
specify workflow add "$INTEGRATION_ROOT/spec-kit/workflow" --dev

specify extension list
specify extension info boundedrelay-sdd
specify workflow list
specify workflow info boundedrelay-adaptive-sdd
```

The `--dev` installs reference the checked-out local directories. Keep the
BoundedRelay checkout in place while using them. Review any consumer-repository
changes and add `.specify/workflows/runs/` to its `.gitignore`; run evidence can
contain paths, findings, and job IDs.

Start the workflow with explicit inputs:

```bash
specify workflow run boundedrelay-adaptive-sdd \
  -i spec="Implement the approved feature contract" \
  -i scope="apps/api and packages/contracts" \
  -i feature_directory="specs/001-example" \
  -i codex_share=50
```

The 50 value is neutral metadata, not a quota. Hard eligibility, versioned
task-kind fit, and an applicable exact-fit preference come first, so the actual
share may be anywhere from 0% to 100%. Only a true neutral tie reaches the
odd-task Codex preference. None of these fields measures tokens, price, or
elapsed time.

### Validate and load the optional Claude Code plugin

The plugin has no Claude model override. It uses the model already selected by
the Claude Code host and starts `boundedrelay serve` through its MCP
declaration. On a machine with Claude Code installed:

```bash
claude plugin validate "$INTEGRATION_ROOT/claude-code-plugin"
claude --plugin-dir "$INTEGRATION_ROOT/claude-code-plugin"
```

`boundedrelay sdd validate` is only a package-structure check. Automated tests
do not invoke Claude Code, so run the host validation yourself before relying on
the plugin. The direct MCP registration in step 5 remains the simpler stable
local setup when plugin loading is unnecessary. Do not activate both MCP
definitions in one session; keep one canonical BoundedRelay server entry.

Read the [Adaptive SDD guide](integrations/spec-kit.md) before running strict
review gates or enabling routed write proposals.

## 11. Upgrade, rebuild, or remove

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

If you used `npm link`, remove only its global link when it is no longer needed:

```bash
npm unlink --global boundedrelay
```

Remove the local Spec Kit extension/workflow using the removal commands
advertised by `specify extension --help` and `specify workflow --help` for your
installed version. Delete ignored `.specify/workflows/runs/` evidence only after
confirming no active run needs it. A stale review is recovered by creating a new
clean checkpoint and rerunning both host and Codex reviews; never edit a seal or
reuse an old approval.

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
the environment used to launch Claude Code. On Windows, prefer the official
standalone `codex.exe` or the unmodified `codex.cmd` generated by the
`@openai/codex` npm package; custom shell shims intentionally fail closed.

### Codex is not authenticated

Run `codex login`, confirm `codex login status`, and restart Claude Code. Avoid
placing tokens directly in `.mcp.json`.

### npm cache permission errors

Use a user-owned npm cache rather than `sudo npm`. Keep the setting active for
both installation and the package smoke inside `npm run check`.

macOS or Linux:

```bash
export npm_config_cache=/absolute/path/to/a/user-owned/npm-cache
npm ci
npm run check
```

Windows PowerShell:

```powershell
$env:npm_config_cache = "$env:LOCALAPPDATA\boundedrelay-npm-cache"
npm ci
npm run check
```

For runtime and policy failures after installation, continue with the full
[troubleshooting guide](troubleshooting.md).
