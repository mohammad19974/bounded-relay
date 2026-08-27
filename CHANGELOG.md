# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project intends to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) after its public
contracts are validated.

## [Unreleased]

### Added

- BoundedRelay project identity, generated README cover and repository mark,
  complete source-installation guide, and optional Spec Kit integration recipe.
- Local stdio MCP server for Claude Code.
- In-memory asynchronous queue with status, result, list, long-poll, and
  cancellation operations.
- Read-only Codex analysis through `codex exec --json`.
- Opt-in proposal mode using a clean, revision-pinned, disposable local Git
  clone.
- Changed-path, ref, patch-size, file-count, and symlink validation for
  proposals.
- Proposal results that omit the binary patch body unless explicitly requested.
- Environment allowlisting, executable resolution, workspace allowlists, bounded
  output, and configurable timeouts.
- Sanitized live activity labels, update and elapsed timing, queued position,
  and revision-aware status long-polling through `afterRevision`.

### Changed

- The package, executable, and MCP implementation name are now `boundedrelay`;
  the stable v0.1 MCP tools and environment variables remain `codex_worker_*`
  and `CCW_*`.
- `codex_worker_list` returns an explicit `{ "jobs": [...] }` object.

### Security

- Proposal mode is disabled by default and never applies its returned patch.
- Direct token environment forwarding is disabled by default.
- Raw Codex event payloads and unrecognized event identifiers are excluded from
  live status; unsafe session identifiers are omitted.

## 0.1.0 - Unreleased development version

The package manifest reserves this version for the first public development
release. It has not been published to npm or announced as stable.
