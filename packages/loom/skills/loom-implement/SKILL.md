---
name: loom-implement
description: Coordinate Loom-backed implementation tasks using safe worktrees, bounded agents, validation, result recording, and dependent reviews. Use when assigned implementation work from a Loom node.
---

Use this skill only when your assignment includes Loom context/reference or explicitly asks for Loom implementation.

If working in a multi-Loom project, use the provided `LOOM_DEFAULT`, explicit `-L`, or `loom current` / `loom list` to confirm the target Loom before writing.

1. Fetch task context and confirm implementation readiness.
2. For each source repo, use worktree root: `dirname(source_repo)/.worktrees/basename(source_repo)/`.
3. Before creating worktrees, record source repo, branch, commit, dirty state, base, validation environment, and intended worktree path/branch.
4. Do not create worktrees from dirty source state silently.
5. Use named branches: `loom/<loom-alias-or-id>/<node-id>-<slug>` and `loom/<loom-alias-or-id>/<node-id>-<slug>/<agent-or-attempt>`.
6. Use source repo virtualenv/dependency setup when provided.
7. Worker worktrees default to diff handoff; integration worktrees may commit at meaningful checkpoints.
8. Record results, blockers, validation, and review outcomes in Loom.
9. Do not delete worktrees or branches without explicit approval.

Ensure dependent review/validation nodes are completed before declaring the feature complete.
