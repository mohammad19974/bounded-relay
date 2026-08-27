# Claude Code MCP Example

The adjacent `.mcp.json` is an analyze-only project-scoped example. It is
intentionally invalid until its absolute worker path is replaced.

The configuration structure follows Claude Code's
[official MCP configuration documentation](https://code.claude.com/docs/en/mcp).

## Prepare the worker

```bash
cd /absolute/path/to/bounded-relay
npm ci
npm run check
```

Replace this placeholder in `.mcp.json`:

```text
/ABSOLUTE/PATH/TO/bounded-relay/dist/cli.js
```

with the real absolute path to `dist/cli.js`. Do not commit a developer-specific
path to a shared repository unless the team intentionally standardizes that
location.

The adjacent `.mcp.json` does **not** declare `CLAUDE_PROJECT_DIR` or
interpolate `${CLAUDE_PROJECT_DIR:-.}`. Its explicit `env` block only keeps
proposal mode disabled. Claude Code supplies `CLAUDE_PROJECT_DIR` to the local
stdio server process, and BoundedRelay uses that project directory as its
default allowed root. If the client does not supply it, the worker falls back to
the server process's current directory and applies the same path-policy checks.

## Install the example

Copy the reviewed `.mcp.json` to the root of the Git project where Claude Code
should use the worker. Claude Code prompts users before trusting project-scoped
MCP servers. Inspect the command, arguments, and environment before approval.

Verify with:

```bash
claude mcp list
```

and `/mcp` inside Claude Code.

## Prefer user scope for a personal installation

For a developer-specific absolute path, avoid committing `.mcp.json` and
register once for your user account so the worker is available across projects:

```bash
claude mcp add \
  --transport stdio \
  --scope user \
  bounded-relay \
  -- node /absolute/path/to/bounded-relay/dist/cli.js serve
```

If you want the registration in only one project, change to that **target Git
repository** first and use `--scope local`; running a local-scope command from
the BoundedRelay source directory would attach it to the wrong project.

## Proposal mode

The checked-in example keeps proposals disabled. To evaluate proposals locally,
add `CCW_ENABLE_PROPOSALS=true` to a reviewed user- or project-scoped
registration. Read [Security model](../../docs/security-model.md) first.

Never put API keys or access tokens directly in `.mcp.json`.
