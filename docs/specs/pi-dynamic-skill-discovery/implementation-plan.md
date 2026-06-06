# Pi Dynamic Skill Discovery Implementation Plan

## Summary

Implement `@bravo/dynamic-skills` as a no-core-mod Pi extension that listens for successful `read` tool results below the session `cwd`, discovers eligible `.agents/skills/*/SKILL.md` files along the touched subtree path, appends a compact skill catalog to the current read result, persists branch-scoped discovery snapshots, and reinjects the compact catalog on future turns. Keep the implementation clean and direct: no native Pi registry mutation, no `/skill:name` dynamic autocomplete in v1, no startup full-tree scan, and no discovery from tools other than `read`.

The package should follow existing Pi package patterns in this repo: a workspace package under `packages/`, `type: module`, `pi.extensions = ["./extensions/pi"]`, TypeScript source under `src/`, extension adapter under `extensions/pi/index.ts`, and `node:test` tests against built `dist` files, similar to `@bravo/source-search` and `@bravo/showcase`.

## Objective

Give Pi sessions Codex-like repo skill awareness when an agent reads into deeper project subtrees while preserving Pi core boundaries. The model-visible contract is a compact `<available_skills source="dynamic-subtree-read">` catalog, not automatic loading of full skill bodies or runtime mutation of Pi's native skill registry.

## Recommended Direction

Build three reusable modules plus a thin Pi extension adapter:

1. `src/scanner.ts` — safe path resolution, cwd containment, upward `.agents/skills` root discovery, skill metadata loading, and security checks.
2. `src/state.ts` — branch-scoped in-memory state, collision diagnostics, snapshot serialization/deserialization, and custom entry rehydration.
3. `src/render.ts` — XML/catalog rendering, description bounding/sanitization, and prompt section appending.
4. `extensions/pi/index.ts` — Pi event wiring for `session_start`, `session_tree`, `tool_result`, `before_agent_start`, and `session_compact`.

Use Pi's real skill metadata loader if it is exported and usable from `@earendil-works/pi-coding-agent` or another official Pi package surface. If the loader is not exported, stop and make that an explicit implementation decision rather than silently inventing incompatible metadata semantics.

## Tradeoffs

- **No core mutation:** avoids relying on unstable Pi internals, but dynamic skills will not appear in native `/skill:name` autocomplete/expansion in v1.
- **Read-only trigger:** aligns with a faithful file-read contract and avoids parsing shell/search output, but skills are only discovered after a direct `read` into the subtree.
- **Branch-scoped snapshots:** supports compaction/reload/fork behavior, but requires careful rehydration from the current branch rather than full session history.
- **Compact catalogs only:** keeps context bounded and prevents accidental full skill injection, but the model must `read` the skill file when the description matches.

## Review resolution

This revision addresses accepted reviewer feedback by:

- Requiring native collision checks before any `tool_result` preview, with accepted-vs-candidate separation when native skills are not available on `tool_result`.
- Defining an exact `path.relative` containment helper and tests for sibling-prefix escapes.
- Making symlink-safe `lstat` traversal mandatory before calling Pi `loadSkillsFromDir` only on safe individual skill directories.
- Pinning prompt/catalog markers, replacement behavior, diagnostics limits, branch-current session-tree rehydration, event return shape, `DynamicSkill.baseDir`, and rendering constants.

## Plan

1. **Confirm Pi extension/event interfaces**
   - Inspect current Pi package surfaces and existing repo extensions for event return shapes.
   - Verify exact `tool_result` event fields for tool name, input path, error flag, and returnable result content. The handler must return `{ content: patchedContent }` when patching; do not rely on in-place event mutation.
   - Verify whether native skills are available during `tool_result`. If not, separate candidate discoveries from accepted discoveries and delay model-visible preview until native filtering can be performed; never emit an unfiltered preview.
   - Verify `before_agent_start` shape and whether native skills are available at `event.systemPromptOptions.skills` with name/path fields.
   - Verify how `ctx.sessionManager.getBranch()` exposes custom entries appended with `pi.appendEntry`.
   - Decision gate: if any required event surface is unavailable, document the missing seam before coding.

