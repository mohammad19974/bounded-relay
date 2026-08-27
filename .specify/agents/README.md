# Shared Agent Context

Spec Kit artifacts are the source of truth for substantial BoundedRelay changes.
Claude, Codex, Cursor, and future agents read the same files and do not create
competing governance systems.

## Load order

1. `.specify/memory/constitution.md`
2. `.specify/agents/context.json`
3. `.specify/agents/HANDOFF.md` when resuming
4. the active feature's `spec.md`, `plan.md`, and `tasks.md`
5. `AGENTS.md`, `docs/architecture.md`, and `docs/security-model.md`

The coordinating agent owns scope, integration, verification, and the final
verdict. Delegated workers receive path-disjoint contracts. Reviewers are fresh
and read-only. No agent commits, pushes, publishes, or deploys without explicit
user authorization.

## Active workflow

The repository develops the distributable workflow at `integrations/spec-kit/`.
The installed copy under `.specify/agents/` is refreshed only after the
distributable pack passes its tests. Run-local evidence belongs below
`.specify/workflows/runs/` and is ignored by Git.
