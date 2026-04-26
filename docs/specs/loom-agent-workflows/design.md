# Loom Agent Workflows Design

Status: draft  
Date: 2026-04-26

## Summary

This spec defines how Loom should integrate with Pi root sessions, Tango agents, prompt templates, skills, roles, and worktree-based implementation workflows.

Loom is the durable graph for research, design, planning, decisions, implementation tasks, results, and review state. Tango remains the live agent/process orchestration layer. Pi prompt templates provide user-facing slash-command workflows. Pi skills provide reusable procedures that root sessions and delegated agents can invoke when their assignment calls for them.

The goal is a Spec Kit-inspired but graph-native workflow: instead of forcing work through linear `spec.md -> plan.md -> tasks.md`, Loom preserves branching alternatives, recursive decomposition, explicit decisions, granular implementation tasks, dependent reviews, and implementation results.

## Goals

- Provide Loom-oriented prompt templates for root/user-initiated phases.
- Provide Loom-oriented skills for agents to invoke inside assigned Loom-aware work.
- Keep Loom usage conditional: agents use Loom only when assigned a Loom/node/inbox reference or Loom context.
- Add roles suited to durable research/design/planning/graph hygiene.
- Make Pi package loading expose Loom prompts and skills to root sessions.
- Make Tango agents able to resolve explicit role skills from Pi package resources, not only Tango-local skills.
- Define a safe worktree convention for Loom implementation workflows.
- Make review/validation tasks first-class dependent nodes in implementation plans.

## Non-goals

- Do not make Loom a process runtime. Tango still starts/messages/stops agents.
- Do not store worktrees inside `.loom/`.
- Do not make agents start Loom instances on their own unless explicitly instructed.
- Do not require every Loom workflow to be a slash command; many behaviors belong in skills/prompts.
- Do not add broad global directories for extension-owned skills outside Pi's package/resource system.

## Core Mental Model

- Pi root session: user-facing principal/synthesizer.
- Tango `team-lead`: delegated feature/domain lead for a bounded scope, not necessarily root session lead.
- Tango `design-lead`: delegated design/spec coordinator, often Loom-backed.
- Tango `implementation-lead`: delegated implementation-slice coordinator/integrator.
- Loom: durable graph state and memory.
- Tango: live agent execution.
- Pi prompt templates: user/root slash commands.
- Pi skills: reusable agent-invoked procedures.

## Root Delegation Bias

The root Pi session should default to delegating broad exploratory work. When the user says “explore this,” “look into this,” “make yourself familiar with X,” “survey this repo,” or asks a broad where/how question, the root should usually send first-pass reconnaissance to a scout or researcher unless the scope is tiny.

The root remains accountable for synthesis and judgment. It should personally read source-of-truth artifacts and targeted files needed for decisions, but should avoid duplicating broad file discovery or repo exploration that it delegated.

When a Loom/Tango workstream already has an active relevant team-lead, design-lead, implementation-lead, researcher, reviewer, or other domain agent, the root should route questions through the closest knowledgeable active agent when reasonable. Information should flow down to the agent closest to the code/design/task and back up through concise summaries. The root should avoid bypassing active workstream owners for broad questions about their scope unless latency, triviality, or user instruction makes direct handling better.

## Conditional Loom Usage Policy

Agents should use Loom only when one of these is true:

- their assignment explicitly says to use Loom;
- they receive a Loom ID, alias, node ID, or inbox item ID;
- they run with Loom context such as `LOOM_DEFAULT` or `LOOM_CONTEXT`;
- their parent/root agent gives them a Loom command to run.

Agents should not introduce Loom into unrelated tasks. Root sessions may suggest starting a Loom instance for durable, multi-session, research-heavy, design-heavy, branchy, spec-driven, or implementation-tracked work, but should ask the user before initializing one unless the user explicitly requested it.

## Prompt Templates vs Skills

Use dot names for prompt templates because they are user-facing slash commands:

- `/loom.spec`
- `/loom.clarify`
- `/loom.breakdown`
- `/loom.branch-design`
- `/loom.decide`
- `/loom.plan`
- `/loom.analyze`
- `/loom.implement`
- `/loom.ready`
- later maybe `/loom.status`

Use hyphen names for skills because Pi skills follow Agent Skills naming rules:

- `loom-clarify`
- `loom-breakdown`
- `loom-branch-design`
- `loom-decide`
- `loom-plan`
- `loom-analyze`
- `loom-implement`
- `loom-ready`
- later maybe `loom-status`

