# Examples

Examples are safe starting points, not drop-in production configuration.

- [`claude-code/.mcp.json`](claude-code/.mcp.json): local-path, analyze-only
  Claude Code server.
- [`claude-code/README.md`](claude-code/README.md): replacement and registration
  instructions.
- [`policies/analyze-only.env.example`](policies/analyze-only.env.example):
  conservative environment profile.
- [`policies/proposals.env.example`](policies/proposals.env.example): opt-in
  proposal profile.
- [`outputs/analyze-result.json`](outputs/analyze-result.json): sanitized
  completed analysis result.
- [`outputs/proposal-result-metadata.json`](outputs/proposal-result-metadata.json):
  sanitized proposal result without the patch body.

All paths, revisions, UUIDs, model output, and timestamps are illustrative.
Examples contain no provider credentials and must never be populated with live
secrets before commit.
