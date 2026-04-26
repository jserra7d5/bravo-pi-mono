---
description: Break down a Loom node into research, design, plan, implementation, or review children
argument-hint: "<loom/node> [mode or instructions]"
---

Break down the referenced Loom node. Use Loom only if a Loom/node/inbox reference or Loom context is provided.

User input:

```text
$ARGUMENTS
```

Workflow:
1. Fetch context for the node.
2. Decide whether direct decomposition is enough or whether agents should propose the breakdown.
3. Create child nodes that are independently understandable and useful.
4. For implementation breakdowns, include dependent review/validation nodes at practical granularity.
5. Preserve uncertainty explicitly; branch alternatives when direction is uncertain, decompose when direction is chosen but large.
6. Summarize the created/proposed structure concisely.

Do not create noisy microtasks or one giant final review when granular review is practical.
