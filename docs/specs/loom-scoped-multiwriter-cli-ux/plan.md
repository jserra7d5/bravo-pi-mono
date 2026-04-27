# Loom scoped multi-writer and agent-friendly CLI plan

Status: draft, initial implementation started  
Date: 2026-04-27

## Summary

This plan captures the proposed Loom usability rework after reviewing live Loom feedback and the `better-cli` guidance. The goal is to reduce agent friction while preserving Loom's intended architecture:

- **Pi slash commands and skills** provide opinionated workflows such as spec, clarify, breakdown, branch-design, decide, plan, analyze, implement, and ready.
- **The Loom CLI** provides strict, safe, composable graph primitives and views.
- **Tango** remains the live process/agent orchestration layer.

The most important refinement is that Loom should support **scoped multi-writer workflows**. Multiple agents may mutate the same Loom concurrently when each agent owns an exclusive subtree. Parent-level, sibling-level, and cross-subtree mutations should be coordinator-owned or proposed as scoped patches.

## Problem

Recent Loom-backed planning sessions showed that Loom is useful as durable graph context, but it currently adds too much operational friction for agents:

- lock contention from many small concurrent writes;
- terse `LOCK_TIMEOUT` errors and manual stale-lock recovery;
- ambiguous CLI forms such as `loom create task "Title"`;
- no batch/patch mechanism for graph construction;
- weak command-specific help;
- graph relationships are easy to misuse or duplicate;
- notes are durable but not queryable enough;
- `show`/`context` output can be too verbose for agent control loops;
- workflow state and review outcomes are often encoded as prose notes;
- agents do not receive clear mutation-scope boundaries when working in parallel.

The core issue is not that Loom lacks planning methodology. Loom already has Pi prompt templates and skills for that. The issue is that the substrate is not yet safe and ergonomic enough for stateless agents to use reliably.

## Design principle

Do **not** turn the Loom CLI into a rigid planning wizard.

Instead:

```txt
Pi slash commands / skills = opinionated workflows
Loom CLI                 = durable graph substrate + safe mutation/query primitives
Tango                    = live agent/process orchestration
```

Loom should become more opinionated at the workflow layer, and more strict/composable at the CLI layer.

## Scoped multi-writer model

Parallel Loom mutation is allowed when each writer has an exclusive graph scope.

Example:

```txt
N-0000 Root
├─ N-0001 Schema workstream      # Agent A owns this subtree
├─ N-0002 Runtime workstream     # Agent B owns this subtree
└─ N-0003 UI/validation          # Agent C owns this subtree
```

### Allowed inside an assigned scope

If an agent owns `N-0001`, it may:

- inspect `N-0001` and descendants;
- create child nodes under `N-0001` or descendants;
- add/update notes on nodes inside the subtree;
- attach references/artifacts to nodes inside the subtree;
- add edges where both endpoints are inside the subtree;
- update state for nodes inside the subtree, if authorized by the assignment.

### Not allowed inside an assigned scope

The agent should not directly:

- mutate the parent of the assigned root;
- mutate sibling subtrees;
- add cross-subtree dependency/review/validation edges;
- resolve, cancel, or supersede nodes outside its scope;
- edit global Loom metadata or runtime coordination state;
- change shared decisions unless the decision node is inside the assigned scope.

### Cross-scope changes

If an agent discovers a needed cross-scope relationship, it should propose it rather than apply it.

Example final-result section:

```txt
Requested coordinator action:
- Add edge: N-0014 depends_on N-0021
- Reason: schema adapter depends on runtime event type from runtime workstream.
```

The coordinator applies cross-scope relationships after reviewing all sibling workstreams.

## Coordinator protocol

When dispatching parallel Loom agents, the coordinator should:

1. Create or identify one child node per workstream.
2. Assign each agent an explicit mutation scope rooted at one child node.
3. Tell each agent what mutations are allowed and forbidden.
4. Prefer graph patches/drafts for multi-node changes.
5. Require a structured mutation summary from each agent.
6. Collect requested cross-scope changes from agent results.
7. Apply cross-scope relationships at the parent/coordinator level.
8. Run graph diagnostics for the parent scope.

