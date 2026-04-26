# Loom Agent Workflows Implementation Plan

Status: draft  
Date: 2026-04-26

Related design: `docs/specs/loom-agent-workflows/design.md`

## Summary

Implement the Loom agent workflow layer in three pieces:

1. Package Loom prompt templates and skills as Pi resources.
2. Teach Tango role skill resolution to find explicit skills from Pi user/project/package resources.
3. Add/update Tango roles and role prompts so Loom-aware agents can use the new skills conditionally, while preserving bounded scope and review/validation discipline.

This plan intentionally starts with prompt/skill stubs and integration plumbing. It does not require changing Loom's graph storage model or adding new Loom CLI commands yet.

## Implementation Principles

- Keep Loom usage conditional. Skills should not cause agents to invent Loom usage without assignment/context.
- Keep Tango as orchestration, not package storage.
- Keep Pi package manifests as the source of truth for prompt/skill resources.
- Keep subagent context bounded: Tango should still disable automatic skills/prompt discovery for child agents and only pass role-declared skills.
- Prefer small, reviewable changes: package manifest, resource files, resolver code, roles, then validation.

## Milestone 1: Loom Pi Package Manifest

### Files

- `packages/loom/package.json`
- `packages/loom/prompts/`
- `packages/loom/skills/`

### Work

1. Add Pi resource manifest to `packages/loom/package.json`:

   ```json
   "pi": {
     "skills": ["./skills"],
     "prompts": ["./prompts"]
   }
   ```

2. Keep existing `keywords: ["pi-package"]`.
3. Create conventional directories if missing:
   - `packages/loom/prompts/`
   - `packages/loom/skills/`

### Acceptance

- Pi package discovery can see Loom prompts and skills when the Loom package is installed/listed in settings.
- `npm run check --workspace @bravo/loom` still passes.

## Milestone 2: Prompt Template Stubs

### Files

Create prompt templates under `packages/loom/prompts/`:

- `loom.spec.md`
- `loom.clarify.md`
- `loom.breakdown.md`
- `loom.branch-design.md`
- `loom.decide.md`
- `loom.plan.md`
- `loom.analyze.md`
- `loom.implement.md`
- `loom.ready.md`

### Work

Each prompt template should include frontmatter with `description` and, where useful, `argument-hint`.

Initial templates should be concise workflow prompts, not full implementations. They should:

- state the workflow goal;
- require conditional Loom usage;
- instruct the root session to ask before initializing a new Loom unless explicitly requested;
- reference `loom agent guide` when Loom context is active;
- prefer Loom commands over manual `.loom` edits;
- include appropriate stop conditions.

### Acceptance

- Prompt templates load as slash commands in root Pi when Loom package is loaded.
- Names render as `/loom.spec`, `/loom.plan`, etc.
- Templates do not require the root agent to mutate Loom without user approval.

## Milestone 3: Skill Stubs

### Files

Create skill directories under `packages/loom/skills/`:

- `loom-clarify/SKILL.md`
- `loom-breakdown/SKILL.md`
- `loom-branch-design/SKILL.md`
- `loom-decide/SKILL.md`
- `loom-plan/SKILL.md`
- `loom-analyze/SKILL.md`
- `loom-implement/SKILL.md`
- `loom-ready/SKILL.md`

Optional later:

- `loom-status/SKILL.md`

### Skill Content Requirements

Every skill should have valid Agent Skills frontmatter:

```yaml
---
name: loom-analyze
description: ...
---
```

Descriptions should be specific enough for model selection/loading.

Every skill should include shared conditional usage guidance:

- Use only when assignment includes Loom context/reference or explicitly asks for this Loom workflow.
- If not Loom-aware, run or consult `loom agent guide` when needed.
- Fetch context with `loom context <node>` or inspect inbox with `loom inbox show <id>` before acting.
- Use `loom note`, `loom resolve`, `loom decompose`, `loom branch`, `loom decide`, etc. rather than manually editing `.loom` files.
- Do not edit `.loom/index.sqlite`, `.loom/runtime/runtime.sqlite`, `.loom/events.jsonl`, locks, registry internals, or delivery internals.

