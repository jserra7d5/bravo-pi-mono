# @bravo/auth-balancer-contract

Policy-free shared contract primitives for the Codex and Claude auth balancers.

This package contains only:

- shared phase, outcome, provider, scenario, and evidence-code literals;
- a v1 attempt-record validator;
- bounded redaction helpers;
- scenario fixture and registry helpers.

It must not import provider packages, score accounts, select slots, decide retry or rotation eligibility, own persistence, or know credential-refresh semantics.

```bash
npm run check --workspace @bravo/auth-balancer-contract
npm test --workspace @bravo/auth-balancer-contract
```