Suggested assignment text:

```txt
You are assigned Loom scope N-0031 Runtime workstream.

Allowed Loom mutations:
- Add/update notes on N-0031 and descendants.
- Create child nodes under N-0031 or descendants.
- Add references/artifacts to N-0031 descendants.
- Add edges only when both endpoints are inside the N-0031 subtree.

Not allowed:
- Do not mutate N-0028, N-0030, N-0032, N-0033, or their descendants.
- Do not add cross-workstream dependency edges directly.
- Do not resolve/cancel/supersede nodes outside N-0031.

If you identify a needed cross-scope dependency, include it in your final result as:
Requested coordinator action:
- edge: <from> depends_on <to>
- reason: ...

Use `loom context N-0031 --brief --json` first. If creating multiple nodes/edges, produce/apply a scoped patch if available; otherwise keep individual Loom writes minimal.
```

## Worker result contract

Any agent that mutates Loom should return a structured summary:

```txt
Loom mutation summary:
- Scope root:
- Nodes created:
- Nodes updated:
- Edges added:
- Notes added:
- References/artifacts added:
- State changes:
- Validation run:
- Blockers:
- Requested coordinator actions:
- Recommended next node/action:
```

This should be added to Loom skills and relevant prompt templates.

## CLI rework goals

The CLI should become a strict, composable graph operating surface.

### Recommended top-level namespaces

The exact command names can be refined during implementation, but the CLI should move toward noun-first primitives:

```bash
loom node ...
loom edge ...
loom note ...
loom reference ...
loom artifact ...
loom patch ...
loom graph ...
loom lock ...
loom inbox ...
loom agent ...
loom schema ...
```

Avoid adding workflow-specific CLI commands such as:

```bash
loom plan ...
loom implement ...
loom decide ...
loom ready implement ...
```

Those belong in Pi slash commands and skills.

## Core CLI capabilities

### 1. Command-specific help and schema introspection

Every command should have command-level help:

```bash
loom node create --help
loom edge add --help
loom patch apply --help
```

Help should include:

- description;
- usage;
- flags with types/defaults;
- realistic examples;
- exit codes;
- see-also commands.

Add structured introspection for agents:

```bash
loom schema commands --json
loom schema command node.create --json
loom schema output context --json
```

### 2. Strict argument parsing

The CLI should reject unknown flags and suspicious invocations. Since backward compatibility is not required for this rework, prefer one clear grammar over aliases.

Recommended creation form:

```bash
loom node create --kind task --title "Schema normalization" --parent N-0028
```

Avoid ambiguous positionals for creation.

### 3. Consistent JSON envelope

Adopt a consistent JSON envelope for all commands:

```json
{
  "status": "ok",
  "data": {},
  "warnings": [],
  "next_steps": []
}
```

Error envelope:

```json
{
  "status": "error",
  "error": {
    "code": "LOCK_TIMEOUT",
    "message": "Could not acquire Loom lock",
    "fix": "Run: loom lock status --json",
    "transient": true,
    "details": {}
  }
}
```

### 4. stdout/stderr contract

- stdout contains primary data only.
- stderr contains diagnostics, warnings, progress, and human errors.
- In `--json` mode, stdout should contain exactly one JSON envelope unless using an explicit streaming mode.

### 5. Dry-run for mutations

All mutating commands should support `--dry-run`:

```bash
loom node create --kind task --title "..." --parent N-0028 --dry-run --json
loom edge add --from N-0063 --type depends_on --to N-0062 --dry-run --json
loom patch apply --scope N-0031 --stdin --dry-run --json
```

Dry-run output should show planned changes without mutating files, SQLite projections, runtime state, or events.

### 6. Idempotent relationship and reference mutations

Duplicate-safe operations are required because agents retry.

- Duplicate edge: exit 0, no-op.
- Duplicate reference: exit 0, no-op.
- Duplicate artifact attachment: exit 0 or clear conflict depending on file/copy semantics.
- Patch operations should support idempotency keys or deterministic refs where practical.

