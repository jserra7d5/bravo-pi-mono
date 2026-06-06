# Pi Dynamic Skill Discovery Extension Design

## Goal

Build a Bravo Pi extension that gives Pi sessions Codex-like repo skill discovery when an agent reads into a deeper project subtree.

Example: session cwd is `~/Documents/Quantiiv`; the agent reads `~/Documents/Quantiiv/ROGER/api/foo.py`; the extension discovers `~/Documents/Quantiiv/ROGER/.agents/skills/*/SKILL.md`, previews the newly available skill names/descriptions, persists that discovery, and keeps those skills available after compaction.

This is a no-core-mod design. It does not mutate Pi's native skill registry at runtime.

## Architectural smell to keep visible

The clean platform seam would be a Pi core API such as `ctx.extendResources({ skillPaths })` after `tool_result`, followed by prompt/skill-command rebuild. Without that seam, the extension must simulate the model-visible part of skill discovery by injecting a compact dynamic skill catalog. That is acceptable for v1, but `/skill:name` autocomplete/expansion will not include dynamically discovered skills unless a reload path is added later.

## Package shape

- New package: `packages/dynamic-skills/`
- npm name: `@bravo/dynamic-skills`
- Pi package manifest:
  - `pi.extensions = ["./extensions/pi"]`
- Main extension file: `packages/dynamic-skills/extensions/pi/index.ts`
- Test files: `packages/dynamic-skills/test/*.test.ts`

## Functional behavior

### Discovery trigger

The extension listens to `tool_result`.

It only triggers when:

- `event.toolName === "read"`
- `event.isError !== true`
- `event.input.path` is a string
- the resolved real target path is below `ctx.cwd`
- the target path is deeper than `ctx.cwd`, not equal to it

The v1 trigger intentionally excludes `bash`, `grep`, `ranked_search`, and `showcase`; those do not have the same clear file-read contract.

### Discovery scope

For a successful deeper read:

1. Resolve target path against `ctx.cwd`.
2. If target is a file, start from its parent directory.
3. Walk upward from target directory to `ctx.cwd`, inclusive.
4. At each directory, check for `.agents/skills` and `.claude/skills`.
5. Load skill metadata from directories containing `SKILL.md` under each discovered `.agents/skills` and `.claude/skills` root.
6. Respect `disable-model-invocation: true` by excluding that skill from injected model-visible catalogs.
7. Do not scan above `ctx.cwd`.
8. Do not follow symlink escapes outside `ctx.cwd`.

This makes subtree skills available only after the agent actually touches that subtree.

### Model-visible response

When new skills are found during `tool_result`, append a small text block to the read result content:

```xml
<available_skills source="dynamic-subtree-read">
  <skill>
    <name>roger-ci-triage</name>
    <description>...</description>
    <location>/abs/path/to/ROGER/.agents/skills/roger-ci-triage/SKILL.md</location>
  </skill>
</available_skills>
```

Precede it with one sentence: `Discovered N additional repo skills for this subtree. Use read on a skill location when its description matches the task.`

Do not inject full skill bodies.

### Future-turn response

On every `before_agent_start`, append a compact dynamic skill catalog to `event.systemPrompt` when the branch has discovered skills that are not already in Pi's native loaded skills.

The section is idempotent and bounded:

```md
## Dynamically discovered repo skills

These skills were discovered after reading files below the session cwd. Use `read` to load a skill file when the task matches its description.

<available_skills source="dynamic-subtree-read">
...
</available_skills>
```

### Collision policy

Native Pi skills win.

- If a dynamic skill path is already present in `event.systemPromptOptions.skills`, skip it.
- If a dynamic skill name matches a native skill name at a different path, skip the dynamic skill and record a collision diagnostic.
- If two dynamic candidates refer to the same real `SKILL.md` path, keep one entry and prefer the `.agents` display path when available.
- If two dynamic skills share a name at different real paths, choose the newest `SKILL.md` `mtimeMs`; if the mtimes are an exact tie, prefer `.agents`.
- If a restored legacy snapshot skill or candidate lacks comparable `skillMtimeMs`/source-root data, do not replace the existing accepted skill; record the duplicate-name diagnostic deterministically.

Do not invent renamed aliases in v1. Duplicate names are more dangerous than missing a convenience skill.

### State and compaction

State is branch-scoped and durable.

In memory:

```ts
type DynamicSkill = {
  name: string;
  description: string;
  location: string; // absolute SKILL.md path
  baseDir: string;
  discoveredFrom: string; // absolute read target path
  discoveredAt: string; // ISO timestamp
};
```

Persist snapshots with:

