# Validation Quickstart

```bash
npm ci
npm run check
node dist/cli.js doctor
```

Run focused tests during implementation:

```bash
npx vitest run tests/sdd-routing.test.ts tests/sdd-review-gate.test.ts
npx vitest run tests/job-manager.test.ts tests/runtime-policies.test.ts tests/mcp-contract.test.ts
npx vitest run tests/integration-pack.test.ts
```

The tests use fake Codex executables and temporary Git repositories. They must
not require Claude, provider credentials, or paid model calls.
