---
name: loom-breakdown
description: Break a Loom node into research, design, planning, implementation, and review child nodes. Use when assigned to decompose Loom-backed work into durable graph structure.
---

Use this skill only when your assignment includes Loom context/reference or explicitly asks for Loom breakdown. Skills are execution procedures for assigned agents; do not invoke Loom slash commands from child-agent work unless a human/parent explicitly asks you to reroute.

If working in a multi-Loom project, use the provided `LOOM_DEFAULT`, explicit `-L`, or `loom current` / `loom list` to confirm the target Loom before writing.

1. Fetch context for the assigned node.
2. Decide whether to decompose directly or propose/delegate a breakdown.
3. Create or recommend child nodes that are independently understandable and useful.
4. Branch alternatives when direction is uncertain; decompose when direction is chosen but too large.
5. For implementation breakdowns, add dependent review/validation nodes at practical granularity.
6. If multiple writers are decomposing, stay within your assigned subtree/area and avoid overlapping child-node creation without coordinator approval.
7. Record concise rationale and dependencies in Loom.
8. Return a mutation summary listing nodes/dependencies/notes created or updated, files touched if any, blockers, and recommended next skill/workflow.

Implementation pattern:
- Implement A
- Review A depends on Implement A
- Implement B
- Review B depends on Implement B
- Integrate A+B depends on reviews
- Cross-consistency review depends on integration

Do not create noisy microtasks. Do not defer all review to one large final pass unless the scope is trivial. Do not edit Loom internals directly.
