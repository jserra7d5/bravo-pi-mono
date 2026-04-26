# bravo-pi-mono

Personal pi/agent tooling monorepo.

## Packages

- `packages/tango` — CLI-first native/tmux agent orchestrator with Pi, Claude Code, and generic harnesses.
- `packages/loom` — CLI-first durable recursive work graph for research, design, planning, decisions, inboxes, and Tango-compatible agent coordination.
- `packages/caveman` — Pi extension for session-scoped terse response mode.

## Tango quick start

```bash
cd /home/joe/Documents/projects/bravo-pi-mono
npm install
npm run build

# Optional: make `tango` available on PATH for humans and recursive agents.
cd packages/tango
npm link

# Optional: install the pi package integrations by local path.
pi install /home/joe/Documents/projects/bravo-pi-mono/packages/tango
pi install /home/joe/Documents/projects/bravo-pi-mono/packages/loom
pi install /home/joe/Documents/projects/bravo-pi-mono/packages/caveman
```

Basic commands:

```bash
tango roles list
tango start repo-scout --role scout "Summarize this repo"
tango start cc-scout --role claude-scout --model haiku --effort low "Summarize this repo"
tango list
tango look repo-scout
tango result repo-scout
```

## Loom quick start

```bash
npm run build --workspace @bravo/loom
npm test --workspace @bravo/loom

# If linked/installed on PATH:
loom agent guide
loom init --name feature-x --title "Feature X"
loom create "Top-level proposal" --kind proposal
loom tree
```

Loom's Pi package exposes root-session prompt templates such as `/loom.plan`, `/loom.analyze`, and `/loom.ready`, plus agent skills such as `loom-plan`, `loom-analyze`, and `loom-ready`. Tango roles can explicitly opt into these skills; Tango resolves them from installed Pi packages and passes/copies them into Pi and Claude Code child agents.

Design/spec docs:

- `docs/specs/tango-v1/design.md` / `plan.md` — v1.0 baseline
- `docs/specs/tango-v1/design-v1.1.md` / `plan-v1.1.md` — tool-first Pi UX and CLI-first core follow-up
- `docs/specs/loom-v1/` — Loom v1 durable graph design, contracts, operations, testing, and implementation plan
- `docs/specs/loom-agent-workflows/design.md` / `plan.md` — Loom prompt templates, skills, Tango role integration, worktree conventions, and root delegation guidance
