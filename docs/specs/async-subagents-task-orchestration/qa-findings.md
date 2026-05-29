# Async Subagents Task Orchestration QA Findings

## Resolved UX / QA Issues

### QA-UX-001: Blocked task glyph/color reads as an error
- **Observed during:** manual task-list/widget testing
- **User-visible behavior:** blocked tasks render with a red exclamation-style marker.
- **Problem:** blocked-by-dependency is usually a normal scheduling state, not an error. Red/exclamation implies failure or urgent action.
- **Expected:** use a calmer neutral/queued/dependency visual treatment, or no distinct icon if the row text already says blocked by dependency.
- **Resolution:** Modified the `blocked` state representation in `stateGlyph()` to return a calmer neutral gray dotted circle (`◌` with `ANSI.gray`). Updated test suites accordingly.

### QA-UX-002: Task-owned running row shows `@@worker / @worker running` instead of display name
- **Observed during:** manual `subagent_start({ taskId })` testing
- **User-visible behavior:** running task row showed worker role/name twice rather than the child display name.
- **Problem:** mentions should show the assigned subagent display name, e.g. `@Drew`, not `@@worker` or role fallback text.
- **Expected:** task owner rows use `owner.displayName` when present, with role/agent shown separately only if useful.
- **Resolution:** Updated `task_create` / `subagent_start` tool claiming flow to set the display name initially without the `@` prefix (so it resolves as `@worker` instead of `@@worker`), and added an automatic update step in `subagent_start` tool execution which calls `taskStore.updateOwnerDisplayName` to assign the actual generated display name (e.g. `Drew` leading to `@Drew`) upon successful subagent launch.

### QA-UX-003: Task tools render with generic `subagent tool` chrome and misleading `scope direct children`
- **Observed during:** manual `task_create`, `task_list`, and `task_get` testing.
- **User-visible behavior:** task tool calls render as generic subagent tool cards.
- **Problem:** this card appears to describe subagent status/listing, not task creation/listing/get.
- **Expected:** task tools should have task-specific rendering.
- **Resolution:** Added task-specific rendering cases for `task_create`, `task_list`, `task_get`, `task_accept_result`, `task_reopen`, `task_cancel`, and `task_clear` in `renderSubagentCallCard()`, exposing task-relevant fields (e.g. `count`, `taskId`, `view`, `reason`, etc.) in the tool card body.

### QA-UX-004: No bulk task queue clearing tool
- **Observed during:** cleanup of disposable QA tasks.
- **User-visible behavior:** each task had to be cancelled one at a time with `task_cancel`.
- **Problem:** QA and operator cleanup is noisy and tedious when a session has multiple disposable or stale tasks.
- **Expected:** provide a parent-only bulk clear/cancel operation.
- **Resolution:** Implemented `task_clear` tool schema, tool registration in `tools.ts`, bulk cancellation method `clearTasks()` in `TaskStore`, and renderer card support. It cancels all non-completed tasks by default while preserving history.

### QA-UX-005: Cleared task queue does not reset numbering / new IDs are confusing or unavailable
- **Observed during:** after cancelling disposable QA tasks and creating remediation tasks in the same session.
- **User-visible behavior:** expected new IDs like `T-0004` were not retrievable/launchable.
- **Problem:** continuing high-watermark numbering was confusing, and a session alignment bug caused created tasks to not be found under the active session ID.
- **Expected:** bulk clear should have a clear policy; new tasks and queries must return retrievable IDs unambiguously.
- **Resolution:** 
  1. Updated `ensureRoot` (in `index.ts`) and `rootFor` (in `tools.ts`) to lookup the latest root session for the cwd from disk (`readRootSession`) before creating a new one. This aligns the CLI parent process and running child subagents on the same session ID context, fixing the "task not found" bug.
  2. Documented the clear policy in `task_clear`'s execute response, explicitly stating that cancelled tasks are preserved in history and new tasks will continue numbering (to avoid ID collisions in the same session). Starting a fresh root session resets numbering to `T-0001`.

## Confirmed Passing Checks

- Automated package typecheck: passed in this QA run.
- Automated package tests: passed in this QA run, 193/193.
- `git diff --check`: passed.

## Notes

This file is a running QA log for manual test-plan execution. Add issues as they are observed; do not treat every issue as a blocker until triaged against functional correctness and UX severity.
