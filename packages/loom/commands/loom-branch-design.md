---
description: Branch a Loom design/proposal into alternative design variants
argument-hint: "<loom/node> [variant count or constraints]"
---

Create alternative design variants for a Loom-backed proposal in this Claude Code session. Claude Code plugin commands cannot dispatch child agents; develop the variants directly, or produce scoped handoff tasks if the user wants parallel exploration. Use the `loom-branch-design` skill guidance when relevant.

User input:

```text
$ARGUMENTS
```

Workflow:
1. Inspect the target Loom context and decision criteria.
2. Create clear variant nodes or notes within the assigned scope.
3. For each variant, capture assumptions, architecture, tradeoffs, risks, validation, and when it wins/loses.
4. Add relationships/references needed for comparison.
5. Summarize variants and recommend whether a decision is ready.
