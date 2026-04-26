---
description: Start or update a Loom-backed spec/proposal
argument-hint: "[proposal or feature idea]"
---

Use this root-session workflow to start or update durable Loom context for a spec, feature, research thread, or design effort.

User input:

```text
$ARGUMENTS
```

Guidelines:
- If no Loom exists for this work, suggest creating one and ask before running `loom init` unless the user explicitly requested creation.
- If a Loom exists or the user provided a Loom/node reference, inspect current context first.
- Capture the proposal at a high level: goal, scope, constraints, assumptions, open questions, and next recommended phase.
- Prefer Loom commands (`loom create`, `loom note`, `loom decompose`, `loom resolve`) over manual `.loom` edits.
- Keep the user-facing response concise; store granular detail in Loom.
