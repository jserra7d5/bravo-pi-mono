# Design

## Problem

The current async-subagents runtime provides durable children, parent-owned milestone tasks, wakeups, continuation, budgets, and pipeline guidance. It does not provide an operator-selectable policy that makes the lead behave as a sustained mixture-of-experts scheduler or confines child launches to a cost-focused model portfolio.

A prompt saying “delegate more” is insufficient for long autonomous work. The system needs:

- durable dependency state outside the lead’s context;
- continual scheduling rather than one initial fan-out;
- clear write ownership and backpressure;
- explicit retry, escalation, and terminal rules;
- one durable graph owner reachable from both Pi tools and the Claude CLI;
- a model-routing portfolio enforced at the launch boundary;
- compaction/resume continuity;
- an operator-visible mode indicator that is not confused with model-visible policy.

## Outcome

When active, the lead acts as the control plane for a durable task graph:

1. Stabilize the outcome, constraints, and proof obligations.
2. Represent coarse milestones and hard dependencies in the existing `task_*` plane.
3. Dispatch every safe ready lane up to the useful concurrency limit.
4. Refill capacity immediately when a lane completes, blocks, or makes a downstream milestone ready.
5. Use Luna xhigh/max for the bulk of substantive execution; use Sol medium for intelligence-critical judgment or step-constrained critical-path work.
6. Continue until every required milestone is terminal, integrated, and validated, or until a real user decision/authorization block is reached.

The lead remains accountable for scope, scheduling, cross-lane synthesis, conflict resolution, and final evidence. Children remain bounded non-orchestrators.

## Ownership

`@bravo/async-subagents` owns this feature because it already owns all implicated behavior:

- child role discovery and variants;
- `subagent_start` launch resolution;
- sticky task orchestration state;
- parent-owned task storage;
- prompt injection and session-state blocks;
- wakeups and compaction reminders;
- child budgets and continuation;
- the Pi status/widget surfaces;
- installation of the Claude-facing async-subagents skill.

No second graph store, queue, supervisor, or child protocol is introduced. Pi keeps its existing `TaskStore`; Claude keeps Claude Code's native task management. Async-subagents owns child-run lifecycle only for Claude. Child execution cwd is separate from canonical run-store cwd so worktrees do not split run visibility. The mode is a policy overlay over existing owners.

## Architecture

```text
                    activation
        ┌──────────────────────────────┐
        │ Pi command                   │  Claude skill
        │ /budget-auto-swarm on        │  /budget-auto-swarm <objective>
        └──────────────┬───────────────┘
                       │
              orchestration policy
        ┌──────────────▼───────────────┐
        │ lead prompt overlay           │
        │ durable task graph            │
        │ ready-set scheduler           │
        │ routing + escalation policy   │
        └───────┬───────────────┬──────┘
                │               │
      harness task graph    subagent_start
                │               │
        dependencies       launch policy guard
                │          role + model variant
                │          + thinkingLevel
                │               │
        ready work ◄──── result/wakeup/continue
```

### Separation of concerns

| Concern | Owner |
|---|---|
| Whether budget-auto-swarm is active in Pi | Atomic user-global state under `ASYNC_SUBAGENTS_HOME` plus successfully reconciled in-memory runtime state. |
| What the lead should do | Conditional lead prompt overlay. |
| What model portfolio may launch | `subagent_start` launch-policy validation. |
| Work/dependency truth | Pi: existing `TaskStore` through `task_*`. Claude: Claude Code native task management. |
| Child execution truth | Existing run status/result records. |
| Child role behavior | Existing role prompt bodies. |
| Human visibility | Purple `setStatus` badge. |
| Claude lead model/effort | Claude skill frontmatter for the invocation turn. |

The prompt does not own enforcement. The badge does not own policy. The graph does not own child process state.

## Model portfolio

### Evidence informing the default

As of the design snapshot, DeepSWE v1.1 reports Luna max at 67% pass@1, about $0.61 per task, and roughly 102 agent steps per task. Sol medium reports 61%, about $1.86 per task, and roughly 31 steps; Sol max reaches about 73% at roughly $8.39 per task. Luna max therefore dominates Sol medium on score and dollar cost, while Sol medium uses about one-third the agent steps. Artificial Analysis reports Luna and Sol on its intelligence/cost Pareto frontier while Terra is dominated by another family/effort point. These are routing priors, not universal truth: harness, latency per step, repository, and task mix matter.

Primary evidence:

- DeepSWE leaderboard: <https://deepswe.datacurve.ai/>
- Artificial Analysis GPT-5.6 analysis: <https://artificialanalysis.ai/articles/gpt-5-6-has-landed>

### Roles and variants

Role identity and model choice remain independent:

```text
agent = worker       variant = luna       thinkingLevel = high
agent = reviewer     variant = luna       thinkingLevel = xhigh
agent = planner      variant = sol        thinkingLevel = medium
```

