---
description: Start or update a Loom-backed spec/proposal
argument-hint: "[proposal or feature idea]"
---

Use this root-session workflow to start or update durable Loom context for a spec, feature, research thread, or design effort. Slash commands are routing/orchestration entrypoints; child agents should receive Loom skills as their execution procedures, not slash-command prompts.

User input:

```text
$ARGUMENTS
```

Guidelines:
- If no Loom container exists for this project, suggest creating one and ask before running `loom init` unless the user explicitly requested creation.
- If a Loom container already exists but this is a distinct workstream, suggest `loom create-loom --name <name> --title <title>` rather than mixing unrelated work into the current Loom.
- If a Loom exists or the user provided a Loom/node reference, inspect current context first with `loom current` / `loom list` and the relevant node context.
- Prefer reusing a persistent `loom-coordinator` for the same Loom/workstream when one exists; create a new coordinator only when no suitable reusable coordinator is available.
- Capture the proposal at a high level: goal, scope, constraints, assumptions, open questions, and next recommended phase.
- Prefer Loom v2 commands (`loom node create`, `loom note add`, `loom patch apply`, `loom node update`) over manual `.loom` edits.
- When handing work to child agents, tell them which Loom skill to use, include the node/inbox reference, scope, mutation authority, expected deliverable, and stop conditions.
- For multi-writer work, assign distinct nodes/branches/artifacts/notes and require mutation summaries listing created/updated Loom objects and any files touched.
- Keep the user-facing response concise; store granular detail in Loom.
