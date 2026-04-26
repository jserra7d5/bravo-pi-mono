---
name: loom-analyze
description: Analyze Loom graph consistency, unresolved decisions, stale branches, implementation drift, review gaps, and architecture risks. Use when assigned to review or audit Loom-backed work.
---

Use this skill only when your assignment includes Loom context/reference or explicitly asks for Loom analysis.

This is read-only unless explicitly told to write findings back.

1. Fetch Loom context for the target node or inbox item.
2. Check graph consistency:
   - unresolved decisions;
   - stale/rejected branches influencing current work;
   - tasks not tied to chosen design;
   - missing review/validation nodes;
   - implementation results without validation;
   - broken or missing references;
   - architecture smells, hidden coupling, cross-consistency issues, and unjustified compatibility layers.
3. Report findings by severity with evidence and concrete recommendations.
4. Write findings back with `loom note` only if requested.

Do not edit Loom internals directly.