Every applicable built-in role gets model-only variants:

- `luna` → `bravo-codex-balanced/gpt-5.6-luna`
- `sol` → `bravo-codex-balanced/gpt-5.6-sol`

The base role prompts, tools, extensions, run mode, and depth limits do not change under these variants. Existing `gemini` variants remain available outside budget mode and are rejected by the budget-mode launch guard unless the user explicitly turns the mode off.

### Routing prior

| Route | Use |
|---|---|
| Luna high | Support work: scouting, retrieval, summarization, mechanical checks, and tightly specified small edits. |
| Luna xhigh | Default execution route for routine implementation, investigation, validation, and ordinary code review against a concrete contract. |
| Luna max | Complex execution: difficult diagnosis, multi-file implementation, subtle integration, regression review, or work whose retries are expensive. It is a normal route when the task warrants depth, not a post-failure exception. |
| Sol low | Narrow judgment route for bounded intelligence-sensitive decisions that do not require deep analysis; use sparingly. |
| Sol medium | Highest-judgment route for architecture and planning, adversarial design review, security or safety analysis, ambiguous diagnosis, cross-lane synthesis, and decisions that shape the graph. Also use when fewer agent steps or shorter critical-path occupancy matters more than dollar efficiency. |

Route by the cognitive bottleneck, not the task label. Ordinary code review belongs on Luna xhigh; difficult implementation or regression review belongs on Luna max; adversarial design, architecture, security, or invariant review belongs on Sol medium. Do not require a cheaper route to fail before selecting the effort the task already warrants.

The lead may use the same role at different model/effort points for independent or adversarial lanes. Model diversity alone does not justify duplicate work; the second lane needs a distinct question, proof obligation, or independence purpose.

Terra is excluded from v1. Adding it requires new evidence that it occupies a useful local frontier for this runtime’s task mix.

## Autonomous graph scheduler

### Graph granularity

Use task records for milestones that matter across turns, compaction, or child attempts. Do not create a task per file, command, or trivial action. A task should normally represent one of:

- a source-of-truth decision or design slice;
- an independently owned implementation slice;
- an integration seam;
- a validation or release gate;
- an external wait whose completion unlocks work.

A child run is an attempt against a task, not the task itself. Task state and run state remain separate. Both activation surfaces use the same task files under `session-tasks/<rootSessionId>/`; Claude does not invent progress files or hold graph truth only in conversation.

### Scheduling loop

The lead maintains this loop for the whole chain:

1. **Orient:** read current task and run projections; consume unread results/attention.
2. **Update:** attach evidence and attempt IDs; mark completed, failed, or blocked milestones truthfully.
3. **Derive ready set:** use task readiness and ownership constraints.
4. **Dispatch:** start every safe useful lane until capacity or ownership constraints bind.
5. **Advance immediately:** when `task_update` returns `newly_ready`, start those lanes in the same turn when inputs are sufficient.
6. **Wait efficiently:** when all remaining work is in flight or externally blocked, stop local churn and rely on wakeups/monitors.
7. **Close:** integrate, validate the retained deliverable, then terminate only under the graph terminal rule.

There is no batch barrier between unrelated lanes. A downstream review may start as soon as its candidate is frozen even while unrelated implementation continues elsewhere.

### Concurrency and backpressure

“Maximum bandwidth” means maximum useful concurrency, not unlimited processes.

- Default soft cap: 8 active children per root session.
- Default write cap: one child writing in a checkout at a time.
- Parallel writers require separate worktrees or verified disjoint external ownership boundaries; prompt-level `files` scopes alone do not prevent git/worktree contamination. Every lifecycle command still uses the lead checkout as canonical store cwd.
- Read-only, planning, analysis, and review lanes may fill remaining capacity.
- The lead may exceed the soft cap only when the lanes are independent, the provider/runtime can sustain them, and coordination cost remains below expected wall-clock gain.
- The mode never manufactures placeholder work merely to fill capacity.

The cap is a prompt policy in v1, not a new queue. Existing launch calls remain asynchronous. Deterministic tests verify exact policy rendering; the launch guard enforces only model/priority constraints. Runtime behavior is observed during normal use rather than gated by prompt evals.

### Failure and escalation

For each failed or expired attempt:

1. Preserve partial evidence and checkpoint state.
2. Decide whether the failure is brief/scope/proof, capability, transient runtime, or a disproven approach.
3. Fix the brief or contract before raising effort when the failure is underspecification.
4. Continue the same recorded child when continuity is the advantage.
5. Start a fresh child when independence, role change, or premise reset is the advantage.
6. Escalate model/effort by one justified step; do not jump automatically to Sol.
7. After two failed attempts in one conceptual area, stop retrying and re-plan the invariant/ownership class.

Failures in one lane do not cancel independent lanes. A real authorization, credential, destructive-action approval, or unresolved product decision is a user block. Normal child failure is scheduler input, not a user interruption.

### Terminal rule

