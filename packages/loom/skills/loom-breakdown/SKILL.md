---
name: loom-breakdown
description: Break a Loom node into research, design, planning, implementation, and review child nodes. Use when assigned to decompose Loom-backed work into durable graph structure.
---

Use this skill only when your assignment includes Loom context/reference or explicitly asks for Loom breakdown.

1. Fetch context for the assigned node.
2. Decide whether to decompose directly or propose/delegate a breakdown.
3. Create or recommend child nodes that are independently understandable and useful.
4. Branch alternatives when direction is uncertain; decompose when direction is chosen but too large.
5. For implementation breakdowns, add dependent review/validation nodes at practical granularity.
6. Record concise rationale and dependencies in Loom.

Implementation pattern:
- Implement A
- Review A depends on Implement A
- Implement B
- Review B depends on Implement B
- Integrate A+B depends on reviews
- Cross-consistency review depends on integration

Do not create noisy microtasks. Do not defer all review to one large final pass unless the scope is trivial. Do not edit Loom internals directly.
