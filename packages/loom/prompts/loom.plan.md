---
description: Create a Loom-backed implementation plan from a chosen design
argument-hint: "<loom/node> [implementation constraints]"
---

Plan implementation for a Loom-backed feature/design. Use Loom only if a Loom/node/inbox reference or Loom context is provided.

User input:

```text
$ARGUMENTS
```

Workflow:
1. Fetch context for the plan node/design node.
2. Confirm a chosen design/decision exists. If not, stop and recommend `loom.decide`.
3. Decompose into implementable task nodes with clear scope, dependencies, target repos, validation expectations, and stop conditions.
4. Add dependent review/validation nodes at practical granularity.
5. Identify worktree needs, source repos, base branches/commits, and environment paths if known.
6. Summarize the plan concisely and note unresolved blockers.

Do not defer all review to one large final pass unless the implementation is trivial.