`loom-spec` may exist later, but initial recommendation is prompt-template-first because agents should not casually start new Looms.

## Initial Prompt Templates

### `/loom.spec`

User/root workflow to start or update a durable Loom-backed spec/proposal. It should ask before initializing a new Loom unless the user explicitly requested creation. It should create or identify a root proposal/spec node and capture goals, scope, constraints, assumptions, and initial next steps.

### `/loom.clarify`

Clarify a proposal/spec/design node. Ask a small number of high-impact questions and record answers into Loom. Prefer questions that materially affect scope, architecture, validation, data model, security, UX, or task decomposition.

### `/loom.breakdown`

Break a node into child nodes. Depending on context, the breakdown may be direct or delegated to planners/design leads/researchers. Modes may include research, design, plan, implementation, and review.

### `/loom.branch-design`

Create multiple design variant nodes from a proposal/design node. Optionally dispatch `design-variant-planner` agents for each branch. Preserve all alternatives.

### `/loom.decide`

Compare variants and create an explicit decision node. It may use architecture consultants/reviewers. Rejected/deferred alternatives should be preserved with rationale.

### `/loom.plan`

Generate implementation plan/task nodes from a chosen design. If no chosen design exists, stop and recommend `loom.decide`. It should create implementation tasks plus dependent review/validation tasks.

### `/loom.analyze`

Read-only graph-aware consistency analysis. Check proposal/spec/design/decision/plan/task/result alignment, unresolved decisions, stale branches, architecture smells, cross-consistency issues, and whether implementation follows chosen decisions.

### `/loom.implement`

Execute or coordinate implementation task nodes. It should use worktree conventions, dispatch implementation leads/workers when useful, record results in Loom, and ensure dependent review/validation nodes are completed.

### `/loom.ready`

Readiness checker with modes such as `spec`, `design`, `plan`, `implement`, and `review`. It should verify enough durable context exists to proceed safely.

### `/loom.status` Later

Possible later read-only command to summarize current Loom state, open decisions, active branches, open tasks/reviews, blockers, inbox items, recent results, and recommended next action.

## Initial Skills

The initial skill set should mirror the reusable parts of the prompt templates:

- `loom-clarify`
- `loom-breakdown`
- `loom-branch-design`
- `loom-decide`
- `loom-plan`
- `loom-analyze`
- `loom-implement`
- `loom-ready`
- optional later: `loom-status`

Skills should include conditional Loom usage instructions. They should tell agents to fetch Loom context first when Loom is active, prefer `loom note`/`loom resolve`/graph commands over manual Markdown edits, and avoid managing Loom internals such as SQLite files, registry repair, locks, or delivery internals.

## Roles

Existing and new global Tango roles should align with this model.

### Existing Roles to Keep/Use

- `scout`: read-only reconnaissance, MiniMax, oneshot.
- `planner`: one-shot plan, GPT-5.5 medium.
- `interactive-planner`: persistent design/planning partner, GPT-5.5 medium.
- `architecture-consultant`: one-shot architectural consultation, GPT-5.5 medium.
- `reviewer`: one-shot review/audit, GPT-5.5 medium.
- `team-lead`: delegated feature/domain lead, GPT-5.5 medium, recursive.
- `implementation-lead`: implementation coordinator/integrator, K2.6 high, recursive.
- `worker`: persistent implementation worker, K2.6 high.
- `bounded-worker`: one-shot K2.6 implementation worker, high.
- `fast-worker`: persistent MiniMax implementation worker, high.
- `bounded-fast-worker`: one-shot MiniMax implementation worker, high.

### New Roles

#### `design-lead`

- Model: `gpt-5.5`
- Thinking: `medium`
- Mode: `interactive`
- Recursive: yes
- Purpose: delegated design/spec coordinator. Branch alternatives, coordinate research/variant planning/consultation/review, synthesize decisions, and preserve Loom design context when assigned.

#### `design-variant-planner`

- Model: `gpt-5.5`
- Thinking: `medium`
- Mode: `oneshot`
- Recursive: no
- Purpose: produce one coherent design variant for a proposal/branch.

#### `researcher`

- Model: `MiniMax-M2.7-highspeed`
- Thinking: `medium`
- Mode: `interactive`
- Recursive: no
- Purpose: persistent evidence gathering across code, docs, specs, logs, and Loom nodes. Separate evidence from inference.

#### `loom-curator`

- Model: `k2p6`
- Thinking: `high`
- Mode: `oneshot`
- Recursive: no
- Purpose: graph hygiene and Loom consistency review. Find stale branches, unresolved decisions, orphan tasks, duplicate concepts, rejected alternatives feeding implementation, missing results, and broken references. It should recommend cleanup/actions and avoid mutation unless explicitly instructed.

