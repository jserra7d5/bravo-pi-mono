---
description: Break a Loom node into useful child work items
argument-hint: "<loom/node> [breakdown constraints]"
---

Break down a Loom node directly in this Claude Code session. Claude Code plugin commands do not recursively delegate; use the `loom-breakdown` skill guidance and write only within the assigned Loom scope. If multi-agent execution is needed, create scoped task nodes/handoffs rather than spawning agents.

User input:

```text
$ARGUMENTS
```

Workflow:
1. Inspect the target node context.
2. Decide whether decomposition is appropriate or whether clarification/design is needed first.
3. Create child nodes that are independently understandable and useful.
4. Add dependencies/validation/review relationships where helpful.
5. Summarize what was created and remaining uncertainty.
