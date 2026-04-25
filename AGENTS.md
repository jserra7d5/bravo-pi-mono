# Personal Plugins Monorepo Instructions

This repository contains personal agent tooling, pi packages, extensions, roles, skills, and related specifications. Keep it practical: specs capture durable design decisions, packages contain the runnable implementations.

## Repository Layout

- `packages/` contains independently versioned/packaged tools and pi packages.
- `packages/tango/` contains the Tango CLI, runtime, roles, prompt includes, skills, and Pi extension wrapper.
- `packages/loom/` contains the Loom CLI for durable recursive work graphs, context, inboxes, and Tango-compatible coordination.
- `packages/caveman/` contains the Pi extension for session-scoped terse response mode (`/caveman`, `/normal`).
- `docs/specs/` contains design specs. Each spec should live under a slug directory, e.g. `docs/specs/tango-v1/design.md`.
- Package-specific source, docs, roles, includes, and extensions should live inside the relevant package directory.

## Development Guidelines

- Keep reusable design decisions in specs before implementing larger changes.
- Prefer CLI-first tools that can be used by humans and agents.
- Pi integrations should be thin adapters over reusable CLIs, not the only implementation surface.
- Do not modify upstream pi source for package/extension work; use pi runtime extension/package mechanisms.
- Treat project-local executable extension code as trusted-code only.
- Keep prompts, roles, and package instructions concise and composable; avoid duplicating detailed orchestration docs here.

## Common Commands

- `npm run build` — build all workspaces with build scripts.
- `npm run check` — type-check all workspaces with check scripts.
- `npm run build --workspace @bravo/tango` — rebuild Tango after source or extension changes.
- `npm run build --workspace @bravo/loom` — rebuild Loom after source changes.
- `npm run check --workspace @bravo/caveman` — type-check the Caveman Pi extension.
- `npm test --workspace @bravo/loom` — run Loom's vertical-slice tests.
- `tango roles list` — inspect available Tango roles when the CLI is on PATH.
- `loom agent guide` — print the compact runtime-agnostic Loom guide for agents.