The chain is complete only when:

- every required task is `done` or deliberately `cancelled` with a recorded reason;
- no required task remains open, active, waiting, or blocked;
- no unhandled child result or attention event remains;
- integration is coherent across lanes;
- the final validation commands/proof seams ran and evidence was recorded;
- the user-facing deliverable answers the original outcome.

A child reporting completion, an empty ready set, or all current children becoming terminal is not sufficient.

## Pi activation behavior

Pi mode is user-global and survives new sessions, branches, reloads, and independent Pi processes:

- `/budget-auto-swarm` and `/budget-auto-swarm on` enable it.
- `/budget-auto-swarm off` disables it.
- `/budget-auto-swarm status` reports state and effective policy.
- activation enables task orchestration if it is off;
- disabling budget mode does not disable tasks;
- every session lifecycle restore reads the same user-global state file;
- branch navigation does not change the mode;
- historical session transcript markers are inert and do not override the global value.

Pi does not change the lead’s model or thinking level. The operator chooses the lead model independently.

## Claude activation behavior

The Claude skill is both capability and command; no duplicate command file is needed. Claude Code's native task management owns its graph, dependencies, readiness, and progress. The skill drives only async-subagent run lifecycle commands, using one stable root-session ID and canonical run-store cwd for sibling visibility.

Its frontmatter sets:

- `disable-model-invocation: true` — only the user deliberately starts an autonomous swarm;
- `model: claude-opus-5` — exact family/version instead of the moving `opus` alias;
- `effort: medium`;
- `disallowed-tools: AskUserQuestion` — the invocation turn should progress autonomously and surface only real terminal blocks;
- allowed Bash access narrowly matching the fixed async-subagents launcher where Claude permission syntax permits it.

Claude Code model/effort overrides apply for the rest of the invocation turn only. Skill instructions remain in context across turns, but the session model resumes on the user’s next prompt. Therefore:

- a single long autonomous turn remains on Opus 5 medium;
- after user input, the operator reinvokes `/budget-auto-swarm ...` to restore the model/effort override;
- the skill must state this explicitly instead of claiming a persistent model switch.

The skill drives task briefs, `start`, and one combined `watch`; it updates Claude's native tasks as child evidence arrives. It does not create a second graph format or orchestration protocol.

## Scope

### Included

- user-global sticky Pi mode command/state/prompt/status;
- purple badge;
- task-mode coupling;
- Luna/Sol variants on built-in roles;
- launch-policy rejection for non-budget variants and fast-track while Pi mode is active;
- Claude skill and install path;
- prompt-surface refactor needed to avoid duplicated orchestration rules;
- autonomous graph, failure, escalation, and completion guidance;
- deterministic state/launch tests and exact rendered-prompt inspection.

### Non-goals

- a new DAG engine, queue, or scheduler daemon;
- children spawning children;
- automatic lead-model switching in Pi;
- persistent Claude session model mutation from a skill;
- service-tier priority or `/fast-track` automation;
- arbitrary cost accounting or hard dollar budgets;
- automatic worktree creation in v1;
- Terra support;
- weakening scope, review, or validation rules to increase throughput;
- replacing Bravo Goals or Claude native Tasks; each harness keeps its existing graph owner.

## Alternatives rejected

### Duplicate role names per model and effort

Rejected because `thinkingLevel` is already a per-launch override. `worker-luna-high`, `worker-luna-xhigh`, and similar names create a combinatorial catalog and duplicate role identity.

### Prompt-only model routing

Rejected because a lead can drift and launch the default Sol definition, a Gemini variant, or fast-track. The launch boundary must reject out-of-policy requests while Pi mode is active.

### New scheduler package

Rejected because async-subagents already owns durable runs, tasks, wakeups, continuation, and prompt assembly. A second owner would create split-brain lifecycle truth.

### Claude command plus skill

Rejected because Claude skills are directly user-invocable slash commands. Two files with the same name add precedence ambiguity and duplicate content.

### Unlimited fan-out

Rejected because provider saturation, context switching, duplicate exploration, and write contamination reduce trusted throughput. Useful concurrency is bounded by dependency and ownership, not enthusiasm.

## Stop/re-plan triggers

Implementation stops and returns to design if:

- Pi cannot enforce budget launch policy through one `startSubagent` hook after resolution and before a run directory/process is created;
- enabling task orchestration from budget mode creates two competing sticky-state owners;
- Claude Code rejects the required skill frontmatter or cannot apply Opus 5 medium to the invocation turn;
- model variants cannot remain pure frontmatter overlays and require role-prompt duplication;
- Claude run lifecycle commands cannot address one canonical run store across worktrees, or combined watch/recovery loses child truth;
- enforcing one-write-lane requires a new scheduler/lock subsystem rather than prompt policy;
- tests reveal that budget policy must rewrite existing live/recorded child models;
- the prompt overlay materially contradicts root orchestration instructions instead of specializing them.
