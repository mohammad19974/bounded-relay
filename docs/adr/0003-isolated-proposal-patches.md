# ADR 0003: Proposals use disposable clones and are never applied

**Status:** Accepted  
**Date:** 2026-08-27

## Context

Read-only review is the safest default, but some workflows benefit from seeing a
concrete patch. Giving a model workspace-write access to the user's active
checkout would risk unrelated changes, dirty-state loss, races with Claude Code,
and unclear ownership.

A path list in a prompt is not an enforcement boundary. The worker must validate
the actual Git artifact after execution.

## Decision

- Disable proposal mode by default and register its MCP tool only with explicit
  startup opt-in.
- Require a clean source tree, exact full revision, and explicit
  repository-relative path scopes.
- Acquire an exclusive proposal lease keyed to the canonical source repository.
- Clone locally into a private transient state directory, check out detached,
  remove origin, and disable hooks.
- Give Codex workspace-write access only to the clone.
- Reject ref/HEAD changes, out-of-scope or protected paths, symlinks,
  non-regular paths, excessive changed files, and excessive patch bytes.
- Return a full-index binary patch and SHA-256 digest.
- Omit patch content from normal results unless explicitly requested.
- Always clean the clone and never apply the patch.

## Consequences

- The source checkout remains outside the proposal write sandbox.
- The patch is reviewable and revision-pinned.
- Proposal mode requires Git and a clean committed baseline.
- Submodules are unsupported in v0.1.
- Local cloning costs disk and time proportional to the repository.
- Path validation constrains the artifact, not the semantic behavior of code
  inside allowed paths.
- The caller remains responsible for review, testing, and any later application.

## Alternatives rejected

- **Write directly in the source checkout:** violates the product's core safety
  claim.
- **Use prompt-only path restrictions:** not enforceable.
- **Automatically apply a validated patch:** collapses proposal and mutation
  authority.
- **Use `git worktree`:** shares repository metadata and refs, increasing
  coupling to the source.
- **Return only prose:** safer but does not satisfy the concrete-proposal use
  case.

## Revisit when

The project has evidence for a different isolation primitive with equal or
stronger source protection. Automatic application requires a separate product
and threat-model decision; it is not an incremental extension of this ADR.
