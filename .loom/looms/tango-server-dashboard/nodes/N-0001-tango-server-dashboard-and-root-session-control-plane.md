---
id: N-0001
title: Tango server dashboard and root-session control plane
kind: proposal
state: open
parent: null
summary: Tango server dashboard and root-session control plane
tags: []
created_at: "2026-04-27T00:41:07.713Z"
updated_at: "2026-04-27T00:54:30.106Z"
edges:
  - type: decomposes_to
    to: N-0008
  - type: decomposes_to
    to: N-0009
  - type: decomposes_to
    to: N-0010
  - type: decomposes_to
    to: N-0011
  - type: decomposes_to
    to: N-0012
  - type: decomposes_to
    to: N-0013
  - type: decomposes_to
    to: N-0014
  - type: decomposes_to
    to: N-0015
  - type: decomposes_to
    to: N-0016
references:
  - workspace: undefined
    path: docs/specs/tango-daemon-loom-dashboard/design.md
    label: Design spec
    kind: source
  - workspace: undefined
    path: docs/specs/tango-daemon-loom-dashboard/plan.md
    label: Implementation plan
    kind: source
  - workspace: undefined
    path: packages/tango/src/server.ts
    label: Prototype server/control plane
    kind: source
  - workspace: undefined
    path: packages/tango/src/cli.ts
    label: Tango CLI dispatch
    kind: source
  - workspace: undefined
    path: packages/tango/src/types.ts
    label: Tango shared types
    kind: source
  - workspace: undefined
    path: packages/tango/src/events.ts
    label: Tango events
    kind: source
---




















# Summary

Tango server dashboard and root-session control plane

# Context


# Analysis


# Result

Pending.


# Note 2026-04-27T00:41:25.855Z

## Goal

Design and implement Tango's next control-plane/server architecture as a host-native local server plus dashboard, while preserving host-native agent execution and file-backed durability.

The core product goal is to make live recursive orchestration understandable and controllable: root sessions/workstreams are first-class containers, every child agent rolls up under its root, messages/status/artifacts route by explicit lineage rather than cwd guesses, and the dashboard presents current work instead of dumping historical runs.

## Scope

### In scope

- Host-native `tango server` process.
- HTTP `/api/v1/...` APIs and SSE server-to-client event stream.
- Explicit server discovery via `$TANGO_HOME/server/server.json` plus `TANGO_SERVER_URL` / `TANGO_SERVER_TOKEN` overrides.
- First-class root sessions/workstreams:
  - `rootSessionId`;
  - `workstreamId`;
  - `runId`;
  - `parentRunId` / `parentRunDir`.
- Lineage-aware command resolution so a lead can target its children without `cd` into the child cwd.
- Status/message routing by explicit run/root identity, not broad cwd/event matching.
- Registered artifact hosting only; no arbitrary filesystem serving.
- Tokenized artifact/dashboard URLs, localhost bind by default, Tailnet/private bind opt-in.
- React + Vite dashboard with root-session/workstream as the primary UX unit.
- Dashboard routes:
  - `/` root session/workstream picker;
  - `/sessions/:rootSessionId` overview;
  - `/sessions/:rootSessionId/agents`;
  - `/sessions/:rootSessionId/attention`;
  - `/sessions/:rootSessionId/artifacts`;
  - `/sessions/:rootSessionId/timeline`;
  - `/global/attention`;
  - `/global/history`.
- Loom integration through generic refs/events/artifacts/messages only.

### Out of scope for v1

- Running agents inside Docker.
- Docker-first server deployment.
- Separate persistent host runner.
- WebSockets unless SSE is insufficient.
- Automatic `tango start` server auto-start.
- Full Loom graph visualization.
- Automatic Loom writes by default.
- Multi-user auth or public internet exposure.
- Replacing Loom's file-based durable graph.

## Constraints and decisions already made

