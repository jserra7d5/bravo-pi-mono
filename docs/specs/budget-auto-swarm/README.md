# Budget Auto Swarm

## Status

Draft design for review. No implementation exists yet.

## Objective

Add one autonomous orchestration policy with two activation surfaces:

- Pi: a sticky, session-scoped `/budget-auto-swarm on|off|status` mode inside `@bravo/async-subagents`.
- Claude Code: a user-invoked `/budget-auto-swarm` skill that runs its invocation turn on Claude Opus 5 at medium effort and coordinates the same async-subagents runtime.

The policy is for long-running task graphs with complex dependencies. It keeps every safe ready lane moving, uses Luna as the default worker model, selectively escalates to Sol, and never requests fast-track priority.

## Source-of-truth map

| File | Authority |
|---|---|
| [`design.md`](design.md) | Intent, ownership, architecture, scope, model-routing rationale, and stop/re-plan triggers. |
| [`contracts.md`](contracts.md) | Commands, sticky state, model variants, enforcement, task-graph lifecycle, error behavior, and compatibility. |
| [`prompting.md`](prompting.md) | Every model-visible prompt surface and the verbatim Pi overlay and Claude skill content. |
| [`wiring.md`](wiring.md) | Pi/Claude activation, harness-native graph ownership, launch interception, run-store persistence, compaction, and TUI lifecycle. |
| [`validation.md`](validation.md) | Runtime invariants, faithful seams, fault cases, exact prompt inspection, and release evidence. |
| [`implementation-plan.md`](implementation-plan.md) | Dependency-ordered implementation increments and write boundaries. |
| [`review-log.md`](review-log.md) | Stable audit finding IDs, dispositions, and closure status; historical rationale only, never a competing current contract. |

Each fact has one canonical home. Other files link rather than restate full contracts.

## Fixed decisions

- The feature lives in `packages/async-subagents`; it is not a new scheduler or package.
- Existing roles remain the role vocabulary. `luna` and `sol` are model-only variants; per-launch `thinkingLevel` remains the effort control.
- Budget routing applies to new child starts. It does not rewrite a live or recorded child’s model.
- Pi mode changes orchestration policy, not the lead model.
- Claude activation uses a skill, which is already a slash command. No duplicate `.claude/commands` file is added.
- Claude skill model/effort overrides are turn-scoped by Claude Code. Reinvoke the skill after a user-authored continuation if the chain must continue under Opus 5 medium.
- Normal service tier is mandatory. `fastTrack: true` is rejected while Pi mode is active and forbidden by the Claude skill.
- The purple badge is UI-only. Model policy comes from prompt injection and launch enforcement.

## Current decision gates

None required before implementation. Model-routing thresholds are explicit operator policy informed by current benchmark evidence, not universal capability claims.