2. **Create package skeleton**
   - Add `packages/dynamic-skills/package.json` with:
     - name `@bravo/dynamic-skills`
     - `private: true`, `type: module`, Node `>=22.13`
     - scripts: `check`, `build`, `test`
     - peer dependencies matching Pi extension packages: `@earendil-works/pi-coding-agent`, and any package that owns the real skill loader.
     - `pi.extensions = ["./extensions/pi"]`
   - Add `tsconfig.json` following sibling package conventions.
   - Add `src/`, `extensions/pi/`, and `test/` directories.
   - Root workspace already includes `packages/*`, so no root workspace change should be needed.

3. **Define durable data types**
   - Implement/export:
     ```ts
     type DynamicSkill = {
       name: string;
       description: string;
       location: string;
       baseDir: string;
       discoveredFrom: string;
       discoveredAt: string;
     };

     type Diagnostic = {
       type: "native-path-duplicate" | "native-name-collision" | "dynamic-name-collision" | "invalid-skill" | "security-boundary";
       name?: string;
       location?: string;
       message: string;
       at: string;
     };

     type DynamicSkillSnapshot = {
       version: 1;
       skills: DynamicSkill[];
       diagnostics: Diagnostic[];
     };
     ```
   - Keep `location` as the absolute `SKILL.md` path. Define `baseDir` as `dirname(location)`, the individual skill directory. If the `.agents/skills` root is needed for loader grouping or diagnostics, add a separate `skillsRoot` field instead of overloading `baseDir`.
   - Treat unknown snapshot versions as ignored with a diagnostic rather than throwing during session start.

4. **Implement path and filesystem safety primitives**
   - Resolve `event.input.path` against `ctx.cwd`.
   - Use a single containment helper after canonicalization:
     ```ts
     function isContained(parent: string, child: string): boolean {
       const rel = path.relative(parent, child);
       return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
     }
     ```
     Use a companion `isContainedOrEqual` only where inclusive behavior is explicitly required. Tests must include sibling-prefix paths such as `/repo` vs `/repo-other` and `/repo/sub` vs `/repo/submarine`.
   - Canonicalize `ctx.cwd` and target using `realpath`.
   - Trigger only when the real target is strictly below real `cwd` using `isContained`.
   - If target is a file, start from its real parent; if directory, start at the directory.
   - Walk upward from target directory to `cwd`, inclusive; never above.
   - Before invoking Pi metadata loading, traverse candidates with `lstat`: `.agents`, `.agents/skills`, each child skill directory, and each `SKILL.md` must be ordinary directories/files as appropriate, not symlinks. Reject and diagnose symlinked roots, skill directories, or `SKILL.md` files.
   - For every `.agents/skills` candidate, individual skill directory, and `SKILL.md`, canonicalize and enforce containment under real `cwd`.
   - Do not follow symlink escapes; record security diagnostics for rejected symlinked roots/files.
   - Handle missing paths, malformed paths, permission errors, and non-file/non-directory targets as no-discovery plus diagnostics where useful.

5. **Implement skill metadata loading**
   - Prefer Pi's exported `loadSkillsFromDir` over a custom parser.
   - After symlink-safe `lstat` traversal, call `loadSkillsFromDir` only on safe individual skill directories, not on an unfiltered `.agents/skills` root that may contain unsafe entries.
   - Include only skill directories containing an eligible `SKILL.md` with non-empty name and description.
   - Exclude `disable-model-invocation: true` skills from model-visible catalogs.
   - Normalize names and paths exactly enough to support collision checks without creating aliases.
   - Bound descriptions for catalog injection with `MAX_DESCRIPTION_CHARS = 500`; preserve full description in state only if safe and reasonably bounded.

