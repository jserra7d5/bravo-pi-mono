---
description: Clarify a Loom-backed proposal, spec, design, or plan
argument-hint: "<loom/node> [focus]"
---

Route and orchestrate clarification of the referenced Loom work. Use Loom only if a Loom/node/inbox reference or Loom context is provided. Slash commands choose scope and execution; child agents execute with Loom skills, not slash commands.

User input:

```text
$ARGUMENTS
```

Workflow:
1. Inspect the relevant Loom context first (`loom context <node>` or `loom inbox show <id>`).
2. Prefer reusing the persistent `loom-coordinator` for this Loom/workstream when one exists, especially if answers should update shared context.
3. Identify high-impact ambiguities only: scope, user value, data model, architecture, security/privacy, validation, rollout, or task decomposition.
4. Ask a small number of targeted questions; prefer fewer questions over exhaustive interrogation.
5. If delegating, instruct the child agent to use `loom-clarify`, not this slash command, and define whether it may write notes.
6. Record accepted answers durably with Loom commands when requested or when already operating inside Loom.
7. For any delegated writer, require a mutation summary listing Loom notes/nodes updated and unresolved questions.
8. Report concise next steps.

Do not edit Loom internals directly.
