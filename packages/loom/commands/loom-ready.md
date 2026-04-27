---
description: Check whether Loom-backed work is ready for the next phase
argument-hint: "<loom/node> [target phase]"
---

Check readiness for a Loom-backed node in this Claude Code session. Claude Code plugin commands do not delegate; use the `loom-ready` skill guidance directly and record blockers/readiness notes in Loom.

User input:

```text
$ARGUMENTS
```

Workflow:
1. Inspect the target node and requested next phase.
2. Verify required context, decisions, scope, validation expectations, ownership, and risks.
3. Mark readiness/blockers with Loom notes or node state updates as appropriate.
4. Summarize readiness verdict and required next actions.
