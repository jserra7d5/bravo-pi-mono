---
name: loom-clarify
description: Clarify Loom-backed proposals, specs, designs, or plans by asking a few high-impact questions and recording answers durably. Use when assigned a Loom node, Loom inbox item, or explicit Loom clarification task.
---

Use this skill only when your assignment includes Loom context/reference or explicitly asks for Loom clarification. Skills are execution procedures for assigned agents; do not invoke Loom slash commands from child-agent work unless a human/parent explicitly asks you to reroute.

1. Inspect the assigned work: `loom context <node>` or `loom inbox show <id>`.
2. Identify only high-impact ambiguities: scope, user value, data model, architecture, security/privacy, validation, rollout, or task decomposition.
3. Ask a small number of targeted questions. Prefer fewer questions over exhaustive interrogation.
4. Record accepted answers with Loom commands when requested or when operating as the assigned Loom worker.
5. If multiple writers are clarifying, stay within your assigned question/topic/node scope and coordinate before writing shared conclusions.
6. Report remaining assumptions, deferred questions, and next recommended phase.
7. Return a mutation summary listing Loom notes/nodes updated, files touched if any, unresolved questions, and recommended next skill/workflow.

Prefer `loom note add` / `loom node update` over manual Markdown edits. In multi-Loom projects, use the provided `LOOM_DEFAULT`, explicit `-L`, or `loom current`/`loom list` to confirm the target Loom before writing. Do not edit `.loom/looms/*/index.sqlite`, `.loom/looms/*/runtime/runtime.sqlite`, `.loom/looms/*/events.jsonl`, locks, registry, container selection, or delivery internals.
