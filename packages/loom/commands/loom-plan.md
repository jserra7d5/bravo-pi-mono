---
description: Create a Loom-backed implementation plan from a chosen design
argument-hint: "<loom/node> [implementation constraints]"
---

Create an implementation plan for a Loom-backed feature/design in this Claude Code session. Claude Code does not have Tango-style recursive delegation here: do the planning directly, use the `loom-plan` skill guidance when relevant, and record durable graph updates with the Loom CLI. If the work needs multiple agents, produce scoped handoff tasks for the user instead of claiming to dispatch them.

User input:

```text
$ARGUMENTS
```

Workflow:
1. Fetch context for the plan node/design node.
2. Confirm a chosen design/decision exists. If not, stop and recommend `/loom-decide`.
3. Create/update implementable task nodes with clear scope, dependencies, target repos, validation expectations, mutation authority, and stop conditions.
4. Add dependent review/validation nodes at practical granularity.
5. Identify worktree needs, source repos, base branches/commits, and environment paths if known.
6. For work that would require multiple writers, record distinct scoped tasks and cross-scope coordination notes instead of delegating.
7. Summarize the plan concisely and note unresolved blockers.

Do not defer all review to one large final pass unless the implementation is trivial.
