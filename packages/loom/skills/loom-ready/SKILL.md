---
name: loom-ready
description: Check whether Loom-backed work is ready for spec, design, planning, implementation, or review. Use before advancing a Loom node to the next workflow phase.
---

Use this skill only when your assignment includes Loom context/reference or explicitly asks for a Loom readiness check.

1. Fetch context for the target node.
2. Identify requested mode: `spec`, `design`, `plan`, `implement`, or `review`.
3. Return one of: PASS, BLOCKED, or READY-WITH-RISKS.
4. Give concise reasons, blockers, assumptions, and next actions.

Implementation readiness should check:
- chosen design/decision exists;
- task scope is clear;
- target repos, base branches/commits, and dirty state are known;
- worktree plan is defined when needed;
- validation commands/environment paths are known or explicitly deferred;
- review/validation path exists or is intentionally unnecessary;
- blockers and assumptions are explicit.

Do not mutate Loom unless explicitly requested. Do not edit Loom internals directly.
