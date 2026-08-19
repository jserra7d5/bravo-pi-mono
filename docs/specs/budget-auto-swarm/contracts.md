# Contracts

## Pi command

Register one extension command:

```text
/budget-auto-swarm [on|off|status]
```

Argument behavior:

| Input | Result |
|---|---|
| empty | Enable. Idempotent if already enabled. |
| `on` | Enable. Idempotent. |
| `off` | Disable. Idempotent. |
| `status` | Report current state, task coupling, allowed routes, and normal-priority requirement without changing state. |
| anything else | Notify error with accepted values; do not mutate state. |

Commands do not trigger an LLM turn.

### Durable state

Custom entry:

```ts
const BUDGET_AUTO_SWARM_STATE_ENTRY_TYPE = "bravo-budget-auto-swarm-state";

type BudgetAutoSwarmStateEntry = {
  version: 1;
  enabled: boolean;
};
```

Rules:

- Append one entry only when the effective state changes.
- Restore by replaying matching entries from `ctx.sessionManager.getBranch()` in order; latest valid entry wins.
- Ignore malformed entries and unsupported versions.
- No process environment variable is authoritative for lead state.
- State is session/branch scoped, not global.

### Task coupling

Enabling budget-auto-swarm requires task orchestration:

1. Reconcile the existing task-runtime owner to enabled and activate its tools.
2. Only after that succeeds, publish in-memory budget state and persist the budget-enabled marker.
3. Refresh both badges.

One combined reconciler owns activation and restore. If task state or active-tool application fails, budget mode remains unpublished for that runtime: no lead overlay, launch guard, or badge becomes active. Durable prior entries are preserved for retry on a later start/tree event, and the extension surfaces the reconciliation error.

Turning `/tasks off` while budget mode is enabled fails with:

```text
Task orchestration is required by budget-auto-swarm. Disable /budget-auto-swarm first.
```

Disabling budget mode leaves task orchestration unchanged. This avoids silently changing a separately visible operator preference on exit.

### Published-state transition table

`desired` is replayed branch state; `published` controls prompt, launch guard, and badge.

| Event | Desired before | Reconciliation | Persist | Published after |
|---|---|---|---|---|
| command `on` | off | enable task runtime + apply task tools succeeds | task marker if changed, then budget `enabled:true` | on |
| command `on` | off | task/tool step fails | no budget entry | off; error surfaced |
| command `off` | on | no task disable | budget `enabled:false` | off |
| start/tree restore | on | task runtime + tools succeed | no new budget entry | on |
| start/tree restore | on | task/tool step fails | no new entry; retain desired durable state | off for this runtime; retry on later lifecycle event |
| start/tree restore | off/absent | restore normal task state | no budget entry | off |
| `/tasks off` | on | rejected before task mutation | none | on |

Only published state is visible to `before_agent_start` and the start policy hook. A durable desired-on entry never enables enforcement by itself.

### Status badge

Status key:

```text
budget-auto-swarm
```

Visible text:

```text
SWARM:auto
```

Color: identity lavender `#D5A3E9` from the shared repo palette. Rendering uses theme/ANSI safely and `setStatusIfChanged`-style value gating. Disabled state clears the key. No timer or render-clock subscription is needed because the value changes only on command/session transitions.

The badge is UI-only and is never used as the source of model policy.

## Model variants

Add these variants to `scout`, `planner`, `worker`, `reviewer`, and `generalist`:

```yaml
variants:
  luna:
    model: bravo-codex-balanced/gpt-5.6-luna
  sol:
    model: bravo-codex-balanced/gpt-5.6-sol
```

Existing fields remain inherited, including tools, extensions, mode, context/session policy, budgets, and role body. Existing `gemini` variants remain unchanged.

`thinkingLevel` is not set in `luna` or `sol`. The resolved base definition supplies its normal default when the caller omits a launch override; budget guidance tells the lead to pass an explicit level. `subagent_start.thinkingLevel` remains the authoritative per-run override.

### Budget-mode allowed launch matrix

While Pi budget mode is active, `subagent_start` accepts only:

| Field | Allowed |
|---|---|
| `agent` | Any resolved agent definition whose selected route satisfies the model policy. Built-ins are the supported v1 target. |
| `variant` | `luna` or `sol`. |
| `thinkingLevel` with `luna` | `high`, `xhigh`, `max`. |
| `thinkingLevel` with `sol` | `low`, `medium`. |
| `fastTrack` | omitted or `false`. |
| `context`, `session`, scopes, skills | Existing validation applies unchanged. |