### 7. Graph patches

Add a generic graph patch mechanism:

```bash
loom patch validate --stdin --json
loom patch preview --stdin --json
loom patch apply --stdin --json
loom patch apply --scope N-0031 --stdin --json
```

Patch input may be JSON or YAML. It should support stable local refs so edges can refer to nodes created earlier in the same patch.

Example:

```yaml
nodes:
  schema_task:
    title: Schema ADR/spec consolidation
    kind: task
    parent: N-0028
    summary: Consolidate schema contract before runtime work.
    notes:
      - type: scope
        body: |
          Target files...
          Validation...

  runtime_task:
    title: Runtime event normalization
    kind: task
    parent: N-0028

edges:
  - from: runtime_task
    type: depends_on
    to: schema_task
```

Patch application should:

- acquire one lock;
- validate scope before writing;
- allocate IDs deterministically within the transaction;
- write nodes/notes/edges/references;
- append events;
- rebuild/update projections once;
- return created/updated IDs and next steps.

### 8. Scoped patch enforcement

Add scope validation:

```bash
loom patch apply --scope N-0031 --stdin --json
loom scope check --root N-0031 --stdin --json
```

A scoped patch may only mutate nodes inside the scope root's subtree and may only add internal edges, unless explicitly marked as a proposal.

Out-of-scope mutation should fail with `SCOPE_VIOLATION` and an actionable fix.

### 9. Draft workflow

Support safe staging of graph changes. This can be implemented as first-class drafts or as patch preview/apply workflow.

Potential commands:

```bash
loom draft create --for N-0028 --title "Implementation breakdown"
loom draft show D-0001 --json
loom draft commit D-0001
loom draft discard D-0001
```

If first-class drafts are too much for the first pass, `loom patch validate/preview/apply` can satisfy most needs.

### 10. Compact context and handoff views

Improve read APIs for agents:

```bash
loom context N-0028 --brief --json
loom context N-0028 --recent-notes 3 --json
loom context N-0028 --fields node,children,edges,references --json
loom context N-0028 --handoff worker --json
loom context N-0028 --handoff reviewer --json
```

Default context should avoid dumping large bodies unless requested.

### 11. Graph views and diagnostics

Add generic graph comprehension tools:

```bash
loom graph summary N-0028 --json
loom graph view N-0028 --format text
loom graph view N-0028 --format mermaid
loom graph doctor --json
loom graph doctor --scope N-0031 --json
```

`graph doctor` should detect:

- broken edges;
- duplicate edges;
- dependency cycles;
- orphan review/validation nodes;
- missing parents where parentage is expected;
- references with literal `"undefined"` workspace;
- out-of-scope edges in scoped work;
- stale rejected/superseded branches linked into active work;
- proposed cross-scope changes awaiting coordinator action.

### 12. Relationship vocabulary

Define and validate a small relationship vocabulary:

```txt
depends_on
blocks
reviews
validates
implements
references
critiques
chooses
supersedes
duplicates
related
```

Commands:

```bash
loom edge add --from N-0063 --type depends_on --to N-0062
loom edge list --node N-0063 --direction both --json
loom edge types --json
```

Unknown edge types should fail unless explicitly namespaced, e.g. `custom:<name>`.

### 13. Structured notes

Notes should become queryable entries with metadata while preserving human-readable node files.

Commands:

```bash
loom note add N-0062 --type finding --stdin
loom note add N-0062 --type blocker --stdin
loom note add N-0062 --type validation --status pass --command "npm test" --stdin
loom note list N-0062 --type blocker --json
loom note retract NOTE-0042 --reason "probe note"
```

Suggested note types:

```txt
finding
question
answer
blocker
decision-rationale
validation
result
review
handoff
correction
proposed-cross-scope-change
```

### 14. Generic node state

Add simple machine-readable state without embedding full implementation workflow in the CLI.

Suggested generic states:

```txt
open
ready
active
blocked
done
cancelled
superseded
```

Commands:

