---
name: boundedrelay-setup
description:
  Verify and explain the local BoundedRelay connection used by Claude Code
  without changing provider models or enabling proposals implicitly.
user-invocable: true
---

# Set up BoundedRelay

Use this skill when the user wants to connect or diagnose BoundedRelay.

1. Confirm Node.js satisfies the version declared by the installed BoundedRelay
   package and that `boundedrelay` resolves on `PATH`.
2. Run `boundedrelay doctor`. Report the observed Codex CLI, authentication,
   allowed roots, model allowlist, proposal state, limits, and blockers. Never
   print tokens or inherited environment.
3. Confirm the MCP server exposes `codex_worker_capabilities`,
   `codex_worker_workspace`, `codex_worker_sdd_route`, and
   `codex_worker_sdd_review`. Proposal support is optional and must be
   explicitly enabled by the user.
4. Resolve the intended consumer repository through `codex_worker_workspace`.
   Never widen allowed roots merely to make a check pass.
5. Keep Claude Code's current host model. This plugin intentionally has no model
   override. Report a Claude model label only when the host supplies trustworthy
   metadata; otherwise say unavailable.
6. For Spec Kit, direct the user to the adjacent
   `integrations/spec-kit/README.md`. Do not initialize Spec Kit, install an
   extension, edit `.gitignore`, or create commits without matching authority.

BoundedRelay is a one-way local boundary: Claude coordinates and may call Codex.
Codex cannot call Claude through this plugin. Jobs are process-memory state and
disappear when the MCP server exits.