A custom/user/project role may participate only when its selected `luna`/`sol` variant resolves to `harness: "pi"` and the exact allowed provider/model ID. Variant name alone is insufficient. Claude-harness children are outside the v1 budget portfolio because `thinkingLevel` is Pi-only.

The guard validates the resolved definition, not raw arguments. This prevents a project override from naming a `luna` variant that points elsewhere.

### Launch-policy errors

Validation occurs before run creation, model preflight, supervisor spawn, or task mutation.

```ts
type BudgetLaunchPolicyError = {
  code:
    | "BUDGET_SWARM_VARIANT_REQUIRED"
    | "BUDGET_SWARM_HARNESS_NOT_ALLOWED"
    | "BUDGET_SWARM_MODEL_NOT_ALLOWED"
    | "BUDGET_SWARM_THINKING_NOT_ALLOWED"
    | "BUDGET_SWARM_FAST_TRACK_FORBIDDEN";
  message: string;
  allowed: {
    luna: ["high", "xhigh", "max"];
    sol: ["low", "medium"];
    fastTrack: false;
  };
};
```

Errors teach the valid correction. They never silently rewrite a launch. Silent rerouting would corrupt auditability and make the lead’s model choice unverifiable.

### Continuation

`subagent_continue` preserves the recorded run’s model, effort, provider, and fast-track state under existing semantics.

Budget mode does not block continuation of a pre-existing out-of-portfolio run because rewriting or abandoning recorded work is worse than preserving continuity. The prompt tells the lead to:

- continue only when continuity is the concrete advantage;
- otherwise start a fresh compliant run;
- disclose any inherited non-budget or fast-track continuation in task evidence.

No new `variant`, `thinkingLevel`, or `fastTrack` fields are added to `subagent_continue`.

## Lead prompt-state contract

When budget mode is enabled, the async-subagents session-state block includes:

```md
Budget auto swarm: enabled (normal service tier; Luna high/xhigh is the default workhorse; Sol low/medium requires a task-specific reason).
```

When disabled, the line is omitted rather than rendering negative instructions.

The full orchestration overlay is conditionally inserted once as specified in [`prompting.md`](prompting.md). Repeated `before_agent_start` calls must not duplicate it.

## Task-graph contract

### Task state

Existing task statuses remain unchanged:

```text
open | active | blocked | done | failed | cancelled
```

Readiness remains derived:

```text
ready | waiting | null
```

No new scheduler status is added.

### Task creation

Before sustained dispatch, the lead creates tasks for coarse milestones with explicit dependencies. Each task description must carry enough contract for attempts to be briefed without reconstructing hidden lead reasoning:

- objective;
- completion bar;
- expected artifacts/evidence;
- dependency meaning when non-obvious;
- stop/re-plan trigger where material.

A task may be created just-in-time when its shape depends on upstream evidence. The mode does not require speculative creation of the entire graph at turn one.

### Run attachment

When a run starts for a task, the lead immediately calls `task_update` with:

- `status: "active"`;
- `addAttemptRunIds: [runId]`;
- `appendNotes` naming role, variant, thinking level, and ownership boundary.

The persisted projection is `TaskRecord.lastAttemptRunIds`; no task schema change is introduced.

When the run finishes, the lead records result/evidence before setting terminal task state. A terminal run never automatically marks a task done.

### Ready-set scheduling

`task_create` and `task_update` return `newly_ready`. The lead treats this return as synchronous scheduling input in the current turn.

A ready task may remain undispatched only when one of these is recorded:

- write ownership conflict;
- global useful-concurrency cap;
- missing concrete input despite dependency status (contract defect to fix);
- deliberate critical-path prioritization;
- user/authorization block.

### Retries and escalation

A failed attempt leaves the task `active` when another attempt is immediately credible, `blocked` when a decision/input is required, or `failed` when the task cannot meet its accepted contract.

The task note records:

- failure class;
- evidence from the attempt;
- whether the next attempt is continue or fresh;
- model/effort change and reason, if any.

After two failed attempts in the same conceptual area, the task becomes `blocked` pending lead re-plan. A third blind retry violates the mode contract.

### Completion

The lead may declare the swarm complete only after checking:

