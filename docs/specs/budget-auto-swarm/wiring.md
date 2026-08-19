# Wiring

## Module placement

All production changes remain under `packages/async-subagents`.

Recommended internal modules:

```text
packages/async-subagents/
├── agents/*.md
├── skills/
│   ├── pi-async-subagents/SKILL.md
│   └── budget-auto-swarm/SKILL.md
├── src/
│   ├── budgetLaunchPolicy.ts
│   └── installer.ts
└── extensions/pi/
    ├── budgetAutoSwarm.ts
    ├── index.ts
    ├── promptModule.ts
    ├── compactionReminder.ts
    └── tools.ts
```

`budgetAutoSwarm.ts` owns state parsing/restoration, command argument parsing, the status renderer, and calls into the existing task-runtime owner. `budgetLaunchPolicy.ts` owns pure resolved-definition validation so CLI/Pi seams can test it without a TUI.

Do not create another package or state root.

## Pi lifecycle

### Load

Extension factory registers `/budget-auto-swarm`. It does not start timers, processes, or file watchers.

In-memory state:

```ts
type BudgetAutoSwarmRuntime = {
  enabled: boolean;
};
```

The state is reconstructed rather than treated as durable by itself.

### Session start and tree navigation

On `session_start` and `session_tree`, one combined reconciler:

1. Replay valid `bravo-budget-auto-swarm-state` entries from `getBranch()` into a desired state without publishing it.
2. Restore/reconcile the existing task-runtime state through its canonical owner.
3. If desired budget state is enabled, ensure task state is enabled and successfully apply active task tools.
4. Only after success, publish in-memory budget enabled state, prompt/guard state, and both statuses.
5. On failure, publish budget disabled for this runtime, clear its badge/overlay/guard, preserve durable entries for retry, and notify/log the reconciliation error.

Branch replay is authoritative. Process state from the prior branch must not leak into a newly selected branch. The same reconciler runs for command activation, session start, and tree navigation so failure semantics cannot drift.

Fork/resume/reload behavior follows Pi’s normal branch/session entries. No environment propagation is required because child models must not inherit lead orchestration mode.

### Enable command

Command handler:

1. Parse `on`/empty.
2. If already enabled, refresh UI and notify current state; append no duplicate entry.
3. Reconcile task runtime and active tools through the combined lifecycle reconciler.
4. Only after success, append the budget-enabled state entry and publish enabled prompt/guard/badge state.
5. Notify the operator that Pi’s lead model is unchanged and launches are now budget-policy guarded.

If task state or active-tool application fails, no budget-enabled entry is appended and runtime budget state remains disabled.

### Disable command

1. If already disabled, refresh UI and return without a state entry.
2. Append `{ version: 1, enabled: false }`.
3. Clear in-memory state and badge.
4. Leave tasks and fast-track state unchanged.

### `/tasks off` integration

The existing `/tasks off` handler checks `budgetAutoSwarmEnabled()` before its existing active-blocker checks. If enabled, reject immediately with the contract error. There is one task-state owner; budget mode calls it but does not duplicate its storage or tool activation logic.

## Prompt assembly

`before_agent_start` already owns the lead async module, catalog, and session state. Extend that single chain:

```text
incoming system prompt
  → replace/append budget-aware base async-subagents module
  → replace/append conditional budget overlay
  → replace/append discovered-agent catalog
  → replace/append budget-aware live session-state block
```

When budget mode is enabled, base rendering removes/replaces the general default-thinking and fast-track paragraphs plus their hard-rule recaps. Live fast-track state reports armed-but-unavailable rather than permission. Disabled rendering is byte-compatible with the existing module.

Exact relative placement may preserve current cache/layout behavior, but the output must contain each marked block at most once and keep the budget overlay before its compact live-state line.

Functions should be pure string transforms:

```ts
appendBudgetAutoSwarmPrompt(systemPrompt: string, enabled: boolean): string
```

Disabled removes a stale marked block if present. This matters when toggling off in the same session: the next turn must not retain model-visible policy merely because an earlier transform appended it.

The model-visible state line derives from the same in-memory state as launch enforcement. Prompt and guard must never consult separate stores.

## Launch enforcement

### Boundary

`startSubagent` gains one optional pre-allocation policy hook/input. It runs immediately after agent discovery, variant application, and effective thinking resolution, before `createRunDirectory()` or any task/run/process side effect. The Pi tool supplies the budget policy when runtime mode is enabled; CLI starts omit it.