### Skill-Specific Requirements

- `loom-clarify`: ask limited high-impact questions; record answers durably.
- `loom-breakdown`: decompose a node into child nodes; add review/validation nodes for implementation breakdowns.
- `loom-branch-design`: create design alternatives and optionally assign variant planners.
- `loom-decide`: compare branches and create explicit decision nodes.
- `loom-plan`: produce plan/task nodes from a chosen design; stop if no chosen design exists; add dependent review/validation nodes.
- `loom-analyze`: read-only consistency/architecture/graph analysis; no mutation unless explicitly asked.
- `loom-implement`: coordinate implementation tasks, worktrees, validation, and result recording.
- `loom-ready`: readiness checks for spec/design/plan/implement/review modes.

### Acceptance

- Pi skill validation produces no blocking errors.
- Skills are accessible to root Pi via `/skill:<name>` when Loom package is loaded.
- Skills are concise enough to be injected into subagents without overwhelming context.

## Milestone 4: Tango Skill Resolution from Pi Resources

### Files to Inspect/Modify

- `packages/tango/src/harnesses/pi.ts`
- `packages/tango/src/paths.ts`
- possibly new helper file, e.g. `packages/tango/src/piResources.ts`
- Tango tests if present or add focused tests if practical

### Current Behavior

Tango's Pi harness launches subagents with:

```txt
--no-skills --no-prompt-templates --no-extensions
```

Then it passes only role-declared skills using `--skill <path>`. Current skill resolution checks explicit paths, Tango user skills, and Tango package skills.

### Required Behavior

Keep automatic skill discovery disabled for subagents, but resolve explicit role skill names from Pi resources for both Pi and Claude harnesses. Pi harness agents receive resolved `--skill <SKILL.md>` paths. Claude harness agents receive copied skill directories under the generated agent home at `.claude/skills/<skill-name>/`.

Resolution order:

1. Explicit path as provided.
2. Existing Tango user skills:
   - `~/.tango/skills/<name>/SKILL.md`
   - `~/.tango/skills/<name>.md`
3. Existing Tango package skills:
   - `packages/tango/skills/<name>/SKILL.md`
   - `packages/tango/skills/<name>.md`
4. Pi global user skills:
   - `~/.pi/agent/skills/<name>/SKILL.md`
   - `~/.pi/agent/skills/<name>.md`
5. Project/user `.pi/skills` and `.agents/skills` locations discoverable from the agent CWD.
6. Installed Pi packages from settings:
   - package `pi.skills` manifest entries;
   - conventional `skills/` directories when appropriate.

### Settings Sources

Resolver should inspect relevant Pi settings:

- global: `~/.pi/agent/settings.json`
- project: `.pi/settings.json` from CWD/ancestors if supported by Pi semantics

For package entries, support at least local path package specs first because this monorepo uses local package paths. Object-form package filtering can be basic initially, but should not break normal string package entries.

### Package Skill Discovery

For each package root:

- read `package.json`;
- if `pi.skills` exists, search those directories/globs for skill names;
- if no manifest skill narrowing exists, search conventional `skills/`;
- support both skill directory form `<skill>/SKILL.md` and top-level `<skill>.md` where Pi supports it.

### Acceptance

- A Pi role with `skills: [loom-analyze]` resolves to `packages/loom/skills/loom-analyze/SKILL.md` when Loom package is in Pi settings.
- A Claude role with `skills: [loom-analyze]` copies `packages/loom/skills/loom-analyze/` to the generated home `.claude/skills/loom-analyze/`.
- Existing Tango-local skill resolution still works.
- Missing skills produce a useful error listing searched locations or at least the skill name.
- Tango subagents still do not receive all Pi skills automatically.

## Milestone 5: Role Updates

