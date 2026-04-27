---
name: loom-plan
description: Create Loom-backed implementation plans and task graphs from chosen designs, including dependencies and review/validation nodes. Use when assigned to plan Loom implementation work.
---

Use this skill only when your assignment includes Loom context/reference or explicitly asks for Loom planning. Skills are execution procedures for assigned agents; do not invoke Loom slash commands from child-agent work unless a human/parent explicitly asks you to reroute.

If working in a multi-Loom project, use the provided `LOOM_DEFAULT`, explicit `-L`, or `loom current` / `loom list` to confirm the target Loom before writing.

1. Fetch context for the target node.
2. Confirm a chosen design/decision exists. If not, stop and recommend a decision step.
3. Decompose into implementable task nodes with clear scope, dependencies, target repos, validation expectations, and stop conditions.
4. Add dependent review/validation nodes at practical granularity.
5. Identify worktree needs: source repos, base branches/commits, dirty-state checks, worktree branches/paths, and environment paths if known.
6. If other writers are also planning, stay within your assigned subtree/area and coordinate before touching shared dependencies.
7. Record assumptions, blockers, and next actions.
8. Return a mutation summary listing nodes/dependencies/notes created or updated, files touched if any, blockers, and recommended next skill/workflow.

Do not plan from all design branches at once. Do not defer all review to one big final pass unless the implementation is trivial. Prefer clean direct changes over compatibility layers unless justified.