6. **Implement collision filtering**
   - Maintain separate candidate and accepted sets. A candidate must not be rendered in `tool_result` or persisted as accepted until it has passed native and dynamic collision filtering.
   - Native Pi skills win:
     - skip dynamic paths already present in `event.systemPromptOptions.skills`.
     - skip dynamic skill names matching a native skill at a different path.
   - If native skills are not available during `tool_result`, store candidates as pending or defer discovery finalization until `before_agent_start` can filter them; do not append any unfiltered tool-result preview.
   - Existing dynamic skills win:
     - if a new dynamic skill has a duplicate name at a different path, keep the first discovered path and record a diagnostic.
     - if it is the same path, do not duplicate or update `discoveredAt`.
   - Do not invent renamed aliases.
   - Keep diagnostics branch-scoped and snapshot them with state. Bound diagnostics to the most recent 100 entries (`MAX_DIAGNOSTICS = 100`) by dropping oldest entries after append.

7. **Implement state management**
   - Maintain an in-memory `Map<string, DynamicSkill>` keyed by canonical `location` and a name index for duplicate detection.
   - `session_start`: clear in-memory state and rehydrate from the latest valid `dynamic-skill-discovery` custom entry on the current branch returned by `ctx.sessionManager.getBranch()`. Do not scan global session history or sibling branches.
   - `session_tree`: clear in-memory state and rehydrate from the current branch returned by `ctx.sessionManager.getBranch()`, matching `session_start`, so branch navigation cannot bleed dynamic skills across branches.
   - If multiple snapshots exist, choose the latest branch snapshot by current branch order, not wall-clock timestamp.
   - `tool_result`: after new discoveries/collisions are processed, append a fresh snapshot with `pi.appendEntry("dynamic-skill-discovery", snapshot)` when state or diagnostics changed.
   - `session_compact`: append a fresh snapshot if in-memory state or diagnostics are non-empty.
   - Avoid global cross-session bleed: state must be per Pi extension instance/session cwd; clear/rebuild on `session_start` and `session_tree`.

8. **Implement catalog rendering**
   - Render exactly one compact XML block per injection site:
     ```xml
     <available_skills source="dynamic-subtree-read">
       <skill>
         <name>...</name>
         <description>...</description>
         <location>...</location>
       </skill>
     </available_skills>
     ```
   - XML-escape names, descriptions, and locations.
   - Never include full skill bodies.
   - Pin bounds: `MAX_DESCRIPTION_CHARS = 500` and `MAX_RENDERED_SKILLS = 30`. Truncate descriptions beyond the limit and include an explicit omitted-count note when more than 30 skills are available.
   - Keep ordering deterministic by first discovery order.

9. **Implement `tool_result` behavior**
   - Listen to `pi.on("tool_result", ...)`.
   - Trigger only when:
     - `event.toolName === "read"`
     - `event.isError !== true`
     - `event.input.path` is a string
     - resolved real target is strictly below `ctx.cwd`
   - Discover eligible skills along the upward path.
   - If newly accepted skills exist, create `patchedContent` and return `{ content: patchedContent }` from the handler. Do not mutate the event/result object in place. Patch returned read result text by appending:
     - `Discovered N additional repo skills for this subtree. Use read on a skill location when its description matches the task.`
     - the compact XML catalog for only the newly discovered skills, unless the design is revised to include all branch-discovered skills.
   - If no newly accepted skills exist, return no patch and leave result content unchanged.
   - If result content has multiple text parts or non-text parts, append a new text part rather than mutating binary/structured parts.