```bash
loom node update N-0062 --state blocked --reason "Missing schema decision"
loom node update N-0062 --state done --summary "Completed and validated"
```

Workflow-specific interpretation remains in skills and slash commands.

### 15. Lock diagnosis and recovery

Add:

```bash
loom lock status --json
loom lock clear-stale
```

Lock metadata should include:

```json
{
  "pid": 123,
  "host": "joe-desktop",
  "command": "loom patch apply",
  "started_at": "2026-04-27T...Z"
}
```

`LOCK_TIMEOUT` should report:

- lock path;
- holder PID/host/command/time;
- age;
- alive/dead status when same host;
- fix command;
- transient flag.

### 16. Optional relationship suggestions

Later, add generic structural suggestions:

```bash
loom graph suggest-links N-0028 --json
loom graph accept-suggestion S-0001
```

Initial heuristics can include:

- review-like node without `reviews` edge;
- validation-like node without `validates` edge;
- note text mentions `depends on N-xxxx` but no edge exists;
- nodes share references to the same files;
- duplicate/similar titles in sibling subtrees.

## Slash command, skill, and role workflow split

Loom already exposes Pi slash-command prompt templates and matching skills. Do not duplicate those workflows as literal Loom CLI commands. Instead, make the division of responsibility explicit.

### Recommended split

```txt
Slash commands (/loom.*)
  User-facing root-session entrypoints. They interpret the user's intent, choose the right workflow, decide whether to use Loom, ask for approval when needed, and either do small direct work or delegate to an appropriate agent.

Skills (loom-*)
  Reusable procedural guidance loaded into agents. Skills describe how an agent should perform a Loom-aware workflow when assigned that task. They are not user commands and should be usable by root sessions, leads, planners, reviewers, and workers.

Loom-aware coordinator role
  Interactive delegated owner of a Loom subtree/workstream. This agent may use Loom skills, dispatch children, enforce scoped multi-writer rules, collect patches/results, apply cross-scope relationships, and report concise synthesis to the parent/root.

Loom CLI
  Runtime-agnostic graph substrate: nodes, edges, notes, patches, context, graph views, lock handling, inbox, schema.
```

### Slash command guidance

Slash commands are routing/orchestration entrypoints. Skills are execution procedures for the agent that actually does the work.

A slash command must not blindly execute its matching `loom-*` skill in the root session. Instead, it should identify the target Loom/node/scope, choose the appropriate executing agent, and pass that agent a clear assignment. The selected executing agent then uses the relevant skill.

Correct flow:

```txt
User invokes /loom.plan
  -> root session interprets target and intent
  -> root session reuses/spawns/messages appropriate agent
  -> executing agent uses loom-plan skill
  -> executing agent mutates/reports within assigned scope
```

Avoid this flow by default:

```txt
User invokes /loom.plan
  -> root session performs entire loom-plan workflow itself
```

The root may still execute directly for small/simple/read-only tasks or when the user explicitly asks it to do so.

The existing slash commands should remain relatively small and user-facing:

- `/loom.spec` — route/start/update durable proposal context; ask before creating Looms unless explicitly instructed.
- `/loom.clarify` — route/perform targeted clarification for a referenced Loom node and record accepted answers.
- `/loom.breakdown` — route decomposition of a node; dispatch a coordinator/agents for nontrivial breakdown.
- `/loom.design` — route normal single-design development when branching is not needed or not requested.
- `/loom.branch-design` — route multi-variant design branching when alternatives are materially useful.
- `/loom.decide` — route comparison of variants/options and record/propose decisions.
- `/loom.plan` — route implementation graph creation from a chosen design, usually through a Loom-aware coordinator for nontrivial plans.
- `/loom.analyze` — route read-only graph consistency/risk analysis, often to reviewer/curator/coordinator.
- `/loom.implement` — route implementation coordination from task nodes, often to a Loom-aware coordinator or implementation lead.
- `/loom.ready` — route/perform readiness check; usually read-only unless asked to record the result.

Add likely slash commands:

