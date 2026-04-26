---
description: Analyze Loom graph consistency, readiness, architecture risk, and implementation alignment
argument-hint: "<loom/node> [focus]"
---

Run a read-only Loom-aware analysis. Use Loom only if a Loom/node/inbox reference or Loom context is provided.

User input:

```text
$ARGUMENTS
```

Check for:
- unresolved decisions or stale branches;
- implementation tasks not tied to chosen design;
- rejected/deferred alternatives influencing current work;
- missing review/validation nodes;
- cross-consistency issues across proposal, design, plan, tasks, results, code references, and validation;
- architecture smells, hidden coupling, or unjustified compatibility layers.

Return findings by severity with evidence and concrete recommendations. Write back to Loom only if requested.
