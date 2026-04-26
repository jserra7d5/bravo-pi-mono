---
name: loom-clarify
description: Clarify Loom-backed proposals, specs, designs, or plans by asking a few high-impact questions and recording answers durably. Use when assigned a Loom node, Loom inbox item, or explicit Loom clarification task.
---

Use this skill only when your assignment includes Loom context/reference or explicitly asks for Loom clarification.

1. Inspect the assigned work: `loom context <node>` or `loom inbox show <id>`.
2. Identify only high-impact ambiguities: scope, user value, data model, architecture, security/privacy, validation, rollout, or task decomposition.
3. Ask a small number of targeted questions. Prefer fewer questions over exhaustive interrogation.
4. Record accepted answers with Loom commands when requested or when operating as the assigned Loom worker.
5. Report remaining assumptions, deferred questions, and next recommended phase.

Prefer `loom note` / `loom resolve` over manual Markdown edits. Do not edit `.loom/index.sqlite`, `.loom/runtime/runtime.sqlite`, `.loom/events.jsonl`, locks, registry, or delivery internals.
