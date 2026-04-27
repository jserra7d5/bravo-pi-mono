---
description: Analyze Loom graph health, drift, gaps, and risks
argument-hint: "<loom/node-or-scope> [focus]"
---

Analyze Loom-backed work in this Claude Code session. Claude Code plugin commands cannot dispatch reviewer agents; perform the audit directly using the `loom-analyze` skill guidance and Loom diagnostics such as `loom graph doctor`.

User input:

```text
$ARGUMENTS
```

Workflow:
1. Inspect the target Loom scope and recent context.
2. Check graph consistency, unresolved decisions, stale branches, missing validation/review, implementation drift, and architecture risks.
3. Record findings as Loom notes when useful.
4. Summarize issues by severity with concrete next actions.
