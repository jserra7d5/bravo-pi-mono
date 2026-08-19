# Implementation Plan

## Dependency graph

```text
A. Freeze contracts and prompt bytes
├── B. Add pure model variants
├── C. Add sticky Pi mode + task coupling + badge
│   ├── D. Conditional prompt/session/compaction rendering
│   └── E. Launch-policy guard
├── F. Add Claude skill + installer wiring
└── G. Integration validation and docs
    └── H. Independent release audit
```

A is the contract gate. B, C, and F may proceed independently after it. D and E depend on C. G waits for B–F. H reviews one frozen candidate.

## Write ownership

Use one implementation writer for `packages/async-subagents` because the extension entrypoint, prompt module, tools, and tests share imports and contracts. Parallel implementation in one checkout would create merge and contamination risk. Independent reviewers remain read-only.

Protected source of truth during implementation:

```text
docs/specs/budget-auto-swarm/**
```

Any contract change discovered during implementation returns to the root lead for a spec decision before code is altered to fit a new assumption.

## Increment A — freeze constants and current-state probes

### Work

- Confirm the installed Pi/Claude versions expose the APIs/frontmatter named in the spec.
- Probe the current extension host harness, task-runtime mutator boundaries, `startSubagent` resolution/allocation order, compaction task ordering, installer semantics, CLI run-store access, Claude native task ownership, and status color API.
- Record any contradiction as a decision gate. Do not patch around it.
- Choose one canonical source file/constant for the Pi overlay and one for the Claude skill body.

### Gate

- Current-state evidence confirms one call-scoped `startSubagent` policy hook can run after resolved variant/thinking selection but before run allocation or task/process side effects.
- Existing task state can be enabled through one canonical owner.
- Claude Code accepts `model`, `effort`, `disable-model-invocation`, and `disallowed-tools` in local skill frontmatter, or the spec is revised before implementation.
- No prompt/model eval harness is introduced.

## Increment B — model-only variants

### Work

- Add `luna` and `sol` variants to all five built-in role definitions.
- Preserve existing `gemini` variant and base definition behavior.
- Update stale README defaults while touching this surface.
- Add discovery/resolution/catalog tests.

### Gate

- Real definition loader resolves exact model IDs.
- Role body, tools, extensions, mode, and depth remain byte/structurally identical across model-only variants.
- `thinkingLevel` launch override still wins.

## Increment C — sticky Pi mode, task coupling, and badge

### Work

- Add `budgetAutoSwarm.ts` state/parser/command/status module.
- Expose or reuse the existing canonical task-runtime enable mutator; do not duplicate marker/store logic.
- Register `/budget-auto-swarm`.
- Guard `/tasks off` while mode is enabled.
- Implement one combined reconciler for command activation, `session_start`, and `session_tree`; publish budget state only after task state and active tools succeed.
- Render value-gated lavender `SWARM:auto` status.

### Gate

- Real extension host/session tests prove branch-correct restoration and task coupling.
- Task-store or active-tool failure on command/start/tree cannot publish budget enabled with tasks unavailable; durable desired state remains retryable.
- UI failure cannot change policy state.
- Badge is one status surface, not a widget/footer duplicate.

## Increment D — prompt and compaction integration

### Work

- Add marked idempotent conditional overlay using the exact text in `prompting.md`.
- Make the base module and live fast-track state budget-aware so conflicting thinking/priority rules are absent.
- Extend live session-state rendering with one compact line.
- Move compaction reminder task inspection before its run-row early return and add one restart cue.
- Ensure toggle-off removes stale marked content on the next turn.
- Keep child prompt assembly unchanged and test absence.

### Gate

- Real `before_agent_start` chain emits exact bytes once.
- Enabled rendering has no contradictory default-thinking or fast-track permission; disabled/toggle-off restores current guidance and emits no budget text.
- Child `system.md` and `task.md` contain no inherited lead policy.
- Spec prompt block and production constant/file pass the byte-drift check.

## Increment E — deterministic launch-policy guard

### Work