The tool must not rediscover/re-resolve definitions. `startSubagent` passes its single resolved launch view into the policy validator:

```ts
type ResolvedBudgetLaunch = {
  modeEnabled: boolean;
  variant?: string;
  resolvedHarness: "pi" | "claude";
  resolvedProvider: string;
  resolvedModel: string;
  effectiveThinkingLevel?: string;
  fastTrackRequested: boolean;
};
```

The policy requires `resolvedHarness: "pi"` in v1. Typed policy errors throw/return before allocation rather than using the existing post-allocation `failBeforeLaunch` path.

The guard compares exact resolved IDs:

```ts
const LUNA = "bravo-codex-balanced/gpt-5.6-luna";
const SOL = "bravo-codex-balanced/gpt-5.6-sol";
```

Allowed combinations are defined once in data and shared by validation/error formatting. Tests should prove error text and acceptance matrix derive from the same table.

### Why the Pi tool boundary

The mode is session state owned by the interactive Pi extension. The generic CLI remains usable by Claude and operators without hidden dependence on a Pi session. Claude follows the skill policy; Pi additionally enforces it.

The optional start policy is a call-scoped input, not process-global state. Do not add an environment switch that changes unrelated CLI launches.

### Audit metadata

Existing run metadata already records requested model, launched model, thinking level, variant, and fast-track application. No duplicate budget fields are required for every child. Add only:

```ts
budgetPolicy?: {
  active: true;
  route: "luna" | "sol";
};
```

if current launch metadata cannot otherwise prove that the guard ran. Prefer deriving from existing fields plus the parent session marker when possible. Do not add fields solely for display.

## Task/run pipeline

Pi mode uses the existing `TaskStore` through `task_*`. Claude uses Claude Code native task management and does not mirror graph state into `TaskStore`. Async-subagents stores only Claude child-run lifecycle records. Child execution cwd may differ without changing canonical run storage.

1. Lead creates tasks with dependencies through its adapter.
2. Lead starts compliant children and records attempts with `task_update`.
3. Child wakeups arrive as non-user steer messages.
4. Lead consumes result/attention, updates evidence/state.
5. `newly_ready` is synchronously available from task mutation.
6. Lead dispatches newly ready work immediately.
7. Compaction reminder reconstructs active/unread state from canonical stores.

No autonomous JavaScript scheduler dispatches children behind the model. The lead model makes task-shape, ownership, and escalation decisions; the harness enforces durable truth and launch bounds. This is deliberate: a static scheduler cannot infer safe write ownership or whether evidence satisfies a semantic prerequisite.

## Concurrency

V1’s eight-child limit and single-writer rule are agent policy, not process locks. Reasons:

- the runtime currently has no global child-cap queue;
- safe concurrency depends on ownership, provider capacity, and task shape;
- checkout write safety cannot be solved by counting processes alone.

The exact rendered prompt is reviewed for dispatch and backpressure policy, but prompt behavior is not an automated or release-gating eval surface. If normal-use traces repeatedly exceed safe capacity or overlap writers, that operational evidence may justify a deterministic scheduler/lease design in a later spec. Do not preemptively build one here.

## Compaction and resume

Budget state survives through the custom branch entry. Task/run truth already survives in runtime stores.

On `session_compact`:

- do not append a redundant budget state entry;
- read canonical task projections before deciding whether a reminder is needed;
- treat any nonterminal task (`open`, `active`, `blocked`, or `failed` requiring lead disposition), including a ready task with no run row, as independently reminder-worthy;
- build the reminder from canonical task/run projections;
- include the compact budget restart cue only when the mode is active and reminder-worthy work exists.

The current run-row early return must move after task inspection.

On reload/resume, the next `before_agent_start` rebuilds the full overlay. A stored prior assistant/user message containing skill text is not the Pi source of truth.

## Child isolation

Pi child launch continues to use:

```text
--no-context-files --no-skills --no-prompt-templates --no-extensions
--system-prompt <run>/artifacts/system.md
-p @<run>/artifacts/task.md
```

Only explicitly declared extensions/skills/includes load. The budget lead extension must not be added to `ASYNC_SUBAGENTS_INHERITED_EXTENSIONS`; children must not see the lead mode, command, badge, or launch guard.

Caveman inheritance remains independent and unchanged.

## Canonical CLI run storage

