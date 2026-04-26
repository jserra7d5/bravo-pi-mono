---
description: Check whether a Loom node is ready for spec, design, plan, implementation, or review
argument-hint: "<mode> <loom/node> [focus]"
---

Run a readiness check for a Loom-backed workflow. Use Loom only if a Loom/node/inbox reference or Loom context is provided.

User input:

```text
$ARGUMENTS
```

Modes may include `spec`, `design`, `plan`, `implement`, and `review`.

For implementation readiness, verify:
- chosen design/decision exists;
- task scope is clear;
- target repos, base branches/commits, and dirty state are known;
- worktree plan is defined when needed;
- validation commands/environment paths are known or explicitly deferred;
- review/validation path exists or is intentionally unnecessary;
- blockers and assumptions are explicit.

Return PASS/BLOCKED/READY-WITH-RISKS with concise reasons and next actions.
