# bravo-pi-mono

Personal pi/agent tooling monorepo.

## Packages

- `packages/tango` — CLI-first native/tmux agent orchestrator with a pi extension wrapper.

## Tango quick start

```bash
cd /home/joe/Documents/projects/bravo-pi-mono
npm install
npm run build

# Optional: make `tango` available on PATH for humans and recursive agents.
cd packages/tango
npm link

# Optional: install the pi package integration by local path.
pi install /home/joe/Documents/projects/bravo-pi-mono/packages/tango
```

Basic commands:

```bash
tango roles list
tango start repo-scout --role scout "Summarize this repo"
tango list
tango look repo-scout
tango result repo-scout
```

Design/spec docs:

- `docs/specs/tango-v1/design.md` / `plan.md` — v1.0 baseline
- `docs/specs/tango-v1/design-v1.1.md` / `plan-v1.1.md` — tool-first Pi UX and CLI-first core follow-up