```ts
pi.appendEntry("dynamic-skill-discovery", {
  version: 1,
  skills: DynamicSkill[],
  diagnostics: Diagnostic[],
});
```

Rehydrate on `session_start` from `ctx.sessionManager.getBranch()`, not the full session history, so tree navigation/forks get branch-correct state.

On `session_compact`, append a fresh snapshot. Custom extension entries do not participate in LLM context, but they stay in the session tree and are available for extension rehydration after reload/resume. The model-visible dynamic catalog is reinjected on the next `before_agent_start`.

### UX

Keep v1 quiet:

- No persistent widget.
- No footer status.
- Optional `ctx.ui.notify` only when skills are first discovered, and only in TUI/RPC modes.

The authoritative model-facing signal is the compact XML catalog in the read result and future system prompt.

## Runtime invariants & verification seams

| Behavior (boundary) | Invariant (property) | Faithful seam | Injected fault |
|---|---|---|---|
| `read` tool-result event to dynamic discovery | A successful read of a deeper path under `cwd` records each newly discovered eligible `SKILL.md` exactly once; same-cwd reads and outside-cwd reads record nothing. | Extension event harness invoking the real exported extension handler with Pi-shaped `tool_result` events and real temp filesystem paths. | Malformed relative path, absolute path outside cwd, repeated read of same target. |
| Skill metadata loading | Injected dynamic skill entries match Pi skill metadata semantics: name/description/location, missing description excluded, `disable-model-invocation` excluded. | Use Pi's exported `loadSkillsFromDir` against real temp `.agents/skills` and `.claude/skills` directories instead of a fake parser. | Missing frontmatter/description, invalid YAML, disabled model invocation. |
| Prompt injection | Every future turn includes discovered eligible skills once, excludes native skill duplicates, and never includes full skill body. | Extension harness calls `before_agent_start` with Pi-shaped `systemPromptOptions.skills` and inspects returned system prompt. | Name collision with native skill; path duplicate; long description. |
| Tool-result preview | When new skills are discovered, the read tool result is patched with a compact catalog; when none are new, result content is unchanged. | Extension event harness around `tool_result` return patch, using real discovered state. | Empty discovery; duplicate discovery; collision-only discovery. |
| Compaction/reload recovery | Dynamic skill state survives reload/compaction through custom branch entries and is reinjected on the next turn. | Session-manager-shaped branch fixture containing `custom` entries plus `session_start`/`session_compact` handler calls. | Multiple snapshots, stale branch snapshot, compact event with no in-memory state. |
| Symlink/security boundary | Discovery never follows a `.agents/skills` and `.claude/skills` symlink or `SKILL.md` symlink to a path outside `cwd`. | Real temp filesystem with symlinks; scanner canonicalizes and enforces cwd prefix. | Symlinked `.agents/skills` and `.claude/skills` to `/tmp/outside`; symlinked `SKILL.md` outside cwd. |

## Definition of done

The real extension code path has executed green against the seams above. Mock-only green is not done. The test suite must run with real temp files/directories and Pi's real skill metadata loader where possible, with injected faults for malformed skills, duplicate names, outside-cwd paths, and compaction/reload reconstruction.

## Implementation plan

1. Create `packages/dynamic-skills` package skeleton.
2. Implement pure scanner module:
   - path resolution and cwd containment
   - upward `.agents/skills` and `.claude/skills` root discovery
   - metadata loading via Pi `loadSkillsFromDir`
   - collision filtering
3. Implement state module:
   - in-memory map
   - snapshot serialization/deserialization
   - branch rehydration from custom entries
4. Implement Pi extension:
   - `session_start` rehydrate
   - `tool_result` discover + patch read result + append snapshot
   - `before_agent_start` append dynamic catalog
   - `session_compact` append snapshot
5. Add tests for the invariants table.
6. Wire package scripts into root workspace if needed:
   - `npm run check --workspace @bravo/dynamic-skills`
   - optional `npm test --workspace @bravo/dynamic-skills`

## Non-goals for v1

- Native Pi `/skill:name` registration for dynamic skills.
- Runtime resource-loader mutation or automatic `/reload`.
- Scanning all subdirectories at startup.
- Discovering skills from `bash`, `grep`, `ranked_search`, or arbitrary command output.
- Loading full skill bodies into context.
- Cross-cwd/global skill discovery beyond the session cwd subtree.

## Possible v2

- Add optional `/dynamic-skills reload-native` command that queues a reload and returns discovered roots from `resources_discover` so native `/skill:name` works.
- Add a tiny TUI command `/dynamic-skills` to list discovered skills and collisions.
- Propose a Pi core API: `ctx.extendResources({ skillPaths })` callable from `tool_result`, rebuilding system prompt and skill commands without full reload.