10. **Implement `before_agent_start` behavior**
    - Listen to `pi.on("before_agent_start", ...)`.
    - Filter in-memory dynamic skills against native skills from `event.systemPromptOptions.skills` on every turn.
    - If no eligible dynamic skills remain after filtering, return no prompt change.
    - Append an idempotent section to `event.systemPrompt` between exact markers:
      `<!-- dynamic-skill-discovery:begin -->` and `<!-- dynamic-skill-discovery:end -->`. If an existing marked section is present, replace the full marked range with the newly rendered section instead of appending a duplicate.
      ```md
      ## Dynamically discovered repo skills

      These skills were discovered after reading files below the session cwd. Use `read` to load a skill file when the task matches its description.

      <available_skills source="dynamic-subtree-read">
      ...
      </available_skills>
      ```
    - Ensure repeated `before_agent_start` calls do not duplicate this section if Pi passes an already-augmented prompt.

11. **Optional quiet UX notification**
    - If `ctx.hasUI` and `ctx.ui.notify` are available, emit a single quiet notification when one or more skills are first discovered.
    - Do not add widgets, footer status, or commands in v1.
    - Never make notification delivery part of correctness.

12. **Testing implementation against faithful seams**
    - Build an extension harness that registers real handlers from `extensions/pi/index.ts`, stores handlers in a `Map`, captures `appendEntry` calls, and supplies Pi-shaped context objects.
    - Use real temp directories/files for every scanner and event test.
    - Use the real Pi skill metadata loader where possible; tests using a fake parser are not sufficient for done.
    - Add tests under `packages/dynamic-skills/test/*.test.ts`, compiled and run via `npm test --workspace @bravo/dynamic-skills`.

## Runtime Invariants, Faithful Verification Seams, and Injected Faults

| Boundary | Runtime invariant | Faithful verification seam | Injected faults |
|---|---|---|---|
| `read` tool-result trigger | Only successful `read` results with a string path strictly below `cwd` can discover skills. Same-cwd, outside-cwd, errored, and non-read events record nothing. | Invoke the real extension `tool_result` handler with Pi-shaped events and real temp filesystem paths. | Malformed relative path, absolute outside path, same-cwd path, `isError: true`, `grep`/`bash` event, repeated read. |
| Path traversal and symlinks | Discovery never scans above real `cwd` and never accepts `.agents/skills` or `SKILL.md` symlink escapes outside real `cwd`. | Scanner tests using `mkdtemp`, real directories, real symlinks, and `realpath`. | Symlinked `.agents/skills` to outside temp dir, symlinked `SKILL.md` outside cwd, path containing `..`, missing target. |
| Upward scope | A deeper read discovers skills from `.agents/skills` roots on the path from target directory up to `cwd`, inclusive, and not from sibling subtrees. | Scanner test with multiple nested directories and sibling skill roots. | Skills in sibling directory, root at cwd, nested root nearer target, duplicate root encountered. |
| Skill metadata semantics | Catalog entries match Pi skill semantics for name, description, location, and `disable-model-invocation`; missing/invalid/disabled skills are excluded. | Call Pi's real exported skill loader against temp `.agents/skills` directories. | Missing description, invalid YAML/frontmatter, disabled model invocation, non-directory entry, unreadable `SKILL.md`. |
| Collision policy | Native skills win; duplicate dynamic names keep first discovered path; no aliases are created. | `before_agent_start` and `tool_result` harness with Pi-shaped native `systemPromptOptions.skills`. | Native same path, native same name different path, two dynamic same names, collision-only discovery. |
| Tool-result preview | Only native-filtered accepted skills append one sentence plus compact XML to the read result; if native skills are unavailable at `tool_result`, no unfiltered preview is emitted. No new skills leave content unchanged; full skill bodies never appear. | Real `tool_result` handler output inspection. | Duplicate discovery, no discovery, native skills absent, non-text result part, long description/body containing XML-sensitive chars. |
| Future prompt injection | Every future turn includes eligible dynamic skills exactly once, excludes current native duplicates, and is idempotent. | Real `before_agent_start` handler with prompts and native skills fixtures. | Already-augmented system prompt, native collision introduced after discovery, empty state, many skills. |
| Persistence, branch navigation, and compaction | Branch state rehydrates from the latest current-branch snapshot and is reinjected after reload, branch navigation, or compaction without bleeding skills from sibling branches. | Session-manager-shaped branch fixture plus real `session_start`/`session_tree`/`session_compact` handler calls and captured `appendEntry`. | Multiple snapshots, stale older snapshot, unknown version, compact with no state, reload after collision diagnostics, two branches with different snapshots followed by `session_tree`. |
| Context bounds | Catalog rendering is bounded, XML-escaped, deterministic, and body-free. | Unit tests for `render.ts` and integration tests for prompt/result injection. | Huge description, control characters, `<>&"'`, many skills, skill body containing sentinel text. |

