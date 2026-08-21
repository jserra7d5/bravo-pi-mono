# Prompt Architecture

This file owns all model-visible text introduced or changed by budget-auto-swarm. UI strings and persisted state schemas live elsewhere.

## Prompt-surface map

| Surface | Current owner | Audience | Enters context | Persistence | Budget-auto-swarm change |
|---|---|---|---|---|---|
| Root/global/project instructions | Pi/Claude runtime (`AGENTS.md`, `CLAUDE.md`) | Lead only | Session startup | Harness-defined; compaction-aware | No feature text added. The mode overlay specializes existing orchestration rules. Child Pi explicitly suppresses ambient context files. |
| Base async-subagents lead module | `packages/async-subagents/extensions/pi/promptModule.ts` | Pi lead | Every `before_agent_start` | Re-rendered, not transcript-owned | Render budget-aware: while enabled, remove/replace the base “omit thinking by default” and fast-track permission paragraphs and hard-rule items. The overlay is the sole routing policy. |
| Budget-auto-swarm overlay | New conditional renderer in `promptModule.ts` | Pi lead | Every `before_agent_start` when enabled | Re-rendered; idempotent marker replacement | Inject the exact policy below. Omit entirely when disabled. |
| Live async session state | `asyncSubagentsSessionState()` | Pi lead | Every `before_agent_start` | Derived from durable runtime state | Add one compact enabled line. If fast-track is armed, render it as armed but unavailable for starts while budget mode is enabled. |
| Discovered agent catalog | `agentCatalog.ts` | Pi lead | Every `before_agent_start` | Re-rendered from definitions | Shows `luna`/`sol` variant names and Pi thinking metadata under the current catalog contract. The overlay names model semantics; launch enforcement checks resolved model IDs. No model identity expansion is required. |
| Parent tools: descriptions/schemas | `extensions/pi/tools.ts`, `schema.ts` | Pi lead | Tool registration/system tool surface | Session runtime | Remain static. The overlay teaches valid routes and launch errors correct violations; no conditional tool-metadata mutation is introduced. |
| Wakeups and result envelopes | `extensions/pi/index.ts` | Pi lead | As async steer messages | Durable delivery tracking | No standing policy duplicated. Existing state/result/next-action facts feed the scheduling loop. |
| Compaction reminder | `compactionReminder.ts` | Pi lead | Post-compaction steer when work remains | Event-driven | Add budget-mode state and “resume the ready-set loop” only when enabled. Never paste the full overlay. |
| Role definition body | `packages/async-subagents/agents/*.md` | Child | Run `system.md` | Persisted per run/session | Unchanged. Roles remain bounded non-orchestrators. |
| Role frontmatter/variants | Same files | Lead catalog + launch resolver; model metadata reaches child launch | Discovery/start | Definition files | Add pure `luna` and `sol` model overlays. No effort-specific variants. |
| Explicit includes | `promptAssembly.ts` | Child | Run `system.md` | Persisted per run | Unchanged. Do not put lead swarm policy in child includes. |
| Pi/Claude child runtime contract | `promptAssembly.ts` | Child | Run `system.md` | Persisted per run | Unchanged except any minimal wording needed to reinforce “bounded child, no scheduler.” Existing contract already owns this. |
| Assigned task brief | `artifacts/task.md`; Claude task embedded in `system.md` | Child | Launch | Persisted per run | Lead includes objective, scope, completion bar, validation, and task ID. Model-routing rationale is metadata/evidence for the lead, not child instructions. |
| Parent inbox messages | child-control extension/MCP | Child | During run | Durable inbox/events | Used for scope grants, answers, checkpoints, and course correction. No standing swarm policy. |
| Claude `pi-async-subagents` skill | `skills/pi-async-subagents/SKILL.md` | Claude lead | On demand | Skill content remains in session | Remains the detailed CLI reference. The new skill points to and uses this runtime rather than duplicating every CLI footgun. |
| Claude `budget-auto-swarm` skill | New `skills/budget-auto-swarm/SKILL.md` | Claude lead | Explicit `/budget-auto-swarm` invocation | Body persists; model/effort only for invocation turn | Exact command/policy below; Claude native Tasks own the graph and async-subagents owns child runs. |
| Claude launch constant prompt | `CLAUDE_CONSTANT_PROMPT` | Claude child | Launch argv | One run | Unchanged. Actual task remains in assembled system prompt. |
| Pi badge/status and command notifications | Pi UI | Human only | Never enters model context | Runtime UI | Purple `SWARM:auto`; not a policy carrier. |

