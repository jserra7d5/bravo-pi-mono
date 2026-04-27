---
description: Decide among Loom-backed alternatives and record rationale
argument-hint: "<loom/node> [decision criteria]"
---

Compare Loom-backed alternatives and record a decision in this Claude Code session. Claude Code plugin commands cannot delegate review; do the comparison directly with the `loom-decide` skill guidance, or stop and ask the user for missing criteria.

User input:

```text
$ARGUMENTS
```

Workflow:
1. Inspect the decision context and candidate alternatives.
2. Establish decision criteria and constraints.
3. Compare alternatives with evidence, tradeoffs, and risks.
4. Record the chosen option and rationale in Loom with a decision node/note and appropriate edges.
5. Summarize the decision, consequences, and follow-up tasks.
