---
description: Break down a Loom node into research, design, plan, implementation, or review children
argument-hint: "<loom/node> [mode or instructions]"
---

Route and orchestrate breakdown of the referenced Loom node. Use Loom only if a Loom/node/inbox reference or Loom context is provided. Slash commands choose the workflow and executing agent; child agents execute with Loom skills, not slash commands.

User input:

```text
$ARGUMENTS
```

Workflow:
1. Fetch context for the node.
2. Prefer reusing the persistent `loom-coordinator` for this Loom/workstream when one exists; create/recruit a new coordinator only if needed.
3. Decide whether direct decomposition is enough or whether an executing agent should use the `loom-breakdown` skill.
4. Create child nodes that are independently understandable and useful, or dispatch scoped writers to create them.
5. For implementation breakdowns, include dependent review/validation nodes at practical granularity.
6. Preserve uncertainty explicitly; branch alternatives when direction is uncertain, decompose when direction is chosen but large.
7. For multi-writer breakdowns, assign distinct node/subtree scopes and require mutation summaries listing created/updated nodes, notes, dependencies, files touched, and blockers.
8. Summarize the created/proposed structure concisely.

Do not create noisy microtasks or one giant final review when granular review is practical.