- `/loom.design` — normal design workflow for the common case where the user wants one design, not multiple branches.
- `/loom.status` — read-only status: summarize active Loom/node, open decisions, blockers, active branches, ready tasks, reviews, inbox items, and recommended next action.
- `/loom.curate` — graph hygiene workflow: find stale branches, duplicate concepts, broken references, missing review/validation, and proposed cleanup. Defaults to read-only; writes only with explicit approval.

Avoid adding slash commands for every primitive graph operation. Primitives belong in the CLI.

### Loom-aware coordinator role

Add a dedicated interactive role, tentatively `loom-coordinator`, for cases where the root session wants another agent to own Loom coordination rather than executing the slash-command workflow itself.

Purpose:

- own a bounded Loom node/subtree/workstream;
- coordinate scoped multi-writer mutations;
- delegate scouts/planners/reviewers/workers as needed;
- assign explicit mutation scopes to children;
- ask children for graph patches or structured proposals;
- apply scoped patches and coordinator-owned cross-scope edges;
- run graph/context/doctor views;
- keep the parent/root updated with concise synthesis.

The role should be interactive and recursive. Suggested skills:

```txt
skills: [loom-clarify, loom-breakdown, loom-branch-design, loom-decide, loom-plan, loom-ready, loom-analyze, loom-implement]
allowedChildRoles: [scout, planner, reviewer, worker, fast-worker]
```

The existing `lead` role already has many Loom skills, but it is a general bounded workstream coordinator. `loom-coordinator` should be more specific: it owns Loom graph health, scoped mutation boundaries, patches, cross-scope relationship coordination, and durable handoff quality.

### Persistent coordinator reuse

Slash commands should treat a Loom coordinator as a persistent workstream owner, not a disposable helper. If an active relevant `loom-coordinator` already exists for the Loom or node/subtree, the slash command should route the workflow through that coordinator when reasonable.

Coordinator selection order:

1. If the user names a specific coordinator/agent, use it.
2. If the target node/subtree has an active known `loom-coordinator`, message that coordinator.
3. If the current Loom has one active coordinator and the command target is inside its scope, message that coordinator.
4. If no suitable coordinator exists and the workflow is nontrivial, ask the user whether to spawn one.
5. If the work is trivial/read-only, the root session may handle it directly.

When spawning a coordinator, assign it a stable, scope-derived name when possible, e.g. `loom-<loom-alias>-<node-id>-coord`, and record/communicate its scope. The coordinator should remain interactive for follow-up slash commands.

### When slash commands should delegate

Slash commands should not always execute the workflow directly in the root session. They should delegate when the work is broad, branchy, multi-agent, implementation-tracked, or likely to require sustained graph ownership. If the user implies delegation, asks to coordinate, or a coordinator already exists, prefer routing to the coordinator over doing the workflow in root.

Delegation assignment should explicitly name the skill/workflow the executing agent should use. Example phrasing:

```txt
The user invoked /loom.plan for N-0028. You are the executing Loom coordinator for scope N-0028. Use the loom-plan workflow/skill to create or propose the implementation graph. Reuse scoped multi-writer rules, prefer a graph patch for multi-node changes, and report nodes/edges/notes/state changes plus requested coordinator actions.
```

Examples:

```txt
/loom.design N-0028
  If a coordinator already owns N-0028 or its Loom, message it to develop/update the design.
  If no coordinator exists and the design is substantial, ask whether to spawn one.
  If the design is small, root may handle directly.

/loom.plan N-0028
  If trivial: root may create/update nodes directly.
  If nontrivial: reuse or start loom-coordinator with scope N-0028 and ask it to create a scoped implementation graph.

/loom.implement N-0062
  If a single small task: root may assign worker directly.
  If multi-step or review-heavy: start loom-coordinator/lead to own implementation coordination and Loom updates.

/loom.breakdown N-0001
  If three independent child scopes emerge: coordinator creates/assigns those scopes, then children mutate only their own subtrees.
```

### Child-agent slash command issue

Agents generally cannot or should not rely on interactive slash commands inside delegated sessions. A parent should not tell a child “run `/loom.plan`.” Instead, the parent should either:

1. invoke the slash command in the root session, and let that command route to the right executing agent;
2. start/message a `loom-coordinator`/`lead` agent with the equivalent plain-language task, relevant Loom scope, and the skill/workflow it should use; or
3. start a planner/reviewer/worker with the relevant `loom-*` skill and explicit scope/permissions.

In other words:

```txt
User/root uses slash commands as routing entrypoints.
Delegated agents use skills plus explicit instructions.
```

This distinction should be added to `agent-guide.md` and every prompt template. Prompt templates should be rewritten to start with routing rules, then include the underlying workflow only as guidance for the executing agent or as text to pass to a coordinator/worker.

### Consolidation recommendation

Keep the existing slash command set, add `/loom.design`, and later add `/loom.status` and `/loom.curate`. Do not add more workflow slash commands until recurring usage proves a gap.

The biggest consolidation should happen in responsibilities:

- slash commands should be thin routers/orchestrators, not automatic root-session skill execution;
- skills should hold the reusable method for the selected executing agent;
- `loom-coordinator` should own sustained Loom workstreams and use the skills directly;
- one-shot planners/reviewers/workers may use individual Loom skills when assigned bounded work;
- the CLI should avoid workflow-specific verbs.

## Prompt and skill updates

Update these files:

```txt
packages/loom/prompts/agent-guide.md
packages/loom/prompts/loom.spec.md
packages/loom/prompts/loom.clarify.md
packages/loom/prompts/loom.breakdown.md
packages/loom/prompts/loom.branch-design.md
packages/loom/prompts/loom.decide.md
packages/loom/prompts/loom.plan.md
packages/loom/prompts/loom.analyze.md
packages/loom/prompts/loom.implement.md
packages/loom/prompts/loom.ready.md
packages/loom/skills/*/SKILL.md
```

### Required guidance additions

- Scoped multi-writer model.
- Coordinator-owned cross-scope mutations.
- Patch-first guidance for multi-node changes.
- Required mutation summary from Loom-mutating agents.
- Preferred relationship vocabulary.
- Use compact context views for routing/control loops.
- Use `--json` for parsing.
- Use `--stdin` for nontrivial note bodies.
- Do not manually edit Loom internals.

### Example skill text

```txt
When assigned a Loom mutation scope, mutate only the assigned scope root and descendants. Do not edit parent nodes, sibling subtrees, or cross-subtree edges directly. If a cross-scope dependency or review relationship is needed, include it as a requested coordinator action in your final result.

If creating more than a few nodes, notes, references, or edges, prefer a scoped graph patch and apply it once. If patch support is unavailable, keep individual writes minimal and report exactly what changed.
```

## Testing plan

Add CLI-level contract tests for:

- command-specific help exists;
- unknown flags fail;
- JSON success envelope shape;
- JSON error envelope shape with `fix` and `transient`;
- stdout/stderr separation;
- `--dry-run` does not mutate files/events/index/runtime;
- duplicate edge/reference operations are no-op success;
- patch validation/apply;
- scoped patch rejection for out-of-scope mutations;
- lock status and stale lock handling;
- graph doctor findings;
- context brief output avoids full body;
- structured note add/list/retract;
- node state update;
- edge vocabulary validation.

Add fixture Looms under:

```txt
packages/loom/test/fixtures/
```

Useful fixtures:

- clean proposal/design/task graph;
- graph with duplicate edges;
- graph with cross-scope edge;
- graph with orphan review node;
- graph with stale lock;
- graph with `workspace: "undefined"` reference;
- graph with dependency cycle.

## Migration stance

Backward compatibility is not required for this rework. Prefer a clean, strict contract over aliases and legacy shims.

Required actions:

- update docs/specs;
- update prompts and skills;
- update tests;
- update examples;
- remove old command examples from agent-facing context.

Because LLM agents are stateless, updated instructions and schemas are more valuable than preserving old command forms.

## Phased implementation plan

### Phase 1: Documentation and workflow guidance