- Agents remain host-native on the user's machine: Pi, Claude Code, tmux, shell, credentials, PATH, and cwd behavior remain local.
- Server/dashboard may later be Docker-compatible, but v1 is host-native Node.
- Durable Tango state remains file-backed and recoverable; server v1 uses JSON/JSONL snapshots/journals, not SQLite.
- The active workspace has live agents; implementation work should stay in a separate git worktree and avoid rebuilding/relinking the active main package until explicitly testing rollout.
- Dashboard should not default to a flat historical agent list. Historical/legacy agents without root metadata belong in opt-in history/legacy buckets.
- Root session is a project-like workspace container. It owns all child agents, attention items, messages, artifacts, timeline events, and future Loom refs under it.
- Tango must not import `@bravo/loom`, parse `.loom` internals, or encode Loom-specific workflow rules.

## Current prototype status

A worktree exists at:

```text
/home/joe/Documents/projects/bravo-pi-mono-tango-server
```

Branch:

```text
tango-server-dashboard
```

Prototype implemented there:

- `packages/tango/src/server.ts` host-native HTTP/SSE server;
- `tango server` command;
- discovery file;
- root session create/list API;
- artifact publish/list/revoke and registered artifact hosting;
- lineage fields on agent metadata and events;
- env propagation for `TANGO_RUN_ID`, `TANGO_ROOT_SESSION_ID`, `TANGO_WORKSTREAM_ID`;
- copyable attach/look/result commands in API;
- temporary inline dashboard smoke-test UI.

The temporary dashboard works but is intentionally not product-quality: it still feels like a messy metadata dump and should be replaced by view-model APIs plus React/Vite.

## High-priority problem to solve next

Current Tango UX requires commands like `tango attach child` to be run from the child/project cwd because resolution is cwd/projectSlug-first. This is wrong for recursive orchestration: a lead that spawned a child should be able to target that child by lineage regardless of shell cwd.

Required behavior:

```text
Inside a Tango lead/root session:
1. Resolve direct children of current run.
2. Resolve descendants under current rootSessionId/workstreamId.
3. Fall back to cwd/project agents.
4. Fall back to globally unique name.
5. If ambiguous, present choices with cwd/status/role/runDir.
```

Apply the resolver to:

- `attach`;
- `look`;
- `result`;
- `message`;
- `stop`;
- `delete`;
- `children`;
- `wait`.

Status delivery should similarly route by explicit lineage:

- direct parent notifications by `parentRunId == currentRunId`;
- root-session dashboard/attention by `rootSessionId == currentRootSessionId`;
- no broad replay or cwd-only matching.

## Assumptions

- Root Pi sessions can register or resume a root session when the Pi extension starts.
- CLI-started work may attach to an existing/default root session when available, but v1 should not surprise-start the server.
- Existing old metadata may lack `runId`/`rootSessionId`; dashboard and resolvers must tolerate this and classify such runs as legacy/history unless active and uniquely identifiable.
- React + Vite dependency footprint is acceptable for a product dashboard.
- SSE plus REST reloads are sufficient for v1 dashboard updates.

## Open questions

- Exact root session lifecycle: when does a root session become idle, closed, archived, or resumed?
- How should CLI commands select a root session when multiple active roots exist in the same cwd?
- Should `tango attach` gain explicit stable forms like `--run-id`, `--run-dir`, or `--root-session`?
- What is the best transition path from current cwd-based lookup to lineage-aware lookup without breaking old workflows?
- Should dashboard auth stay token-query for local dev, or move quickly to local session/cookie once React/Vite lands?
- Should historical retention be capped or archived?
- How much root/session metadata should be written by Pi extension versus server versus CLI?

## Next recommended phase

Plan implementation around three near-term tracks:

1. **Lineage-aware runtime correctness**
   - resolver for agent-targeting commands;
   - explicit run/root identity in events;
   - server/Pi notification filtering by lineage;
   - tests with cross-cwd parent/child agents.

2. **Dashboard view-model APIs**
   - `/api/v1/dashboard`;
   - `/api/v1/workstreams`;
   - `/api/v1/workstreams/:rootSessionId/...`;
   - server-side active/attention/history classification;
   - legacy bucket for old runs.

3. **React + Vite dashboard**
   - root-session switcher as landing page;
   - selected-session overview;
   - agent forest, attention, artifacts, timeline;
   - copy attach/look/result commands;
   - SSE connection state and live refresh.


