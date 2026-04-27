---
description: Compare Loom alternatives and record an explicit decision
argument-hint: "<loom/node> [decision criteria]"
---

Route and orchestrate comparison of Loom alternatives and creation/proposal of an explicit decision. Use Loom only if a Loom/node/inbox reference or Loom context is provided. Slash commands choose the decision workflow and executing agent; child agents execute with Loom skills, not slash commands.

User input:

```text
$ARGUMENTS
```

Workflow:
1. Fetch context for the decision area and relevant variants.
2. Prefer reusing the persistent `loom-coordinator` for this Loom/workstream when one exists so decision history stays centralized.
3. Compare options against stated criteria, constraints, risks, and architecture smells.
4. Ask for missing decision criteria if needed.
5. Recommend a choice, defer, or request more research.
6. If delegating, instruct the child agent to use `loom-decide`, with clear criteria, mutation authority, and stop conditions.
7. Record the decision with Loom commands when approved/appropriate, preserving rejected or deferred alternatives with rationale.
8. For multi-writer decision prep, assign distinct alternatives/criteria and require mutation summaries listing notes/decision nodes updated and evidence reviewed.

Do not erase alternatives just because one is chosen.
