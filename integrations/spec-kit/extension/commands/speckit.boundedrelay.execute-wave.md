---
description:
  "Execute one dependency-safe routed wave through Claude Code and BoundedRelay"
---

# Execute One Routed Wave

Treat `execution.json` and the verified `routing.json` named by `$ARGUMENTS` as
the complete authority envelope. Work on the single `activeWave`; never batch a
future wave or broaden a path lease.

1. Verify both evidence files, the active baseline, repository rules, and every
   dependency result. If the active wave already contains a complete result for
   every routed task, make no provider call and no code change. This makes a
   paused loop safe to resume.
2. Process read-only tasks first in canonical task-id order. A Claude-host task
   is handled directly with the host-selected Claude model. A Codex task must go
   through BoundedRelay, use its allowlisted model policy, poll with
   `afterRevision`, and retrieve the terminal result once.
3. Execute the wave's single writer, if present, only after all read-only work
   in the wave is accepted. For Claude-host, write only inside its lease. For
   Codex, call `codex_worker_propose` against the exact active baseline, inspect
   the patch and changed paths, then integrate it as the sole host writer. Never
   ask BoundedRelay to apply, commit, merge, push, publish, or deploy. Persist
   the exact returned patch bytes at `patches/<taskId>.patch` beneath the run
   directory with owner-only permissions; record that relative file and its
   recomputed digest. The patch is local run evidence and must never be added to
   Git.
4. Run focused repository checks against the completed working-tree content.
   Record 1-32 redacted check receipts: safe profile and label, SHA-256 of the
   exact argv, relative cwd, zero exit code, output digests, the exact tested
   Git tree ID, and timestamps. The tested tree must equal the following
   authorized checkpoint commit tree. Never persist raw output, environment
   values, tokens, or secrets.
5. Append exactly one typed result per active task. Preserve every engine-owned
   field. Results include routed provider/wave, effect, baseline, provenance,
   the worker-observed model and reasoning effort, verification, timestamps, and
   empty checks for analysis. Codex model fields must exactly match the routed
   policy; Claude fields remain null because the host selection is not
   independently observable. A write result also includes exact changed files
   and checks; a Codex write includes job and patch digests and uses
   `proposal-integrated` only after host inspection and integration.
6. Stop with the worktree uncommitted when code changed. The following human
   gate owns inspection and checkpoint authorization. Do not advance the wave,
   alter routing, repair unrelated code, or manufacture missing evidence.

```text
$ARGUMENTS
```
