---
description: Develop a single coherent Loom-backed design direction
argument-hint: "<loom/node> [design constraints]"
---

Develop a single design direction for a Loom-backed proposal/spec in this Claude Code session. Claude Code plugin commands do not recursively delegate; use the `loom-design` skill guidance directly and record durable design notes/nodes with Loom. If genuinely competing architectures should be preserved, recommend `/loom-branch-design`.

User input:

```text
$ARGUMENTS
```

Workflow:
1. Inspect the target Loom context.
2. Clarify the problem, constraints, non-goals, interfaces, and success criteria.
3. Produce one coherent design with tradeoffs, risks, rollout/rollback, validation, and observability.
4. Record the design in Loom using notes/nodes/patches within the assigned scope.
5. Summarize the design and any open decisions.
