# Compatibility

BoundedRelay depends on public command-line and MCP contracts, not provider SDK
internals. Compatibility is feature-based and must be verified against the
current CI and local `doctor` output.

## Runtime matrix

| Component   | v0.1 requirement                                                           | Notes                                                                                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node.js     | `>=22.13.0`                                                                | Node 22 and 24 are the intended CI lines.                                                                                                                                                                    |
| Claude Code | Local stdio MCP support                                                    | Configure with `claude mcp add --transport stdio`. No exact Claude Code version is pinned yet.                                                                                                               |
| Codex CLI   | `codex exec --json` plus required flags                                    | Must advertise `--strict-config`, `--sandbox`, `--ask-for-approval`, `--cd`, `--json`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, and `--color`; prompts must be accepted from stdin with `-`. |
| Git         | Modern CLI with clone, detached checkout, status, diff, and ref inspection | Proposal mode additionally needs `git diff --binary --full-index`.                                                                                                                                           |
| MCP         | SDK-supported local stdio transport                                        | HTTP, SSE, and remote deployment are not supported.                                                                                                                                                          |

Run:

```bash
node --version
git --version
codex --version
codex exec --help
boundedrelay doctor
```

`doctor` probes both Codex help surfaces, checks every required flag, and runs
`codex login status`; it does not make a model call. `serve` fails with
`CODEX_INCOMPATIBLE` when the flag contract is not met.

## Operating systems

The implementation targets current macOS, Linux, and Windows Node.js
environments. Process-tree termination, temporary directories, executable
discovery, path delimiters, null devices, and file permissions have
platform-specific branches.

Do not treat a target as verified merely because code exists for it. Consult the
latest CI run for the exact operating-system and Node.js combination. Until
public CI evidence exists, v0.1 should be described as locally verified only on
the systems named in release notes.

## Codex event compatibility

The worker consumes documented JSONL event shapes needed for lifecycle
visibility:

- `thread.started` for session ID;
- `turn.started` for observed work activity;
- `item.started` and `item.completed` for sanitized activity categories;
- completed command items for command counts and completed agent-message items
  for the final response;
- `turn.completed` for terminal state and usage;
- `turn.failed` and `error` for failure state.

Known item categories map to a fixed public activity vocabulary. Unknown events
remain valid progress events, but every unrecognized identifier is exposed only
as `unknown` and maps to `working`. This forward-compatible behavior avoids
failing merely because Codex adds an event while preventing provider-controlled
identifiers or payload fields from becoming a public status contract. Malformed
JSON, an event without a string type, a missing terminal event, or a missing
final message fails closed.

Official behavior is documented in OpenAI's
[non-interactive mode guide](https://developers.openai.com/codex/noninteractive/).
Re-run contract fixtures when Codex changes event fields or command flags.

## Git repository constraints

All jobs require an existing Git repository. Analyze mode can inspect a dirty
worktree. Proposal mode additionally requires:

- an exact 40- or 64-character object ID available locally;
- a clean worktree including no untracked files;
- no `.gitmodules` file;
- a local clone that can check out the requested revision;
- regular-file changes within explicit path scopes;
- no protected proposal path, including `.git`, `.gitmodules`, private `.env`
  variants, common credential/key names, `*.pem`, or `*.key` (the explicit
  template suffixes documented in the security model remain allowed).

Submodules are intentionally unsupported for proposals in v0.1. Rename detection
is disabled when building and validating proposal artifacts; a rename is
represented by its underlying delete/add changes.

## Model compatibility

The worker has no built-in model catalog. Omit `model` to use Codex's effective
default, or have the server owner populate `CCW_ALLOWED_MODELS` with exact
identifiers. A model being allowlisted does not prove that the current account
can use it.

Reasoning effort accepts `low`, `medium`, `high`, `xhigh`, and `max`, but
support can differ by model or Codex version. Provider rejection becomes a job
failure; the worker does not silently select a different model.

## Versioning policy

Before `1.0.0`, MCP schemas and environment variables may change between minor
versions. Changes must be recorded in `CHANGELOG.md`, reflected in examples and
JSON schemas, and tested through the packed artifact before a release claim is
made.
