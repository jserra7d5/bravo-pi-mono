# Review Log

This file records audit history. Current behavior remains authoritative in `design.md`, `contracts.md`, `prompting.md`, `wiring.md`, and `validation.md`.

## Initial audit — 2026-08-18

Three independent read-only lanes reviewed the frozen first draft. No prompt/model behavioral evals were run or recommended.

| ID | Severity | Disposition | Canonical remediation |
|---|---:|---|---|
| BAS-SPEC-001 | high | Accepted | `contracts.md` now defines CLI `task` subcommands as a thin adapter over the existing `TaskStore`; Claude uses one stable root-session ID for graph and runs. |
| BAS-SPEC-002 | high | Accepted | Budget launch routes are Pi-harness only; resolved harness is part of the pre-allocation matrix and has a typed rejection. |
| BAS-SPEC-003 | high | Accepted | One combined lifecycle reconciler publishes budget state only after canonical task state and active tools succeed. |
| BAS-PROMPT-001 / B3 | high | Accepted | Base thinking/fast-track text and live fast-track state render budget-aware; contradictory permissions are absent while enabled. |
| BAS-TOOL-002 | high | Accepted | Conditional tool-description mutation was deleted. Static tools remain unchanged; the overlay and typed errors own guidance. |
| BAS-TASK-003 | high | Accepted | Contract uses `task_update.addAttemptRunIds`; persisted projection is `TaskRecord.lastAttemptRunIds`. |
| B1 | high | Accepted | The policy hook lives inside `startSubagent` after single-source resolution and before `createRunDirectory`; Pi passes call-scoped policy. |
| B2 | high | Accepted | Compaction inspects task state before run-row early return; task-only nonterminal graphs are reminder-worthy. |
| B4 | high | Accepted | Installer preflights launcher and both skills before mutation, then reports each path; later failure preserves healthy pre-existing links. |
| B5 | high | Accepted | Command/start/tree share the same unpublished-desired-state reconciler and restore failure semantics. |
| BAS-SPEC-R001 / BAS-DOC-004 | medium | Accepted | Exact session-state wording normalized to the `prompting.md` canonical bytes. |
| BAS-CATALOG-005 | medium | Accepted | Spec no longer requires Pi variant model identity in the catalog; resolved IDs remain enforcement inputs. |
| BAS-SPEC-001-WT | high | Accepted | One canonical `--store-cwd` now addresses run/task/session storage across worktree execution cwd; all lifecycle commands propagate it and a two-worktree faithful test proves combined visibility. |
| C1 | high | Accepted | Shared structural task validators under `src` serve Pi and CLI; stateless validation occurs pre-mutation while graph semantics remain inside locked `TaskStore`. |
| C2 | high | Accepted | Installer production apply logic has a narrow filesystem mutation port, including parent-directory creation, for deterministic operation fault injection; fresh/normal behavior still runs through the real CLI subprocess. |
| BAS-SPEC-001-WT-RUN | high | Accepted | The existing synchronous `run` command now explicitly propagates canonical `--store-cwd` through both start and wait and is covered cross-worktree. |

## Operator re-plan — Claude graph ownership

The implementation review exposed that Claude Code already provides native task management. The prior CLI `TaskStore` adapter duplicated graph ownership and was removed before release. Current contract: Claude native Tasks own Claude dependency/progress state; Pi `task_*` owns Pi state; async-subagents CLI owns child-run lifecycle only.

## Baseline evidence from audit

- Installed Pi: `0.84.2`.
- Installed Claude Code: `2.1.235`.
- `npm run check --workspace @bravo/async-subagents`: passed.
- `npm test --workspace @bravo/async-subagents`: 457/458 passed; one pre-existing timing-sensitive Claude tmux test failed (`expected completed, got failed`). This is baseline evidence, not feature validation.

## Closure status

Prompt/tool closure passed. Architecture/runtime closure found and remediated BAS-SPEC-001-WT, C1, C2, and the follow-up synchronous-run/installer-parent gaps above. Final finding-scoped closure passed with no direct contradictions. The frozen specification is ready for implementation.
