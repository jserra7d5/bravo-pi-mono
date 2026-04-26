---
description: Coordinate implementation of Loom task nodes with worktrees, validation, and review
argument-hint: "<loom/node> [implementation instructions]"
---

Coordinate implementation for the referenced Loom task. Use Loom only if a Loom/node/inbox reference or Loom context is provided.

User input:

```text
$ARGUMENTS
```

Workflow:
1. Fetch task context and confirm readiness.
2. Use the worktree convention: worktrees live at `dirname(source_repo)/.worktrees/basename(source_repo)/`.
3. Record source repo, branch, commit, dirty state, worktree path/branch, validation env, and assigned agents.
4. Do not create worktrees from dirty source state silently.
5. Dispatch implementation agents only with bounded scope and review/validation expectations.
6. Record results, blockers, validation, and review outcomes in Loom.
7. Do not delete worktrees or branches without explicit approval.

Prefer integration worktrees for curated changes and worker worktrees for isolated attempts.