- Implement pure resolved-launch matrix validation, including Pi-only harness.
- Add one optional call-scoped policy hook to `startSubagent`; invoke it after definition/variant/thinking resolution and before `createRunDirectory()` or all other side effects. Pi supplies it; CLI omits it.
- Return typed corrective errors; never silently rewrite.
- Preserve `subagent_continue` semantics.
- Add mode-off compatibility and no-side-effect fault tests.

### Gate

- Full allowed/denied matrix passes.
- Rejected launches create no run dir/index, make no task mutation, call no preflight, and spawn no supervisor; project Claude-harness spoof routes are rejected there too.
- Compliant launches generate normal-priority commands/metadata.
- Mode off preserves prior behavior.

## Increment F — CLI run storage, Claude skill, and install

### Work

- Keep Claude Code native task management as the sole Claude graph/dependency owner; add no async-subagents CLI task adapter.
- Add `--store-cwd` to every run lifecycle command, including both phases of synchronous `run`, plus `StartSubagentInput.storageCwd`, separating canonical run-store identity from child execution `--cwd`.
- Add two-worktree tests proving `start`/`run`, combined watch, and result visibility share one run store.
- Add the exact `budget-auto-swarm/SKILL.md` and update `pi-async-subagents` with run-store command reference.
- Refactor installer to a production planner/apply module with a narrow filesystem port including parent-directory creation; preflight launcher and both skill destinations before mutation, create missing parents, then link all three with per-path results.
- Update install JSON/help and focused tests.
- Validate local discovery/parser behavior without invoking a model.
- Add a narrow `allowed-tools` rule only if exact installed-version syntax is proven; otherwise omit it.

### Gate

- Real CLI subprocesses operate on one child-run group across separate execution worktrees while Claude native Tasks remain the sole Claude graph.
- Real installer subprocess is idempotent/non-destructive for normal/conflict cases; the same production apply function passes deterministic later-fault tests through its injected filesystem port.
- Installed bytes match source.
- Claude’s local command/skill discovery lists `/budget-auto-swarm` where a non-model listing seam exists.
- User settings remain unchanged by installation/validation.

## Increment G — integration, docs, and release evidence

### Work

- Update `packages/async-subagents/README.md`, root/onboarding docs, and command/variant references.
- Run focused and full validation commands from `validation.md`.
- Capture exact Pi prompt, Claude skill, launch metadata, forbidden-launch no-side-effect proof, and TUI observations.
- Freeze the candidate diff/commit.

### Gate

- Package and repo commands pass.
- Real extension entrypoint and start path ran at faithful local seams with injected faults.
- Documentation matches executable behavior and contains no claim of persistent Claude model switching.
- No prompt evals were run or added.

## Increment H — review

### Initial review

Independent reviewer checks the frozen candidate against the complete spec, focusing on:

- state/task ownership and cross-worktree run-store identity;
- launch side-effect ordering and Pi-only harness policy;
- prompt duplication/precedence;
- child isolation;
- installer preflight/mutation safety;
- task-only compaction continuity;
- TUI status behavior;
- deterministic test fidelity.

The root lead assigns stable finding IDs and decides each finding against the accepted contract.

### Closure

Continue the original reviewer only against accepted finding IDs and fix-induced regressions.

### Release audit

One fresh reviewer independently checks the final frozen candidate, packaging, documentation, and evidence. No model/prompt behavior eval is requested.

## Rollout

This ships as an additive async-subagents package update:

1. Land on `main` with validation evidence.
2. Follow normal repository release/tag process.
3. Run `async-subagents install` to create/update the new Claude skill link.
4. Existing sessions remain disabled until explicitly activated.
5. Operators can roll back per session with `/budget-auto-swarm off` before package rollback/reload.

No state migration or coordinated consumer rollout is required.

## Completion bar

Implementation is complete only when:

- every fixed decision and contract in this directory is implemented or explicitly re-decided before code;
- exact agent-visible prompt/skill content matches `prompting.md`;
- the real extension/start/installer paths pass the deterministic invariant and fault matrix;
- no prompt eval mechanism or evidence is part of the feature;
- the frozen candidate passes initial, closure if needed, and final release review;
- unrelated pre-existing dirty files remain untouched.