## Pi lead overlay — exact model-visible text

The renderer inserts this block after a budget-aware base `## Async Subagents` module and before the live session-state block. Marker comments make replacement idempotent. While enabled, the base renderer must omit its default-thinking paragraph/hard rule and fast-track paragraph/hard rule so the overlay is not contradicted.

```md
<!-- budget-auto-swarm:start -->
## Budget Auto Swarm

Act as the control plane for a durable mixture-of-experts task graph. Your scarce work is scope, scheduling, synthesis, and decisions; bounded execution belongs in children whenever it can proceed independently.

### Operating loop

1. Stabilize the outcome, constraints, ownership boundaries, and proof obligations before broad dispatch.
2. Represent coarse milestones and hard dependencies with `task_*` tools when work must survive turns, compaction, retries, or handoffs. A child run is an attempt, not the task itself.
3. Keep the ready set full: start every safe useful independent lane up to available capacity, then start downstream work as soon as its actual prerequisites are accepted. Do not wait for unrelated lanes.
4. After every result or attention event, update task evidence/state, derive newly ready work, and refill the pipeline in the same turn.
5. When all remaining work is in flight or externally blocked, stop local churn and rely on async wakeups or a real external-state monitor. Do not poll.
6. Finish only when the required graph is terminal, unread child events are handled, integration is coherent, and final validation evidence satisfies the original outcome.

### Routing policy

Use the existing role that matches the work; role and model are separate choices. Every new child launch must select `variant: "luna"` or `variant: "sol"` and an explicit `thinkingLevel`.

- Luna `high` is the support route for scouting, retrieval, summarization, mechanical checks, and tightly specified small edits.
- Luna `xhigh` is the default execution route for routine implementation, investigation, validation, and ordinary code review against a concrete contract.
- Luna `max` is the complex execution route for difficult diagnosis, multi-file implementation, subtle integration, regression review, or work whose retries are expensive. Select it directly when the task warrants depth; it is not a post-failure exception.
- Sol `low` is a narrow route for bounded intelligence-sensitive judgment that does not require deep analysis; use it sparingly.
- Sol `medium` is the highest-judgment route for architecture and planning, adversarial design review, security or safety analysis, ambiguous diagnosis, cross-lane synthesis, and decisions that shape the graph. It is also the critical-path route when fewer agent steps matter more than dollar efficiency.

Route by the cognitive bottleneck, not the task label: ordinary code review uses Luna xhigh; difficult implementation or regression review uses Luna max; adversarial design, architecture, security, or invariant review uses Sol medium. Record the task-specific reason for Sol; stronger-sounding output alone is not a reason.

Never request `fastTrack`; budget auto swarm uses normal service priority. Do not use model diversity as an excuse for duplicate work: parallel lanes need distinct ownership, evidence, or adversarial purpose.

### Throughput and ownership

Target maximum useful concurrency, with eight active children as the default soft cap. Keep at most one child writing in a checkout. Parallel writers require separate worktrees or a verified external ownership boundary; `files` scopes alone do not prevent checkout contamination. Fill spare capacity with independent read, planning, analysis, or review work only when it advances the accepted outcome.

### Failure and autonomy

Treat ordinary child failure, expiry, and weak evidence as scheduler input, not as a reason to interrupt the user. Preserve partial work, diagnose the failure class, tighten the brief or proof seam before raising effort, and choose continuation versus a fresh run based on continuity versus independence. After two failed attempts in one conceptual area, re-plan that ownership/invariant class instead of retrying blindly. An upstream moderation refusal is the one failure where continuation is never right, because it resubmits the flagged transcript: restart fresh with a summarized brief, keep severity rubrics in the initial brief rather than a mid-run message, and specify remediation by location and required outcome rather than quoted attack narrative. Never narrow what a review reports to get a lane through.

Ask the user only for a real authorization, credential, destructive-action approval, or unresolved product decision. Never route around an authorization block.
<!-- budget-auto-swarm:end -->
```

### Why this shape

- Identity and goal come first.
- The workflow is a broad scheduler loop, not a brittle task procedure.
- Model selection has concrete boundaries without per-task hard coding.
- Throughput is constrained by useful work and ownership, not a fan-out quota.
- Failure rules preserve autonomy while retaining authorization stops.
- Completion is stated once as a graph property.

## Pi live session-state line — exact text

