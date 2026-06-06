# @bravo/dynamic-skills

Pi extension package for dynamic subtree skill discovery.

When a Pi agent reads a file below the session `cwd`, this extension scans upward from that file toward `cwd` for `.agents/skills/*/SKILL.md` directories. Newly discovered skills are surfaced as a compact model-visible catalog containing only `name`, `description`, and absolute `location`; full skill bodies are never injected automatically.

## Behavior

- Trigger: successful `read` tool results whose target path is strictly below the session `cwd`.
- Scope: `.agents/skills` roots on the path from the read target's directory up to `cwd`, inclusive.
- Model visibility:
  - If native skill metadata is available during `tool_result`, accepted discoveries are appended to the current read result.
  - If native skill metadata is not available, discoveries are stored as pending and filtered/rendered during the next `before_agent_start`.
- Persistence: branch-scoped snapshots are stored with `pi.appendEntry("dynamic-skill-discovery", snapshot)` and rehydrated on `session_start` and `session_tree`.
- Compaction: `session_compact` appends a fresh snapshot so dynamic discoveries survive compaction/reload.
- Native Pi skill registry: not mutated in v1. Dynamically discovered skills do not appear in native `/skill:name` autocomplete.

## Safety rules

- Discovery never scans above the real session `cwd`.
- Path containment uses `path.relative` after `realpath`, avoiding sibling-prefix mistakes such as `/repo` vs `/repo-other`.
- Scanner rejects symlinked `.agents`, `.agents/skills`, skill directories, and `SKILL.md` files before calling Pi's skill loader.
- Native skills win on path/name collisions; duplicate dynamic names keep the first discovered path.
- Rendering is bounded (`MAX_DESCRIPTION_CHARS = 500`, `MAX_RENDERED_SKILLS = 30`) and XML-escaped.

## Install

Project-local install from this monorepo:

```bash
pi install -l ./packages/dynamic-skills
```

This writes `.pi/settings.json` with:

```json
{
  "packages": ["../packages/dynamic-skills"]
}
```

Reload a live Pi session with `/reload`, or start a new Pi session from the repo.

## Validation

```bash
npm run check --workspace @bravo/dynamic-skills
npm test --workspace @bravo/dynamic-skills
```

The tests use real temporary filesystem trees and Pi's real skill loader. They cover read-trigger discovery, symlink rejection, native/dynamic collision handling, branch snapshot rehydration, prompt/result patching, malformed snapshots, and bounded rendering.

## Design docs

- `docs/specs/pi-dynamic-skill-discovery/design.md`
- `docs/specs/pi-dynamic-skill-discovery/implementation-plan.md`