## Files / Areas Likely to Change

- `packages/dynamic-skills/package.json`
- `packages/dynamic-skills/tsconfig.json`
- `packages/dynamic-skills/extensions/pi/index.ts`
- `packages/dynamic-skills/src/scanner.ts`
- `packages/dynamic-skills/src/state.ts`
- `packages/dynamic-skills/src/render.ts`
- `packages/dynamic-skills/src/types.ts`
- `packages/dynamic-skills/test/*.test.ts`
- Possibly `packages/dynamic-skills/README.md` if package usage notes are desired.

Root `package.json` should not need workspace edits because `packages/*` is already included.

## Validation

Run with explicit fail-fast timeouts from the repo root:

1. `timeout 120 npm run check --workspace @bravo/dynamic-skills`
2. `timeout 180 npm test --workspace @bravo/dynamic-skills`
3. `timeout 300 npm run check --workspaces --if-present` if the package introduces shared type or workspace concerns.
4. Optional manual smoke in a temp repo:
   - create `sub/.agents/skills/example/SKILL.md`
   - start Pi from the parent cwd with the package installed/enabled
   - `read sub/file.txt`
   - confirm the read result includes the discovery sentence and compact XML
   - continue one turn or compact/reload and confirm the future system prompt receives the dynamic catalog.

## Definition of Done

- `@bravo/dynamic-skills` builds and type-checks.
- The real extension handlers execute green against the runtime invariants above.
- Tests use real temp files/directories and the real Pi skill metadata loader where available.
- Injected fault tests cover malformed paths, outside-cwd paths, symlink escapes, invalid skills, disabled skills, duplicate names, native collisions, duplicate discoveries, and compaction/reload reconstruction.
- Dynamic catalogs are compact, XML-escaped, idempotent, deterministic, branch-scoped, and never include full skill bodies.
- No Pi core files are modified.
- No v1 behavior claims native `/skill:name` autocomplete/expansion for dynamically discovered skills.

## Risks / Unknowns

- **Pi skill loader export:** The design requires using Pi's real `loadSkillsFromDir`; implementation must verify the exported API name/location. If unavailable, decide whether to request a Pi API seam or implement a parser with an explicit compatibility risk.
- **`tool_result` patch shape:** The exact event return contract for modifying read results must be confirmed. If Pi does not allow result patching from `tool_result`, the implementation needs a different model-visible seam or must be blocked.
- **Branch custom entries shape:** Rehydration depends on `ctx.sessionManager.getBranch()` exposing extension entries clearly enough to select the latest `dynamic-skill-discovery` snapshot.
- **Native skills shape:** Collision filtering depends on stable name/path fields in `event.systemPromptOptions.skills`.
- **Description bounds:** Use pinned limits `MAX_DESCRIPTION_CHARS = 500` and `MAX_RENDERED_SKILLS = 30`; future changes should be deliberate compatibility decisions.
- **Base directory meaning:** `DynamicSkill.baseDir` is pinned to `dirname(location)` (the individual skill directory). Add `skillsRoot` separately if implementation needs the containing `.agents/skills` root.
- **Security compatibility:** Strict realpath containment may skip legitimate symlinked in-repo skill setups. This is acceptable for v1 unless live users require symlinked skill roots.