### Files

Global user roles currently live under:

- `/home/joe/.tango/roles/*.md`

Package-default roles may also be added later under:

- `packages/tango/roles/`

### Work

1. Add `loom-curator` role:
   - model: `k2p6`
   - thinking: `high`
   - mode: `oneshot`
   - recursive: false
   - no write tools by default unless explicitly desired
   - skills: `loom-analyze`, `loom-ready`

2. Update relevant role skill lists after resolver support exists:

   - `design-lead`: `loom-breakdown`, `loom-branch-design`, `loom-decide`, `loom-plan`, `loom-ready`, `loom-analyze`
   - `planner`: `loom-plan`, `loom-ready`
   - `interactive-planner`: `loom-clarify`, `loom-breakdown`, `loom-plan`, `loom-ready`
   - `architecture-consultant`: `loom-analyze`, `loom-decide`
   - `reviewer`: `loom-analyze`, `loom-ready`
   - `team-lead`: `loom-breakdown`, `loom-plan`, `loom-ready`, `loom-analyze`
   - `implementation-lead`: `loom-implement`, `loom-ready`, `loom-analyze`

3. Keep skills conditional in prompts. The role having a Loom skill does not authorize arbitrary Loom creation/mutation.

4. Add `loom-curator` to appropriate recursive allowed-child role lists, likely:
   - `team-lead`
   - `design-lead`
   - maybe root usage only, not necessarily `implementation-lead`

### Acceptance

- `tango roles list --json` shows `loom-curator` and updated roles.
- Starting a role with Loom skills succeeds once package resolver is implemented.
- Roles without Loom assignments still should not use Loom spontaneously.

## Milestone 6: Worktree Guidance in Skills and Prompts

### Files

- `packages/loom/skills/loom-implement/SKILL.md`
- `packages/loom/skills/loom-plan/SKILL.md`
- `packages/loom/skills/loom-breakdown/SKILL.md`
- `packages/loom/skills/loom-ready/SKILL.md`
- prompt templates for `loom.implement`, `loom.plan`, `loom.breakdown`, `loom.ready`
- role prompts for `implementation-lead`, `team-lead`, `design-lead` if not already covered

### Worktree Rules to Encode

- Worktree root formula:

  ```txt
  dirname(source_repo) + "/.worktrees/" + basename(source_repo)
  ```

- Do not put worktrees in `.loom/`.
- Always use named branches for agent work.
- Branch naming:

  ```txt
  loom/<loom-alias-or-id>/<node-id>-<slug>
  loom/<loom-alias-or-id>/<node-id>-<slug>/<agent-or-attempt>
  ```

- Before creating worktrees, record source repo path, branch, commit, dirty state, base, and validation environment.
- Do not create from dirty state silently.
- Use source repo virtualenv/dependency setup when provided.
- Worker worktrees default to diff handoff, not commits, unless requested.
- Integration worktrees commit at meaningful checkpoints.
- Do not delete worktrees/branches without explicit approval.

### Acceptance

- `loom-implement` and `loom-ready` contain the worktree convention.
- Implementation agents have clear stop conditions for dirty source repos and cleanup.

## Milestone 7: Review/Validation Node Guidance

### Files

- `packages/loom/skills/loom-plan/SKILL.md`
- `packages/loom/skills/loom-breakdown/SKILL.md`
- `packages/loom/skills/loom-implement/SKILL.md`
- `packages/loom/skills/loom-ready/SKILL.md`
- `packages/loom/prompts/loom.plan.md`
- `packages/loom/prompts/loom.breakdown.md`
- `packages/loom/prompts/loom.implement.md`

### Required Guidance

When creating implementation tasks, also create dependent review/validation nodes at appropriate granularity.

Pattern:

```txt
Implement A
Review A depends_on Implement A
Implement B
Review B depends_on Implement B
Integrate A+B depends_on Review A, Review B
Cross-consistency review depends_on Integrate A+B
```

Granularity:

- simple task: implementation lead may self-review and record result;
- bounded non-trivial task: dependent review node;
- integration/group task: cross-consistency review node;
- feature/domain completion: dedicated reviewer preferred.

### Acceptance

- Planning/breakdown prompts explicitly discourage one giant final review when granular review is practical.
- `loom.ready implement` checks that review/validation path exists or is intentionally unnecessary.

## Milestone 8: Root Pi Settings and Main-Agent Communication Guidance

### Files

- `/home/joe/.pi/agent/settings.json`
- `/home/joe/.pi/agent/AGENTS.md`

### Work

Add Loom package to `packages` if not present:

```json
"../../Documents/projects/bravo-pi-mono/packages/loom"
```

Update the global root-session guidance so the main user-facing agent defaults to concise, high-level, progressively disclosed responses. The main session should synthesize proposals and decisions without dumping implementation details, code, or exhaustive breakdowns unless the user asks for that depth. Loom/spec artifacts should hold granular detail; conversation should usually summarize and offer expansion.

Also encode root-session delegation bias: broad exploratory requests should usually be delegated to scouts/researchers, while active Loom/Tango workstream questions should route through the closest relevant active lead/agent when reasonable. The root should synthesize returned summaries and personally inspect source-of-truth artifacts or targeted evidence needed for judgment.

### Acceptance

- New Pi sessions load Loom prompt templates and skills.
- `/reload` in Pi should pick up prompts/skills if supported.
- Root-session `AGENTS.md` instructs the main agent to keep user-facing planning/design discussion concise by default and verbose only when appropriate.
- Root-session `AGENTS.md` instructs the main agent to delegate broad reconnaissance and route active workstream questions through relevant active agents when reasonable.

## Milestone 9: Validation

### Commands

From repo root:

```bash
npm run check --workspace @bravo/loom
npm run build --workspace @bravo/loom
npm run check --workspace @bravo/tango
npm run build --workspace @bravo/tango
```

If broader changes occur:

```bash
npm run check
npm run build
```

### Manual Checks

- `tango roles list --json` shows updated roles.
- `tango roles show <role> --json` includes expected skills once role frontmatter is updated.
- Start a small one-shot agent using a role with one Loom skill and verify Pi launches with `--skill <resolved path>`.
- In a new/root Pi session or after reload, verify prompt templates appear as `/loom.*` and skills as `/skill:loom-*`.

## Risks and Mitigations

### Risk: Resolver diverges from Pi's actual package discovery

Mitigation: implement minimal support for local package paths and `pi.skills` first; keep logic small and documented. Prefer reusing Pi discovery APIs later if exposed.

### Risk: Too many skills bloat subagent prompts

Mitigation: Tango still passes only role-declared skills. Keep skill docs concise. Avoid giving all Loom skills to all roles.

### Risk: Agents mutate Loom when not intended

Mitigation: conditional Loom usage language in every skill and role. Root prompt asks user before creating Loom.

### Risk: Worktree cleanup loses work

Mitigation: prompts forbid automatic cleanup without explicit approval and require recording integration/rejection state first.

### Risk: Review tasks become noisy overhead

Mitigation: use granularity guidance. Simple tasks can be self-reviewed by implementation lead; dedicated reviewers are used for non-trivial or higher-level convergence points.

## Open Questions

- Should `loom-status` be implemented in the first batch or deferred until after core workflows prove useful?
- Should `loom-curator` be global-only initially, or also included as a child role for `team-lead` and `design-lead` immediately?
- How complete should Pi package filter/glob support be in Tango's first resolver implementation?

## Suggested Implementation Order

1. Loom package manifest.
2. Prompt and skill stubs.
3. Tango skill resolver enhancement.
4. Add/update roles and role skill lists.
5. Add Loom package to Pi settings and update root-session communication guidance.
6. Validate root Pi resource loading and Tango subagent skill resolution.
7. Iterate prompt/skill wording after first live use.
