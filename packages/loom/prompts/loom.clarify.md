---
description: Clarify a Loom-backed proposal, spec, design, or plan
argument-hint: "<loom/node> [focus]"
---

Clarify the referenced Loom work. Use Loom only if a Loom/node/inbox reference or Loom context is provided.

User input:

```text
$ARGUMENTS
```

Workflow:
1. Inspect the relevant Loom context first (`loom context <node>` or `loom inbox show <id>`).
2. Identify high-impact ambiguities only: scope, user value, data model, architecture, security/privacy, validation, rollout, or task decomposition.
3. Ask a small number of targeted questions; prefer fewer questions over exhaustive interrogation.
4. Record accepted answers durably with Loom commands when requested or when already operating inside Loom.
5. Report concise next steps.

Do not edit Loom internals directly.