## Role Skill Assignment

Once Tango can resolve Pi package skills by name, roles can explicitly list Loom skills. Proposed defaults:

- `design-lead`: `loom-breakdown`, `loom-branch-design`, `loom-decide`, `loom-plan`, `loom-ready`, `loom-analyze`
- `design-variant-planner`: `loom-branch-design` only if needed; often no default skill is required
- `researcher`: optional `loom-clarify` or no default; it can use Loom commands when assigned context
- `planner`: `loom-plan`, `loom-ready`
- `interactive-planner`: `loom-clarify`, `loom-breakdown`, `loom-plan`, `loom-ready`
- `architecture-consultant`: `loom-analyze`, `loom-decide`
- `reviewer`: `loom-analyze`, `loom-ready`
- `team-lead`: `loom-breakdown`, `loom-plan`, `loom-ready`, `loom-analyze`
- `implementation-lead`: `loom-implement`, `loom-ready`, `loom-analyze`
- `loom-curator`: `loom-analyze`, `loom-ready`, optional `loom-status` later

These skills are still conditional: their presence does not mean agents should invent Loom usage without assignment/context.

## Pi Package Integration

`packages/loom/package.json` should declare its Pi resources:

```json
{
  "pi": {
    "skills": ["./skills"],
    "prompts": ["./prompts"]
  }
}
```

The user/root Pi session will load prompt templates and skills when the Loom package is installed or listed in Pi settings.

For this monorepo, global Pi settings should include:

```json
"packages": [
  "../../Documents/projects/bravo-pi-mono/packages/tango",
  "../../Documents/projects/bravo-pi-mono/packages/caveman",
  "../../Documents/projects/bravo-pi-mono/packages/loom"
]
```

Alternatively, users can run `pi install /path/to/packages/loom`.

## Tango Skill Resolution

Tango currently starts Pi agents with skills, prompts, and extensions disabled by default, then explicitly re-adds skills from role frontmatter. This is desirable because agent context stays bounded. However, Tango currently resolves role skills mainly from Tango-local paths.

Tango should continue requiring explicit role `skills: [...]`, but should resolve those skill names from Pi's resource system.

Recommended resolution order for a role skill value:

1. Explicit path as provided.
2. Tango user skills for backward compatibility, e.g. `~/.tango/skills/<name>/SKILL.md`.
3. Tango package skills for backward compatibility, e.g. `packages/tango/skills/<name>/SKILL.md`.
4. Pi global/project user skill locations:
   - `~/.pi/agent/skills/<name>/SKILL.md`
   - `~/.pi/agent/skills/<name>.md`
   - applicable project `.pi/skills/` and `.agents/skills/` locations from CWD ancestors.
5. Installed Pi packages from Pi settings:
   - paths declared under package `pi.skills`;
   - conventional package `skills/` directories when no manifest narrows discovery.

Tango should not copy Loom skills into `~/.tango`. Tango is an orchestrator, not the shared resource store. Loom owns Loom skills. Pi owns package/resource discovery. Tango only resolves explicit role skill names into paths.

## Worktree Implementation Convention

### Location

For any source repo, worktrees go in a `.worktrees` directory sibling to that source repo, independent of Loom location or root session CWD.

Formula:

```txt
worktree_root = dirname(source_repo) + "/.worktrees/" + basename(source_repo)
```

Example:

```txt
/home/joe/Documents/projects/
  repo-a/
  repo-b/
  .worktrees/
    repo-a/
      loom-feature-x-N-0042-integration/
      loom-feature-x-N-0042-fast-a/
    repo-b/
      loom-feature-x-N-0042-integration/
```

If the Loom lives in the parent folder, the convention is unchanged. If the Loom lives inside `repo-a`, the convention is still unchanged. Do not put worktrees inside `.loom/`.

### Branch Naming

Use stable Loom/node IDs first, slug second.

Integration branch:

```txt
loom/<loom-alias-or-id>/<node-id>-<slug>
```

Worker/attempt branch:

```txt
loom/<loom-alias-or-id>/<node-id>-<slug>/<agent-or-attempt>
```

Examples:

```txt
loom/feature-x/N-0042-auth-cleanup
loom/feature-x/N-0042-auth-cleanup/fast-a
loom/feature-x/N-0042-auth-cleanup/fast-b
```

Always use named branches for agent work. Avoid detached worktrees.