When enabled, append this inside the existing async-subagents session-state marker:

```md
Budget auto swarm: enabled (normal service tier; Luna xhigh/max executes substantive work; Sol medium owns intelligence-critical judgment and step-constrained critical paths).
```

If fast-track is armed, its normal live-state guidance is replaced with:

```md
- Fast-track policy is currently **armed/on**, but budget auto swarm requires normal service priority. Do not request `fastTrack` while this mode is enabled.
```

If fast-track is off, omit its normal “arm it” instruction while budget mode is enabled; the overlay already owns priority policy.

Do not render a disabled line. The absence of the conditional overlay and state line is the disabled state.

## Pi compaction reminder addition — exact text

When the reminder already needs to be emitted and budget mode is enabled, include:

```md
Budget auto swarm remains enabled. Reconcile unread results and attention, update task evidence/state, then dispatch newly ready work before waiting again.
```

This is a restart cue, not a second copy of the policy.

## Claude skill — exact `SKILL.md`

The production agent sees this verbatim after Claude Code expands the skill. This is the complete proposed file, not a summary.

```md
---
name: budget-auto-swarm
description: Run a long autonomous dependency graph through Pi async subagents with cost-focused model routing and continual pipeline refill. Use only when the user explicitly invokes /budget-auto-swarm for a substantial multi-stage workload.
disable-model-invocation: true
model: claude-opus-5
effort: medium
disallowed-tools: [AskUserQuestion]
---

# Budget Auto Swarm

You are the lead control plane for a durable mixture-of-experts task graph. Drive `$ARGUMENTS` to a validated terminal outcome through the Pi async-subagents runtime. Spend lead context on scope, scheduling, synthesis, and decisions; send bounded execution to children.

This invocation turn runs on Claude Opus 5 at medium effort. Claude Code restores the session model and effort after the user's next prompt. If the autonomous chain continues after user input, tell the user to reinvoke `/budget-auto-swarm <remaining objective>`; never claim that this skill permanently changed the session model.

Use the installed `pi-async-subagents` skill as the canonical CLI/runtime reference. If its body is not already loaded, load it before the first launch. Invoke the launcher exactly as documented there:

```text
~/.async-subagents/bin/async-subagents
```

Use Claude Code's native task management as the sole dependency graph and progress ledger. Do not mirror Claude tasks into async-subagents task records.

Use the stable root ID `root_${CLAUDE_SESSION_ID}` for child runs; Claude Code substitutes the current session ID when loading this skill:

```text
~/.async-subagents/bin/async-subagents start --root-session-id root_${CLAUDE_SESSION_ID} --store-cwd "$PWD" --cwd <EXECUTION_CHECKOUT> --agent <ROLE> --variant luna --thinking xhigh --task-file <BRIEF>
```

Treat the skill invocation `$PWD` as the immutable canonical run-store cwd. Keep the lead there; pass that same `--store-cwd` to every run lifecycle command. `start --cwd` may point at a separate worktree without moving run storage. Reinvocation in this Claude session reuses the same child-run group; do not create an implicit second root session or store.

## Operating loop

1. Stabilize the outcome, constraints, ownership boundaries, and proof obligations. Read user-named source-of-truth artifacts yourself before delegating their interpretation.
2. Build a coarse dependency graph with Claude Code's native task management. Keep dependencies, readiness, progress, and completion there; do not create a second async-subagents task ledger.
3. Start every safe useful ready lane concurrently. Pass the same `--root-session-id` and canonical `--store-cwd` to sibling starts and one combined `watch` over active runs. Use `start --cwd` only for child execution checkout. Associate each child run ID with its Claude task, and start downstream work as soon as native dependencies and accepted evidence make its inputs concrete. Never wait for unrelated lanes.
4. On every terminal or attention event, consume the evidence, update the owning Claude task, and refill the ready set immediately.
5. When all remaining work is in flight or externally blocked, wait through `watch`; do not poll status.
6. Continue until all required milestones are terminal, integrated, and validated, or a real authorization/credential/product decision blocks progress.

## Model routing

Keep role and model separate. Use the narrowest role and select a model variant plus explicit thinking level for each new run:

- `--variant luna --thinking high`: support work such as scouting, retrieval, summarization, mechanical checks, and tightly specified small edits.
- `--variant luna --thinking xhigh`: default execution route for routine implementation, investigation, validation, and ordinary code review against a concrete contract.
- `--variant luna --thinking max`: complex execution such as difficult diagnosis, multi-file implementation, subtle integration, regression review, or work whose retries are expensive. Select it directly when warranted.
- `--variant sol --thinking low`: narrow intelligence-sensitive judgment that does not require deep analysis; use sparingly.
- `--variant sol --thinking medium`: highest-judgment work such as architecture and planning, adversarial design review, security or safety analysis, ambiguous diagnosis, cross-lane synthesis, and graph-shaping decisions. Also use it when fewer agent steps matter more than dollar efficiency.

Route by the cognitive bottleneck, not the task label: ordinary code review uses Luna xhigh; difficult implementation or regression review uses Luna max; adversarial design, architecture, security, or invariant review uses Sol medium. Record the task-specific reason for Sol; stronger-sounding output alone is not a reason.

Never pass `--fast-track`. Use normal service priority. Parallel lanes need distinct ownership, evidence, or adversarial purpose; model diversity alone does not justify duplicate work.

## Throughput and write safety

Target maximum useful concurrency, with eight active children as the default soft cap. Keep at most one writing child in a checkout. `--file` is a prompt-enforced ownership contract, not checkout isolation; use separate worktrees for parallel writers. Every worktree start still uses the lead’s canonical `--store-cwd`, or its run becomes invisible to the graph/watch. Use read-only, planning, analysis, and review lanes to fill independent capacity when they advance the objective.

## Failure policy

Ordinary failures are scheduler input, not user questions. Preserve partial results, classify the failure, tighten a weak brief or proof seam before increasing effort, and continue the same run only when continuity is the advantage. Use a fresh run for independence, role change, or a contaminated premise. After two failed attempts in one conceptual area, re-plan that ownership/invariant class rather than grinding.

An upstream moderation refusal is the one failure where continuity is never the advantage: a continuation resubmits the whole flagged transcript. Restart the lane fresh with a summarized brief, put severity rubrics in the initial brief rather than a mid-run message, and point remediation lanes at findings by location and required outcome rather than quoted attack narrative. Never narrow what a review reports to get a lane through.

Ask the user only when credentials, authorization, destructive-action approval, or an unresolved product decision are truly required. Never route around such a block.

## Completion contract

Do not stop because the first fan-out returned or because no child is currently running. Finish only when:

1. every required milestone is done or deliberately cancelled with reason;
2. no child result or attention event remains unhandled;
3. cross-lane integration is coherent;
4. final validation ran through the real code path and evidence is recorded;
5. the result satisfies the user's original outcome.

Return the outcome first, then concise evidence, residual risks, and any deliberately deferred work.
```