```ts
type SwarmCompletion = {
  requiredTasksTerminal: true;
  noUnhandledChildAttentionOrResults: true;
  integrationChecked: true;
  validationEvidenceRecorded: true;
  originalOutcomeSatisfied: true;
};
```

This object is conceptual prompt policy in v1, not a new persisted schema or tool.

## Claude graph ownership

Claude Code's native task management is the sole work/dependency owner for Claude leads. The skill uses native tasks for decomposition, dependencies, readiness, progress, and completion. Async-subagents does not expose a second CLI task ledger to Claude, and the skill must not ask Claude to mirror native task state into Pi `TaskStore` records.

Pi `task_*` tools and storage remain unchanged and are still mandatory while the sticky Pi mode is enabled.

### Canonical run store versus execution cwd

All CLI lifecycle commands that address runs accept `--store-cwd DIR`: `start`, `run`, `watch`, `status`, `wait`, `result`, `continue`, `message`, `pause`, and `cancel`. `run` propagates the same canonical store cwd through both its start and terminal-wait phases. It selects the shared store only. `start --cwd DIR` separately selects child definition/project context and execution checkout. A start in another worktree therefore uses:

```text
async-subagents start --store-cwd /canonical/checkout --cwd /writer/worktree ...
```

`StartSubagentInput` gains `storageCwd?: string`; `RunStore` and root identity resolve from `storageCwd ?? cwd`, while agent discovery, prompt context, status `cwd`, and child execution resolve from `cwd`. Existing explicit `runRoot` remains authoritative when supplied. Pi already has the equivalent split (`sessionCwd` for store, tool `cwd` for execution) and preserves it.

The root ID and canonical store cwd together identify the child-run group. Same root ID with different store cwd splits run visibility and is forbidden within one swarm.

## Claude skill contract

Install path:

```text
~/.claude/skills/budget-auto-swarm/SKILL.md
```

Source path:

```text
packages/async-subagents/skills/budget-auto-swarm/SKILL.md
```

Frontmatter:

```yaml
---
name: budget-auto-swarm
description: Run a long autonomous dependency graph through Pi async subagents with cost-focused model routing and continual pipeline refill. Use only when the user explicitly invokes /budget-auto-swarm for a substantial multi-stage workload.
disable-model-invocation: true
model: claude-opus-5
effort: medium
disallowed-tools: [AskUserQuestion]
---
```

The implementation may add a narrow `allowed-tools` Bash rule only after verifying Claude Code’s exact permission-rule syntax against the installed version. It must not grant unrestricted shell access merely to avoid prompts.

The skill body is specified verbatim in [`prompting.md`](prompting.md).

### Claude turn semantics

Contract with current Claude Code:

- model and effort override the rest of the invocation turn;
- they are not saved to settings;
- the session model resumes on the next user prompt;
- skill instructions stay in conversation context and survive compaction subject to Claude’s skill budgets;
- user must reinvoke after a user-authored continuation to reapply Opus 5 medium.

The skill must never claim a persistent model toggle.

## Fast-track / priority contract

Budget-auto-swarm means normal priority:

- Pi guard rejects `fastTrack: true` before run creation.
- Claude skill says never pass `--fast-track`.
- The mode does not toggle `/fast-track` global state; an independently armed fast-track remains armed but unusable for starts while budget mode is enabled.
- Turning budget mode off restores normal fast-track behavior without state migration.

This preserves ownership of the existing fast-track toggle while making budget mode fail-safe.

## Prompt precedence

For the lead Pi model, effective order remains:

1. system/developer/project instructions;
2. base async-subagents prompt module;
3. budget-auto-swarm conditional overlay;
4. live session-state block;
5. user task.

The overlay specializes delegation frequency, scheduling, and routing. It does not relax higher-level scope, authorization, source-of-truth, review, or validation rules.

For child models:

1. role body;
2. explicit includes;
3. runtime contract;
4. assigned task/brief;
5. parent inbox amendments.

Children do not receive the lead swarm overlay. Their role remains bounded execution; recursive orchestration stays prohibited.

## Compatibility and cutover

- Existing sessions without a budget state entry remain disabled.
- Existing agent calls without variants continue unchanged when mode is disabled.
- Existing `gemini` variants remain available when mode is disabled.
- Existing run records and task records need no migration.
- Adding variants is additive metadata; user/project definitions that override built-in names remain authoritative and are validated by resolved model when budget mode is active.
- No legacy alias or compatibility command is introduced.
