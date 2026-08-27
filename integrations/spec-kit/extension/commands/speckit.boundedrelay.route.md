---
description:
  "Route approved tasks by estimated effort with a configurable provider target"
---

# Route Approved Work

Read the active artifacts and pending `routing.json` named in `$ARGUMENTS`. This
operation writes only that run-local evidence file.

1. Read the engine-generated `taskManifest` first. It is derived from the exact
   committed `tasks.md` checkbox IDs at the routing revision and is already
   content-addressed. Build the normalized `codex_worker_sdd_route` request for
   every ID in `taskManifest.pendingTaskIds`, in that exact canonical order,
   exactly once. Never omit a pending ID, invent an ID, or route a completed ID.
   Add integer effort points, dependency IDs, authority, kind, bounded
   repository-relative write scopes, lane eligibility, and risk for each task.
2. Resolve capability, safety, dependency, and path ownership constraints before
   balancing. Never assign overlapping writer scopes.
3. Call `codex_worker_sdd_route` with `neutralCodexShareBps` (default `5000`).
   This is a soft tie-break for fit-neutral tasks, never a provider quota.
   Persist its full schema-versioned response, including `routingPolicyVersion`
   and `planFingerprint`. Do not invent, manually alter, or fall back from the
   returned assignments. The engine independently verifies that fingerprint and
   exact manifest coverage. The target is estimated effort, never a cost or
   token claim.
4. A Claude assignment uses `{ "source": "host-selected", "model": null }`. Do
   not override the Claude Code host model.
5. A Codex assignment uses server-allowlisted policy. A critical task must use
   both providers: either `gpt-5.6-sol` with `ultra` writes and Claude host
   reviews, or Claude host writes and an allowlisted Sol-ultra Codex lane
   reviews. If that critical lane is unavailable, leave routing incomplete and
   report the blocker; never silently downgrade it.
6. Project the returned lanes into the workflow assignments, add only
   coordinator policy metadata not owned by the router, set totals from the real
   assignments, and atomically replace the evidence with `state: complete`.

Do not start workers, edit implementation files, install dependencies, commit,
push, or deploy.

```text
$ARGUMENTS
```
