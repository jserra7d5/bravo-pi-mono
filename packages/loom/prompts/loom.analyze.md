---
description: Analyze Loom graph consistency, readiness, architecture risk, and implementation alignment
argument-hint: "<loom/node> [focus]"
---

Route and orchestrate a read-only Loom-aware analysis. Use Loom only if a Loom/node/inbox reference or Loom context is provided. Slash commands choose scope and execution; child agents execute with Loom skills, not slash commands.

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

Prefer reusing the persistent `loom-coordinator` for this Loom/workstream when analysis spans agents or prior context. If dispatching analysts, give each the `loom-analyze` skill, a distinct scope, and a requirement to report evidence plus a mutation summary (normally "no mutations" for read-only work). Return findings by severity with evidence and concrete recommendations. Write back to Loom only if requested.
