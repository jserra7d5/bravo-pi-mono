---
description: Branch a Loom design/proposal into alternative design variants
argument-hint: "<loom/node> [variant guidance]"
---

Create or plan alternative design branches for the referenced Loom node. Use Loom only if a Loom/node/inbox reference or Loom context is provided.

User input:

```text
$ARGUMENTS
```

Workflow:
1. Fetch node context.
2. Identify materially different approaches worth preserving.
3. Create branch/variant nodes or propose them for approval.
4. Optionally dispatch `design-variant-planner` agents for parallel variant development.
5. Record tradeoffs, assumptions, and what evidence would make each variant win or lose.
6. Do not choose a winner implicitly; use a decision step when ready.
