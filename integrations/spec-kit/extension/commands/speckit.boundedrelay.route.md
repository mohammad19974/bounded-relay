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
4. When pending evidence has a non-null `projectProfile`, read its exact sealed
   path and include the parsed JSON unchanged as `request.projectProfile`.
   Persist only the authoritative schema-v2 / `sdd-routing-v3` result. Exact
   match `executorId`, capability requirements and eligibility,
   `requiredCheckProfiles`, and `codexPolicy` into each workflow assignment, and
   project the plan-level `crossReviewPolicy` exactly once. Never execute,
   interpolate, or shell-evaluate any check-profile `argv`; it is inert policy
   data. The profile may only restrict the routed write scopes, and its own path
   must not overlap a writer lease.
5. A Claude assignment uses `{ "source": "host-selected", "model": null }`. Do
   not override the Claude Code host model.
6. A profiled Codex implementation or cross-review uses the exact model and
   reasoning effort returned in `codexPolicy`; a non-profiled Codex assignment
   uses server-allowlisted policy. For a profiled critical task, require the
   exact explicit non-null model and effort from `codexPolicy.byRisk.critical`
   and the authoritative plan-level cross-review policy; both remain subject to
   the server allowlist. A legacy no-profile critical route keeps the fixed
   `gpt-5.6-sol` / `ultra` lane. If the required lane is unavailable, leave
   routing incomplete and report the blocker; never silently downgrade it.
7. Project the returned lanes into the workflow assignments, add only
   coordinator policy metadata not owned by the router, set totals from the real
   assignments, and atomically replace the evidence with `state: complete`. Each
   write task may require at most 64 checks; reject the route before execution
   if all write assignments together require more than 256 receipts.

Do not start workers, edit implementation files, install dependencies, commit,
push, or deploy.

```text
$ARGUMENTS
```
