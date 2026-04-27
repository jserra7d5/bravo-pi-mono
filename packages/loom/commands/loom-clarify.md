---
description: Clarify a Loom-backed proposal, inbox item, or node
argument-hint: "<loom/node/inbox> [question focus]"
---

Clarify Loom-backed work in this Claude Code session. Claude Code plugin commands do not delegate; use the `loom-clarify` skill guidance directly, ask only high-impact questions, and record answers/blockers durably.

User input:

```text
$ARGUMENTS
```

Workflow:
1. Inspect the relevant Loom context or inbox item.
2. Identify ambiguity that blocks useful progress.
3. Ask a small number of high-impact questions, or record inferred answers if evidence is sufficient.
4. Update Loom with clarification notes, blockers, or node state changes.
5. Summarize clarified facts and remaining unknowns.