Add `--store-cwd` to all CLI lifecycle commands that address runs: `start`, `run`, `watch`, `status`, `wait`, `result`, `continue`, `message`, `pause`, and `cancel`. It chooses `RunStore` and root-session storage; `start`/`run --cwd` remains execution/definition cwd. `run` must propagate one store cwd through both its start and wait phases. Wire `StartSubagentInput.storageCwd` so storage/root identity resolve from `storageCwd ?? cwd`, while child status/execution and role discovery use `cwd`. Existing Pi `subagent_start` continues to pass session store root with an independent child cwd.

Do not add CLI task subcommands, a second Claude task schema, or a Claude-facing `TaskStore` adapter.

## Claude installation

Extend the existing async-subagents `install` command to create a second symlink:

| Link | Target |
|---|---|
| `~/.claude/skills/pi-async-subagents` | existing runtime skill |
| `~/.claude/skills/budget-auto-swarm` | new scheduler skill |

Move installer planning/application from `cli.ts` into `src/installer.ts`. Its production entry accepts a narrow filesystem port (`lstat`, `readlink`, `ensureDir`, `symlink`, `rename`, `remove`) defaulted to real Node filesystem operations; this is dependency injection, not an alternate behavior path. Apply calls `ensureDir` for launcher and skill parent directories before link operations; fresh-install tests exercise those real mutations.

Installer algorithm:

1. Preflight all source paths (both skill directories and built CLI).
2. Classify every destination (healthy symlink, stale symlink, real file/directory, absent) before mutation.
3. Without `--force`, any real-path conflict aborts with no mutation.
4. With `--force`, record every exact path authorized for replacement; still complete the full preflight before deleting anything.
5. Apply links in documented order: launcher, canonical runtime skill, budget skill. Use temp symlink + rename where supported so each individual replacement is atomic.
6. Return per-path action/result metadata.

Unexpected mutation failure does not delete or roll back pre-existing healthy links. Newly created/repointed links are reported precisely so the operator can rerun; the installer does not claim transactionality it cannot provide. Normal operation/conflicts/idempotency use the real CLI subprocess. Deterministic second/third-operation faults call the same production apply function with only the filesystem mutation port injected and prove healthy pre-existing links remain unchanged.

Update help, README, and onboarding only after implementation names and behavior are stable.

## Claude invocation

Claude Code expands `/budget-auto-swarm` and applies skill frontmatter for the invocation turn. The lead then uses the existing fixed CLI launcher.

The skill does not need to be installed into Pi child homes. It is a Claude lead skill. `resolveClaudeSkillInstallRequests()` remains available for child skills but is not the activation mechanism here.

The skill references `pi-async-subagents`. Claude skill systems do not provide a portable “include another skill body” directive, so the prompt instructs the model to load the canonical runtime skill if needed. Installer guarantees both names exist.

## Priority behavior

Pi:

- launch guard rejects `fastTrack: true` while enabled;
- the existing `/fast-track` toggle is untouched;
- a currently armed fast-track is visible in normal session state but the budget overlay’s normal-priority contract wins for starts;
- after mode disable, no cleanup/rearming is needed.

Claude:

- skill never passes `--fast-track`;
- there is no global toggle coupling because Claude invokes the CLI directly.

## TUI

Use `ctx.ui.setStatus`, not a widget. One stable mode label needs one line and has no richer state.

```ts
const badge = ctx.ui.theme.fg("#D5A3E9" /* or equivalent RGB helper */, "SWARM:auto");
ctx.ui.setStatus("budget-auto-swarm", badge);
```

Implementation must use the supported theme/RGB styling API available in the pinned Pi version; do not hardcode raw ANSI if a theme helper exists. The visible width is constant. Status updates are cached/gated per `(ui, key)` like the tasks badge. There is no custom timer, `setInterval`, widget factory, or footer replacement.

Responsive behavior is delegated to the existing footer/status layout. At very narrow widths the host may drop extension statuses according to its normal policy.

## Error and rollback behavior

- Invalid command: no state mutation.
- Task enable failure: budget activation aborts and remains disabled.
- Prompt-render failure: base Pi session remains usable; report extension error through normal Pi handling. Launch guard still uses runtime state.
- Launch-policy rejection: no run/task mutation.
- Badge-render failure must not affect policy or launch enforcement.
- Skill install conflict: existing files remain untouched unless forced.
- Mode disable is the rollback: it removes prompt overlay/guard on the next turn and preserves existing tasks/runs.

No data migration or destructive rollback exists.
