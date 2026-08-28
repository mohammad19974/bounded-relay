# Routing Policy Conformance

This directory contains deterministic, credential-free fixtures for
BoundedRelay's public routing policy. The runner imports the built package, does
not start the MCP server or Codex CLI, and makes no provider request.

From a source checkout:

```bash
npm run build
npm run eval:routing
```

`routing-conformance-corpus.json` contains only synthetic task/profile data and
a golden legacy plan fingerprint. The runner reports named pass/fail invariants
for:

- the unchanged no-profile contract;
- canonical profile and task ordering;
- profile/plan content binding;
- hard and capability eligibility precedence;
- soft-preference behavior;
- required check command digests;
- Codex policy precedence and allowlist markers;
- one global cross-review policy selected by highest risk, then review kind,
  then default, with plan-fingerprint mutation coverage;
- exact-or-refuse critical policy;
- write-root restrictions;
- strict unknown-field refusal;
- dependency order and one-writer waves; and
- fixed one-way executor roles.

A pass means those policy assertions held for this implementation and corpus. It
is not a model benchmark and does not measure intelligence, generated-code
quality, correctness, latency, tokens, price, or savings. Expand the corpus when
a routing-policy bug is fixed; do not change the golden legacy fingerprint
unless an intentional breaking contract is approved and documented.
