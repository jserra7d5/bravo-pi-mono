---
name: loom-analyze
description: Analyze Loom graph consistency, unresolved decisions, stale branches, implementation drift, review gaps, and architecture risks. Use when assigned to review or audit Loom-backed work.
---

Use this skill only when your assignment includes Loom context/reference or explicitly asks for Loom analysis. Skills are execution procedures for assigned agents; do not invoke Loom slash commands from child-agent work unless a human/parent explicitly asks you to reroute.

If working in a multi-Loom project, use the provided `LOOM_DEFAULT`, explicit `-L`, or `loom current` / `loom list` to confirm the target Loom before writing.

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
3. If multiple analysts are working, stay within your assigned scope and call out cross-scope dependencies for the coordinator.
4. Report findings by severity with evidence and concrete recommendations.
5. Write findings back with `loom note` only if requested.
6. Return a mutation summary; for read-only analysis this should usually say no Loom/file mutations were made.

Do not edit Loom internals directly.
