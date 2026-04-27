---
description: Create a Loom-backed implementation plan from a chosen design
argument-hint: "<loom/node> [implementation constraints]"
---

Route and orchestrate implementation planning for a Loom-backed feature/design. Use Loom only if a Loom/node/inbox reference or Loom context is provided. Slash commands select the workflow and executing agent; child agents execute with Loom skills, not slash commands.

User input:

```text
$ARGUMENTS
```

Workflow:
1. Fetch context for the plan node/design node.
2. Prefer reusing the persistent `loom-coordinator` for this Loom/workstream when one exists.
3. Confirm a chosen design/decision exists. If not, stop and recommend `loom.decide`.
4. Decompose directly only when authorized, or dispatch an executing agent with the `loom-plan` skill.
5. Decompose into implementable task nodes with clear scope, dependencies, target repos, validation expectations, mutation authority, and stop conditions.
6. Add dependent review/validation nodes at practical granularity.
7. Identify worktree needs, source repos, base branches/commits, and environment paths if known.
8. For multi-writer planning, assign distinct subtrees/areas and require mutation summaries listing nodes/dependencies/notes created or updated plus blockers.
9. Summarize the plan concisely and note unresolved blockers.

Do not defer all review to one large final pass unless the implementation is trivial.
