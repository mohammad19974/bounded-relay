# Support

BoundedRelay is a community-maintained, pre-stable project with no paid support
or response SLA.

## Before asking for help

1. Run `node --version`, `git --version`, and `codex --version`.
2. Confirm the MCP server in `claude mcp list` and Claude Code's `/mcp` panel.
3. Run the worker's capabilities tool from Claude Code.
4. Read [Troubleshooting](docs/troubleshooting.md) and
   [Compatibility](docs/compatibility.md).
5. Reproduce the problem in a disposable Git repository without secrets.

Use a GitHub issue for reproducible bugs and clearly scoped documentation
requests. Include sanitized versions, configuration variable names, the worker
error code, and minimal steps. Do not paste raw prompts, provider credentials,
private source, or full Codex event streams.

Feature ideas belong in the feature-request form. Security issues must follow
[SECURITY.md](SECURITY.md), never a public issue.
