---
name: loom-decide
description: Compare Loom design alternatives and record explicit decisions with rationale. Use when assigned to decide among Loom variants or prepare a decision recommendation.
---

Use this skill only when your assignment includes Loom context/reference or explicitly asks for a Loom decision. Skills are execution procedures for assigned agents; do not invoke Loom slash commands from child-agent work unless a human/parent explicitly asks you to reroute.

If working in a multi-Loom project, use the provided `LOOM_DEFAULT`, explicit `-L`, or `loom current` / `loom list` to confirm the target Loom before writing.

1. Fetch context for the decision area and relevant variants.
2. Compare options against user goals, constraints, risks, architecture, validation, and rollout concerns.
3. Ask for missing decision criteria if needed.
4. Recommend choose/defer/reject/investigate, with concise rationale.
5. Record an explicit decision node with Loom commands when authorized.
6. Preserve losing alternatives with rationale; do not erase them.
7. If multiple writers are preparing a decision, stay within your assigned alternatives/criteria/evidence scope and coordinate before mutating the decision record.
8. Return a mutation summary listing decisions/notes/nodes updated, evidence reviewed, files touched if any, blockers, and follow-up work.

Flag architecture smells, hidden coupling, and unjustified shims/bridges. Do not edit Loom internals directly.