### Directory Naming

Use filesystem-safe names:

```txt
loom-<loom-alias>-<node-id>-<slug>
loom-<loom-alias>-<node-id>-<slug>-<agent>
```

### Base State Policy

Before creating worktrees, record:

- source repo path;
- source branch;
- source commit;
- dirty state;
- intended base commit/branch;
- validation environment path, if known.

If the source repo is dirty, do not create worktrees silently. Ask or record how dirty state will be handled: commit first, stash/apply, patch-copy, or intentionally ignore.

### Environment Policy

Use the source repo's existing virtual environment or dependency setup when provided. Do not create a new environment in a worktree unless explicitly instructed.

For Python, tasks may record:

```txt
Validation environment:
- Python venv: /path/to/source-repo/.venv
- Test command: ...
- Build command: ...
```

For Node and other ecosystems, prefer normal package-manager caches and avoid symlinking dependency directories by default.

### Commit Policy

Worker attempt worktrees default to diff handoff, not commits, unless explicitly requested. Workers should report `git status --short`, `git diff --stat`, and relevant diffs.

Integration worktrees should commit at meaningful checkpoints after selected changes are reconciled and validation passes.

### Cleanup Policy

Agents must not delete worktrees or branches automatically unless explicitly instructed. They may propose cleanup commands.

Before cleanup:

- inspect for uncommitted changes;
- confirm useful changes are integrated or intentionally rejected;
- record outcome in Loom;
- list cleanup commands for user approval.

## Loom Recording for Worktrees

Use dedicated child nodes for non-trivial implementation attempts. Use simple notes for trivial single-worktree work.

Example graph:

```txt
N-0042 Implement auth cleanup              kind: task
  N-0043 Integration worktree              kind: implementation
  N-0044 Fast-worker attempt A             kind: task/result
  N-0045 Fast-worker attempt B             kind: task/result
  N-0046 Decision: choose attempt A parts  kind: decision
  N-0047 Validation result                 kind: result
```

For each non-trivial worktree/attempt, record:

- repo path;
- worktree path;
- branch;
- base commit;
- assigned agent;
- purpose;
- status;
- summary;
- validation;
- integration/rejection outcome.

Worktrees are external mutable state, not Loom-owned artifacts.

## Review and Validation as Dependent Tasks

Implementation planning must build review into the graph. Do not write all code and then run one massive final review unless the scope is trivial.

When `loom.plan` or `loom.breakdown` creates implementation tasks, it should create dependent review/validation nodes at appropriate granularity.

Preferred pattern:

```txt
N-0100 Feature task
  N-0101 Implement parser change
  N-0102 Review parser change        depends_on N-0101
  N-0103 Implement CLI wiring
  N-0104 Review CLI wiring           depends_on N-0103
  N-0105 Integrate parser + CLI      depends_on N-0102, N-0104
  N-0106 Cross-consistency review    depends_on N-0105
```

Granularity guidance:

- Small/simple task: implementation lead may self-review and record the result.
- Bounded non-trivial task: create a dependent review node; use `reviewer` if risk/complexity warrants it.
- Group/integration task: create integration review node checking child consistency.
- Feature/domain completion: dedicated reviewer strongly preferred.

Review tasks should check correctness, tests/validation, architecture smells, compatibility policy, cross-consistency, and alignment with chosen Loom design/decision nodes.

## Readiness Checks

`loom.ready implement` should verify:

- chosen design/decision exists;
- task node has clear scope;
- target repos are identified;
- source repo paths are identified;
- base branches/commits are identified;
- dirty state checked;
- worktree plan defined;
- validation commands and environment paths are known;
- parallelization boundaries are clear;
- review/validation nodes exist or are intentionally unnecessary;
- cleanup/promotion policy is understood.

Other readiness modes may check whether specs are clear enough to design, designs are clear enough to decide, and plans are clear enough to implement.

## Implementation Roadmap

Initial implementation should prioritize:

1. Add Loom Pi package manifest resources for prompts and skills.
2. Add prompt template stubs and skill stubs for the initial Loom workflows.
3. Enhance Tango skill resolution to find explicit skills from Pi global/project/package resources.
4. Add `loom-curator` role.
5. Assign Loom skills explicitly to relevant roles.
6. Encode worktree and review-node guidance into `loom-implement`, `loom-plan`, `loom-breakdown`, `implementation-lead`, `team-lead`, and `design-lead` prompts.

Defer:

- `loom.status` until core workflows exist.
- broad graph repair/reconcile/retro commands unless recurring usage proves they are needed.