# Note 2026-04-27T00:43:33.255Z

## Planning update for N-0003 and N-0004

Durable implementation plans were added to:

- `N-0003 Root-session dashboard view-model APIs`: server-owned response contracts, routes, grouping/classification rules, forest construction, artifact/timeline association, tests, rollout risks.
- `N-0004 React/Vite root-session dashboard`: React/Vite app structure, route/component plan, static build integration, token/SSE behavior, tests, rollout risks.

Key sequencing recommendation: implement and freeze N-0003 view-model contracts before building most of N-0004. React should present server-shaped data and should not reconstruct active/attention/history/legacy classification from raw agent metadata.

Important cross-cutting decisions captured in the child notes:

- Root session/workstream remains the primary UX and API grouping key.
- Legacy agents without `rootSessionId` are hidden from current-work defaults and exposed only in explicit history/legacy views.
- Agent forests link by `parentRunId` first and fall back to `parentRunDir` for old runs.
- `server.ts` should not keep accumulating responsibilities; move view-model builders into a separate module and replace inline dashboard HTML with built React static assets.
- API route precedence must stay: `/api/v1/*` and `/a/*` before SPA fallback.
- Keep v1 host-native/file-backed; no Loom-internal parsing or `@bravo/loom` import.

Open design choice for implementers: N-0004 requires timeline/history routes, while N-0003's required route list omits them. Recommended clean path is to add `GET /api/v1/workstreams/:rootSessionId/timeline` and `GET /api/v1/history` now rather than forcing the frontend to infer those views.


# Note 2026-04-27T00:48:24.862Z

## Consistency update applied

Updated Loom after read-only consistency review:

- Added and resolved decision nodes:
  - `N-0008` chosen v1 architecture decisions;
  - `N-0009` root session lifecycle v1;
  - `N-0010` timeline/history API scope.
- Added `N-0011` durable attention and delivery state to prevent duplicate/stale wake-ups and connect direct inspection with notification handling.
- Added review nodes:
  - `N-0012` lineage resolver and notification routing;
  - `N-0013` dashboard API contracts;
  - `N-0014` React dashboard UX/accessibility;
  - `N-0015` artifact hosting security;
  - `N-0016` Loom coupling boundary.
- Added dependency/review links so broad implementation is better sequenced.
- Corrected N-0002 validation commands from pnpm to npm workspace commands.
- Resolved N-0003/N-0004 mismatch by deciding timeline/history APIs are in v1 scope.
- Added source references to design/plan and key Tango prototype files.

Implementation readiness after update:

- `N-0002` remains the recommended first implementation slice.
- `N-0003` can follow once N-0009/N-0010 decisions are accepted as inputs.
- `N-0004` should wait on stable N-0003 contracts.
- Reviews should run before rollout/merge of their corresponding implementation slices.


# Note 2026-04-27T00:54:30.106Z

## Implementation coordination started

Coordinator is starting implementation from the existing prototype worktree instead of creating a new worktree, per prior project decision.

Source repo:
- `/home/joe/Documents/projects/bravo-pi-mono`
- branch `main`
- base commit `d22a091`
- dirty state intentionally contains Loom/spec updates and the Pi watcher fix.

Implementation worktree:
- `/home/joe/Documents/projects/bravo-pi-mono-tango-server`
- branch `tango-server-dashboard`
- base commit `d22a091`
- dirty state contains the existing Tango server/dashboard prototype.

Implementation sequence:
1. `N-0002` lineage-aware command resolution and routing.
2. `N-0012` review of lineage resolver/routing.
3. `N-0011` durable attention and delivery state.
4. Then dashboard/API/UI slices after resolver + attention state are stable.

Validation commands for Tango worktree:

```bash
cd /home/joe/Documents/projects/bravo-pi-mono-tango-server
npm run check --workspace @bravo/tango
npm run build --workspace @bravo/tango
```

Dependency note: the worktree currently relies on normal workspace dependency setup; if validation cannot resolve dependencies, use `npm install` in the worktree or an explicitly temporary dependency symlink, but do not rebuild/relink the active main package for rollout.