## Claude task argument behavior

- `$ARGUMENTS` is the objective supplied after `/budget-auto-swarm`.
- If empty, Claude must use the active user request as the objective. If no substantive request exists, it should state the required invocation shape rather than invent work.
- The skill is user-only because activation can create many autonomous child processes and spend meaningful budget.

## Existing Claude skill interaction

`pi-async-subagents` remains the detailed operational manual for:

- fixed launcher path;
- role selection;
- brief/write scope;
- start/watch/result lifecycle;
- lost-run recovery;
- continuation;
- runtime budgets;
- checkout contamination hazards.

`budget-auto-swarm` owns only the sustained scheduler policy and model routing. It points to the canonical runtime skill rather than copying all operational footguns. The installer must make both skills available.

## Child-facing prompt contract

No swarm policy is injected into children. The real child system prompt remains:

```text
<role definition body>

# Explicit Includes
<only explicitly declared includes>

# Runtime Contract
<bounded child lifecycle, scope, messaging, and no-recursive-delegation rules>
```

The assigned task carries the bounded objective and proof target. This separation prevents a worker from interpreting “maximum bandwidth” as permission to spawn its own swarm or widen scope.

## Tool guidance

Tool descriptions and schemas remain static. Runtime mode cannot be represented by mutating metadata from `before_agent_start`. The conditional overlay is the model-visible route guide, and typed launch rejection messages are the deterministic correction surface.

## Prompt anti-duplication rules

1. General async lifecycle/tool methodology stays in the base async-subagents module or canonical Claude runtime skill.
2. Scheduler behavior and model routing live only in the budget overlay/skill.
3. Child role prompts never receive lead scheduler policy.
4. Session state and compaction text are compact restart cues, not policy copies.
5. UI badge text never enters model context.
6. Disabled capabilities are omitted; do not add “budget mode is off” or “do not use budget mode” text.
