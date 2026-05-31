# Personal Plugins Monorepo Instructions

This repository contains personal agent tooling, pi packages, extensions, roles, skills, and related specifications. Keep it practical: specs capture durable design decisions, packages contain the runnable implementations.

## Repository Layout

- `packages/` contains independently versioned/packaged tools and pi packages.
- `packages/tango/` contains the Tango CLI, runtime, roles, prompt includes, skills, and Pi extension wrapper. Tango includes harnesses for Pi, Claude Code, Gemini CLI, and generic shell agents.
- `packages/loom/` contains the Loom CLI for durable recursive work graphs, context, inboxes, and Tango-compatible coordination.
- `packages/async-subagents/` contains the Pi-only async subagent primitive: markdown agent definitions, durable run files, parent Pi tools, child-control extension, and terminal status/wake-up UI.
- `packages/bravo-goals/` contains the Bravo Goals CLI and Pi extension for workspace-level `.bravo/` goal workspaces, task receipts, phase boundaries, terminal HUD status, and Judge run contracts.
- `packages/caveman/` contains the Pi extension for session-scoped terse response mode (`/caveman`, `/normal`).
- `packages/tui-enhancements/` contains the Pi extension for Tab-triggered inline slash completion, multi-skill inline `/skill:name` expansion, and terminal link helpers (`/links`, `/copy-link`).
- `packages/showcase/` contains the Pi extension package that registers the `showcase` tool for inline TUI rendering of requested file slices.
- `packages/web-evidence-cache/` contains the Pi extension package for Brave-backed web discovery, temporary local web evidence artifacts, and SQLite FTS5 lookup; read `packages/web-evidence-cache/README.md` before changing web search, fetch safety, extraction, artifact, or lookup behavior.
- `packages/source-search/` contains the Pi extension package for Tantivy-backed `ranked_search`, the `source-search` CLI/sidecar, and the source-search skill; read `packages/source-search/README.md` and `docs/specs/source-search-v1/design.md` before changing indexing, corpus selection, workspace registry, or ranked-search behavior.
- `packages/gemini-code-assist/` contains the direct Antigravity Code Assist Pi provider for `antigravity-code-assist/gemini-3.5-flash`; read `packages/gemini-code-assist/README.md` before changing OAuth, model ids, reasoning controls, or provider behavior.
- `docs/specs/` contains design specs. Each spec should live under a slug directory, e.g. `docs/specs/tango-v1/design.md`.
- Package-specific source, docs, roles, includes, and extensions should live inside the relevant package directory.

## Development Guidelines

- Keep reusable design decisions in specs before implementing larger changes.
- Prefer CLI-first tools that can be used by humans and agents.
- Pi integrations should be thin adapters over reusable CLIs, not the only implementation surface.
- For Pi integration/extension API reference, consult `/home/joe/Documents/misc/pi-mono` and `/home/joe/Documents/misc/pi-mono/AGENTS.md`.
- Do not modify upstream pi source for package/extension work; use pi runtime extension/package mechanisms.
- Async subagents are intentionally Pi-only and async-first in v1. Keep parent-child messaging, wait/result semantics, prompt isolation, and durable run files simple; do not reintroduce Tango-style chains, DAGs, peer intercom, worktree orchestration, or cross-harness adapters.
- Async subagent built-ins should use fully-qualified `openai-codex/...` model ids so child Pi processes use Codex OAuth and do not drift to another provider.
- Treat project-local executable extension code as trusted-code only.
- Project-local Pi footer/model-speed customizations live in `.pi/extensions/codex-usage.ts`; see `.pi/extensions/README.md`. Use `/fast on|off|status` in interactive Pi sessions to persist fast mode for this project. Fast mode is intentionally UI-scoped so async/noninteractive child Pi launches do not inherit it by default.
- Keep prompts, roles, and package instructions concise and composable; avoid duplicating detailed orchestration docs here.

## Common Commands

- `npm run build` — build all workspaces with build scripts.
- `npm run check` — type-check all workspaces with check scripts.
- `npm run build --workspace @bravo/tango` — rebuild Tango after source or extension changes.
- `npm run build --workspace @bravo/loom` — rebuild Loom after source changes.
- `npm run check --workspace @bravo/goals` — type-check the Bravo Goals package.
- `npm test --workspace @bravo/goals` — build and run Bravo Goals contract tests.
- `npm run check --workspace @bravo/async-subagents` — type-check the async subagents package.
- `npm test --workspace @bravo/async-subagents` — build and run async subagents tests.
- `npm run check --workspace @bravo/caveman` — type-check the Caveman Pi extension.
- `npm run check --workspace @bravo/tui-enhancements` — type-check the TUI Enhancements Pi extension.
- `npm run check --workspace @bravo/gemini-code-assist` — type-check the Gemini/Antigravity Code Assist provider.
- `npm test --workspace @bravo/gemini-code-assist` — build and run Gemini/Antigravity Code Assist tests.
- `npm run check --workspace @bravo/web-evidence-cache` — type-check the Web Evidence Cache Pi extension.
- `npm test --workspace @bravo/web-evidence-cache` — build and run Web Evidence Cache tests.
- `npm run check --workspace @bravo/source-search` — type-check the Source Search Pi extension.
- `npm test --workspace @bravo/source-search` — build and run Source Search tests.
- `npm run antigravity:proof --workspace @bravo/gemini-code-assist -- --mode sweep` — live-proof the direct Antigravity provider and thinking controls.
- `npm test --workspace @bravo/loom` — run Loom's vertical-slice tests.
- `tango roles list` — inspect available Tango roles when the CLI is on PATH.
- Gemini Tango roles use only `gemini-3.1-pro-preview` or `gemini-3-flash-preview`; see `packages/tango/docs/gemini-harness.md` and `docs/specs/tango-gemini-cli-runtime/design.md`.
- `loom agent guide` — print the compact runtime-agnostic Loom guide for agents.
