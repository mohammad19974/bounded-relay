# ADR 0008: Deterministic Adaptive Quality-First Routing

- Status: Accepted
- Date: 2026-08-27

## Context

Splitting an equal number of tasks does not split work equally, while forcing an
effort quota can assign a task to the weaker-fit lane merely to reach a tidy
percentage. A stochastic or model-authored assignment is also difficult to test,
reproduce, and audit. The host model may change between Claude Code sessions and
must not be guessed by BoundedRelay.

## Decision

Routing is a pure, versioned algorithm. The two lane identifiers are `codex` and
`claude-host`; the latter means the model already selected by Claude Code. The
worker never launches or selects a Claude model.

`sdd-routing-v2` compares decisions in this order:

1. hard eligibility and authority constraints;
2. the stronger `sdd-task-fit-v1` task-kind score;
3. an eligible `preferredLane`, but only when base fit is exactly tied;
4. deviation from a soft effort share among the remaining fit-neutral tasks;
5. fit-neutral task-count deviation using that same share;
6. at a true 50/50 odd neutral tie, the extra task goes to Codex;
7. canonical task identifiers provide the final stable tie-break.

Risk does not imply that an unknown Claude host model or Codex is inherently
better. Criticality instead drives the cross-provider review and explicit model
profile policy in the integration layer. The neutral Codex share defaults to
5,000 basis points, but it is never a provider quota; a specialized workload may
correctly route every task to one lane.

Every plan contains normalized inputs, routing and fit policy versions, the
selection order, per-task fit scores and decision stage, a content fingerprint,
safe execution waves, neutral-share metrics, deviation reasons, and stable
reason codes.

## Consequences

Semantically identical inputs produce byte-stable results. Balance cannot lower
the selected task fit, and output explains whether eligibility, quality fit,
preference, neutral balance, or the final lexical rule made each decision.
Percentages remain estimates over declared effort points, not claims about
tokens, wall time, price, or model quality.

The trade-off is that the versioned fit table is deliberately conservative and
must evolve through a policy-version change and regression tests. Consumers can
use hard eligibility for known capability constraints and a soft preference for
otherwise neutral work.

## Supersession condition

Replace this decision only when audited provider telemetry or an explicit
consumer policy can improve fit without sending repository content to an
additional model or making identical inputs non-deterministic.
