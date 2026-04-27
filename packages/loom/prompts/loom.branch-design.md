---
description: Branch a Loom design/proposal into alternative design variants
argument-hint: "<loom/node> [variant guidance]"
---

Route and orchestrate alternative design branching for the referenced Loom node. Use Loom only if a Loom/node/inbox reference or Loom context is provided. Slash commands select the workflow and executing agent; child agents execute with Loom skills, not slash commands.

User input:

```text
$ARGUMENTS
```

Workflow:
1. Fetch node context.
2. Prefer reusing the persistent `loom-coordinator` for this Loom/workstream when one exists; otherwise identify the coordinator/lead that will own the design split.
3. Identify materially different approaches worth preserving.
4. Create branch/variant nodes directly only when this root session has mutation authority; otherwise instruct the executing agent to use the `loom-branch-design` skill.
5. If dispatching child agents for parallel variant development, give each a distinct node/branch/artifact scope and tell them to use Loom skills, not slash commands.
6. Require each writer to return a mutation summary: Loom nodes/branches/notes/decisions created or updated, files touched, validation/review performed, and blockers.
7. Record tradeoffs, assumptions, and what evidence would make each variant win or lose.
8. Do not choose a winner implicitly; use a decision step when ready.
