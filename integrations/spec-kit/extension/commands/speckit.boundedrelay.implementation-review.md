---
description:
  "Run frozen Claude host and independent Codex implementation reviews"
---

# Dual Implementation Review

Review the phase named in `$ARGUMENTS` against its pending revision-sealed
evidence. This command is read-only except for the matching run-local review
JSON.

1. Read the `stage` in `$ARGUMENTS`. For `stage=claude`, read the constitution,
   active spec, plan, tasks, repository rules, real diff, and checks. Complete
   only the Claude host review, set the evidence state to `claude-frozen`, keep
   Codex evidence and the combined verdict null, atomically replace the file,
   and stop. Preserve implementation check receipts. For convergence changes,
   run the relevant checks and add redacted typed receipts plus their canonical
   digest before freezing. Every receipt's tested Git tree must equal the sealed
   convergence revision tree; raw output and environment values never enter the
   evidence file. The following verifier stamps an engine-owned `reviewId` bound
   to the run, nonce, revision, source evidence, and check digest. Preserve that
   exact ID when submitting `hostReview` to BoundedRelay.
2. For `stage=codex`, require that the separate verifier already accepted the
   frozen Claude state. Do not edit or regenerate the host review and do not put
   its findings in the Codex prompt or `focus`.
3. Start a fresh `codex_worker_sdd_review` with the matching `implementation` or
   `convergence` phase, `mode: strict`, exact sealed artifact paths, the
   recorded comparison base revision, expected full Git revision, and frozen
   host evidence. Use the exact prepared `codexReviewPolicy`, and persist the
   job's observed model and reasoning effort. Generic `codex_worker_analyze`
   cannot satisfy this gate. Keep Claude findings out of `focus` and the Codex
   prompt. Use an allowlisted model only, poll with `afterRevision`, and
   retrieve the final result once.
4. Recompute workspace state. Evidence is invalid if HEAD, changed-file scope,
   artifacts, source execution/review digest, check receipts, or the
   working-tree seal changed.
5. Record severity-ranked findings with exact paths, verification observed, and
   residual risk. High and Critical findings are always blocking and require a
   new revision plus two fresh reviews. A missing or failed reviewer is not
   replaced by self-review.
6. Persist the returned strict seal and gate. Set the combined verdict to
   `approved` only when both reviews approve and the returned gate is
   `passed: true`, `status: ready` for that seal. Atomically replace the
   evidence. Do not fix findings, edit tasks, apply patches, commit, push, or
   deploy.

```text
$ARGUMENTS
```
