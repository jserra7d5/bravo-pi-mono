---
description: Coordinate implementation of Loom task nodes with worktrees, validation, and review
argument-hint: "<loom/node> [implementation instructions]"
---

Route and orchestrate implementation for the referenced Loom task. Use Loom only if a Loom/node/inbox reference or Loom context is provided. Slash commands are coordinator/root-session entrypoints; implementation agents execute with Loom skills, not slash commands.

User input:

```text
$ARGUMENTS
```

Workflow:
1. Fetch task context and confirm readiness.
2. Prefer reusing the persistent `loom-coordinator` for this Loom/workstream to own assignment, status, and integration memory.
3. Use the worktree convention: worktrees live at `dirname(source_repo)/.worktrees/basename(source_repo)/`.
4. Record source repo, branch, commit, dirty state, worktree path/branch, validation env, and assigned agents.
5. Do not create worktrees from dirty source state silently.
6. Dispatch implementation agents only with bounded scope, the `loom-implement` skill (or another specific Loom skill), review/validation expectations, mutation authority, and stop conditions.
7. For multi-writer implementation, scope writers to distinct nodes/files/worktrees/branches; avoid overlapping edits unless a coordinator explicitly serializes integration.
8. Require mutation summaries from every writer: files changed, Loom nodes/notes/inbox items updated, validation run, blockers, and handoff branch/diff location.
9. Record results, blockers, validation, and review outcomes in Loom.
10. Do not delete worktrees or branches without explicit approval.

Prefer integration worktrees for curated changes and worker worktrees for isolated attempts.
