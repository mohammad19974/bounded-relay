# Bounded Implementation Proposal

This recipe asks Codex to create a reviewable patch in a disposable clone. It
never applies the patch.

## Preconditions

- The user explicitly wants a patch proposal.
- The server was started with `CCW_ENABLE_PROPOSALS=true`.
- `codex_worker_workspace` reports a clean source and no proposal blockers.
- The requested write paths are narrow and owned by one task.

## Coordinator prompt

```text
Create a bounded proposal through bounded-relay; do not edit the source checkout.

1. Call codex_worker_workspace and record repositoryRoot, revision, clean, and proposalBlockers.
2. Stop if proposalReady is false.
3. Submit codex_worker_propose with expectedRevision equal to that exact revision and writePaths
   limited to src/parser and tests/parser.
4. Poll status with bounded waits, passing the last revision as afterRevision. Show only the
   sanitized activity label and counters. Respect the routing wave and do not start another
   writer for this repository.
5. Retrieve the terminal result with includePatch=false.
6. Show changedFiles, patchBytes, patchSha256, Codex's summary, checks, and risks.
7. Ask me before retrieving includePatch=true. Never apply, commit, or push it.

Task: Propose the smallest fix for the confirmed parser race and update only its focused tests.
```

## Review the metadata first

Before requesting patch content:

- `baselineRevision` must equal the inspected revision;
- every changed file must be inside the intended scope;
- patch size must be reasonable for human review;
- `patchSha256` should be retained if the patch is exported;
- the final message should identify verification actually run, not implied
  success.

## Patch retrieval

If the patch may safely enter Claude Code context:

```json
{
  "jobId": "<JOB_UUID>",
  "includePatch": true
}
```

`<JOB_UUID>` is the real job ID returned by the worker. Retrieving the patch
does not apply it.

Apply and test, if ever authorized, through a separate human-controlled workflow
outside this project. Re-check that the target repository still matches
`baselineRevision`; a patch generated against an older revision may no longer
apply safely.