- Update agent guide with scoped multi-writer model.
- Update skills/prompts with scope, patch-first, and mutation-summary guidance.
- Define relationship vocabulary in docs.
- Define JSON envelope and CLI contract in docs.

### Phase 2: CLI contract hardening

- Add command-specific help.
- Add strict flag parsing.
- Add consistent JSON envelopes.
- Improve stdout/stderr separation.
- Add actionable errors with `fix` and `transient`.
- Add lock status/clear-stale and better timeout diagnostics.

### Phase 3: Core graph ergonomics

- Add noun-first command namespaces.
- Add compact context views.
- Add node update/state.
- Add edge add/list/types with idempotency and vocabulary validation.
- Add structured notes.

### Phase 4: Patch and scoped multi-writer support

- Add patch validate/preview/apply.
- Add `--scope` enforcement.
- Add patch result summaries.
- Add scope violation tests.

### Phase 5: Views and diagnostics

- Add graph summary/view/doctor.
- Add Mermaid output.
- Add graph fixtures and doctor tests.

### Phase 6: Drafts and suggestions

- Add first-class drafts if patch workflow is not sufficient.
- Add graph link suggestions and acceptance flow.

## Open questions

1. Should graph patches use JSON only, YAML only, or support both?
2. Should structured notes be stored in node frontmatter, command-owned body sections, events, SQLite runtime state, or a new notes file?
3. Should `node state` be limited to a small generic enum, or allow custom namespaced states?
4. Should cross-scope proposals be structured notes, patch entries, or first-class proposal records?
5. Should `graph doctor` be read-only only, or later support `--fix` for safe mechanical repairs?
6. Should `context --handoff worker/reviewer` be core CLI, or should handoff formatting remain in slash commands/skills using `context --brief`?

## Initial implementation notes: 2026-04-27

Implemented routing/coordinator and CLI v2 core slice:

- Added `/loom.design` prompt for normal single-design workflow.
- Added `loom-design` skill for executing agents.
- Updated existing `/loom.*` prompt templates so slash commands are routing/orchestration entrypoints, not automatic root-session skill execution.
- Updated existing `loom-*` skills so skills are execution procedures for assigned agents, with scoped mutation and mutation-summary guidance.
- Added package Tango role `loom-coordinator` as a persistent Loom workstream owner.
- Added command-specific help for key existing and v2 commands.
- Added JSON `status` field and richer error envelope fields while preserving existing `ok` compatibility in this slice.
- Added `loom lock status` and `loom lock clear-stale` plus actionable lock timeout details.
- Made `link`, `edge add`, and `reference add` duplicate-safe no-op successes.
- Added `loom context --brief`.
- Added `loom graph summary` and `loom graph doctor`.
- Added noun-first v2 commands: `loom node create|show|update|list`, `loom edge add|list|types`, `loom note add|list|retract`.
- Added JSON patch workflow: `loom patch validate|preview|apply --stdin [--scope N-xxxx] [--dry-run]`.
- Added scoped patch enforcement for node creation/update targets and internal edges.
- Added local refs inside patch operations.
- Added first-class patch drafts: `loom draft create|list|show|commit|discard`.
- Added schema introspection: `loom schema commands --json` and `loom schema command <name> --json`.
- Added strict unknown-flag rejection for v2 command surfaces.
- Added tests and hand-tested the CLI changes.

Not yet implemented from the broader plan:

- YAML patch input;
- richer structured note storage/query beyond Markdown heading-backed `note add/list/retract`;
- graph suggestion/acceptance flow;
- `graph doctor --fix` mechanical repair flow.

## Success criteria

The rework is successful when:

- agents can inspect Loom state with compact, predictable commands;
- coordinators can safely dispatch parallel agents with subtree scopes;
- agents can apply multi-node changes through scoped patches without lock thrash;
- out-of-scope mutations are detected before write;
- lock failures are diagnosable without manual filesystem surgery;
- duplicate retries do not corrupt relationships;
- graph consistency issues are discoverable through `graph doctor`;
- slash commands and skills remain the opinionated workflow layer;
- Loom feels like a lower-friction planning framework rather than an extra coordination burden.
