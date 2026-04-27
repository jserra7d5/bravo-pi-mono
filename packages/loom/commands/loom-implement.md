---
description: Implement Loom-backed tasks with durable progress tracking
argument-hint: "<loom/node/task> [constraints]"
---

Implement Loom-backed work in this Claude Code session. Claude Code plugin commands cannot spawn a persistent `loom-coordinator` or recursively delegate; use the `loom-implement` skill guidance directly, stay within the assigned scope, and record progress in Loom. If parallel agents are needed, stop and provide scoped handoff instructions for the user.

User input:

```text
$ARGUMENTS
```

Workflow:
1. Inspect the assigned Loom node/context and confirm scope, acceptance criteria, and mutation authority.
2. Check repo state before edits. Do not create worktrees from dirty source state silently.
3. Implement the smallest coherent slice.
4. Record Loom notes for decisions, blockers, validation, and results using v2 commands such as `loom note add`, `loom node update`, and `loom patch apply`.
5. Run practical validation. If validation becomes long-running or exposes unrelated failures, stop and report.
6. Return a mutation summary: files changed, Loom nodes/notes updated, validation run, blockers, and follow-up review needed.
