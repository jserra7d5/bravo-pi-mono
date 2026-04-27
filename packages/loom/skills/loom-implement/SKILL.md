---
name: loom-implement
description: Coordinate Loom-backed implementation tasks using safe worktrees, bounded agents, validation, result recording, and dependent reviews. Use when assigned implementation work from a Loom node.
---

Use this skill only when your assignment includes Loom context/reference or explicitly asks for Loom implementation. Skills are execution procedures for assigned agents; do not invoke Loom slash commands from child-agent work unless a human/parent explicitly asks you to reroute.

If working in a multi-Loom project, use the provided `LOOM_DEFAULT`, explicit `-L`, or `loom current` / `loom list` to confirm the target Loom before writing.

1. Fetch task context and confirm implementation readiness.
2. For each source repo, use worktree root: `dirname(source_repo)/.worktrees/basename(source_repo)/`.
3. Before creating worktrees, record source repo, branch, commit, dirty state, base, validation environment, and intended worktree path/branch.
4. Do not create worktrees from dirty source state silently.
5. Use named branches: `loom/<loom-alias-or-id>/<node-id>-<slug>` and `loom/<loom-alias-or-id>/<node-id>-<slug>/<agent-or-attempt>`.
6. Use source repo virtualenv/dependency setup when provided.
7. Worker worktrees default to diff handoff; integration worktrees may commit at meaningful checkpoints.
8. For multi-writer implementation, stay within your assigned node/files/worktree/branch scope and stop before overlapping another writer's area unless the coordinator approves.
9. Record results, blockers, validation, and review outcomes in Loom.
10. Return a mutation summary: files changed, Loom nodes/notes/inbox items updated, branch/worktree or diff handoff, validation run, blockers, and follow-up review needed.
11. Do not delete worktrees or branches without explicit approval.

Ensure dependent review/validation nodes are completed before declaring the feature complete.
