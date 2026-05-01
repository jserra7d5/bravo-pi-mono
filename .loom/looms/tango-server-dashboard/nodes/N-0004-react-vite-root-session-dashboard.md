---
id: N-0004
title: React/Vite root-session dashboard
kind: task
state: open
parent: N-0001
summary: React/Vite root-session dashboard
tags: []
edges:
  - type: depends_on
    to: N-0003
created_at: "2026-04-27T00:41:30.366Z"
updated_at: "2026-04-27T03:20:26.458Z"
---






# Summary

React/Vite root-session dashboard

# Context


# Analysis


# Result

Pending.


# Note 2026-04-27T00:41:42.116Z

## Focus

Replace the temporary inline HTML dashboard with a product-quality React + Vite frontend.

## Required UX

- Landing page is root-session/workstream picker.
- Selected root session has overview, agents, attention, artifacts, and timeline.
- Global attention/history are secondary views.
- Strong visual status treatment: running, blocked, error, done, stopped, unknown.
- Copy buttons for attach/look/result commands with success feedback.
- SSE connection state and live refresh.


# Note 2026-04-27T00:43:27.454Z

## Implementation plan: React/Vite root-session dashboard

### Objective and scope

Replace the temporary inline dashboard HTML in `packages/tango/src/server.ts` with a React + Vite frontend centered on root sessions/workstreams. Scope includes build integration, static asset serving, route design, client data loading, SSE-triggered refresh, and component structure. Source edits are not part of this planning note.

### Expected API dependency

Implement after or alongside N-0003. React should consume view-model routes, not `/api/v1/agents` raw metadata, except possibly for a temporary developer/debug panel. Freeze shared response types before building screens.

Primary routes consumed:

- `GET /api/v1/dashboard` for landing/global snapshot.
- `GET /api/v1/workstreams` for picker.
- `GET /api/v1/workstreams/:rootSessionId` for overview.
- `GET /api/v1/workstreams/:rootSessionId/agents` for agent forest.
- `GET /api/v1/workstreams/:rootSessionId/attention` for per-root attention.
- `GET /api/v1/workstreams/:rootSessionId/artifacts` for per-root artifacts.
- `GET /api/v1/attention` for global attention.
- Prefer adding `GET /api/v1/workstreams/:rootSessionId/timeline` and `GET /api/v1/history` for route parity; otherwise mark timeline/history views as limited until API follow-up.
- `GET /api/v1/events` SSE; on `event` messages, invalidate/refetch active view. Show `connected`, `reconnecting`, and `disconnected` states.

### Files/areas likely to change

- `packages/tango/package.json`: add frontend build/check scripts and dependencies (`react`, `react-dom`, `@vitejs/plugin-react`, `vite`; dev types as needed). Consider whether deps should be regular dependencies because packaged dashboard assets are built at publish time and runtime server does not import React.
- `packages/tango/tsconfig.json`: either keep server TS config and add `tsconfig.app.json`, or use Vite defaults for frontend.
- New `packages/tango/dashboard/` or `packages/tango/src/dashboard-app/`:
  - `index.html`
  - `src/main.tsx`
  - `src/App.tsx`
  - `src/api.ts`
  - `src/types.ts` or import generated/shared TS shapes
  - `src/components/*`
  - `src/styles.css`
- `packages/tango/src/server.ts`: remove inline `dashboardHtml`; serve built static assets and SPA fallback for dashboard routes.
- `packages/tango/dist-dashboard/` or similar build output: generated, likely ignored or packaged depending repo convention.
- Root/package workspace scripts if `npm run build --workspaces --if-present` must include frontend build.

### Client route plan

Use browser history routes matching N-0001:

- `/`: root session/workstream picker with dashboard summary cards.
- `/sessions/:rootSessionId`: selected session overview.
- `/sessions/:rootSessionId/agents`: full agent forest.
- `/sessions/:rootSessionId/attention`: per-root attention queue.
- `/sessions/:rootSessionId/artifacts`: per-root artifacts.
- `/sessions/:rootSessionId/timeline`: per-root timeline; can start with preview/empty state if API is deferred.
- `/global/attention`: global attention across active roots.
- `/global/history`: historical + legacy view, opt-in and visually secondary.

Do not use a heavy router unless justified; a tiny route parser around `window.location.pathname`, `history.pushState`, and typed params is sufficient for v1. If using React Router, document dependency and route fallback behavior.

### Component plan

- `App`: route parser, auth token capture, layout shell, SSE connection lifecycle, global refresh coordination.
- `ApiClient`: fetch wrapper that adds bearer token if available; fallback to `?token=` only where current server requires it. Normalize errors into UI state.
- `Layout`: sidebar/top nav, selected workstream title, connection indicator, refresh button.
- `WorkstreamPicker`: cards grouped by `attention`, `active`, `recentlyCompleted`; hidden history/legacy affordance.
- `WorkstreamCard`: title, cwd, status counts, last activity, kind badge.
- `SessionOverview`: summary metrics, top attention, agent preview, artifacts preview, timeline preview.
- `AgentForest`: recursive tree view using server `forest`; expandable nodes later, fully expanded for v1 is acceptable.
- `AgentCard`: strong status treatment, role/harness/mode, summary/task, needs, metrics snippet, lineage hints, command copy buttons.
- `StatusBadge`: maps running/blocked/error/done/stopped/unknown to consistent colors/icons.
- `AttentionList` and `AttentionItemCard`: severity ordering (`error`, `blocked`, `needs`, `stopped`) and clear since/message.
- `ArtifactsList`: active/revoked state, open link, copy URL; never construct arbitrary file paths.
- `Timeline`: chronological event list with status transitions and artifact/root events where available.
- `HistoryView`: explicitly labeled historical/legacy content; avoids implying these are current work.
- `CopyButton`: clipboard write with success/failure feedback and accessible label.
- `EmptyState`, `ErrorState`, `LoadingState`: reusable UX states.

### Build and server integration

1. Create Vite app inside `packages/tango` so it remains one npm workspace package.
2. Configure Vite `base: '/'` and output to a deterministic folder such as `packages/tango/dist-dashboard`.
3. Add scripts:
   - `build:server`: existing `tsc -p tsconfig.json` or keep `build` as an aggregate.
   - `build:dashboard`: `vite build --config dashboard/vite.config.ts`.
   - `build`: run server TS build then dashboard build.
   - `check`: `tsc -p tsconfig.json --noEmit` plus frontend typecheck if separate.
4. In `server.ts`, serve static built assets for hashed JS/CSS from `dist-dashboard`; fallback to `index.html` for dashboard routes (`/`, `/sessions/...`, `/global/...`).
5. Keep API routes and `/a/...` artifact routes higher priority than SPA fallback.
6. In development, either rely on production build assets or add a documented Vite dev proxy; do not add a server-side dev proxy unless needed.
7. Remove the inline HTML dashboard after static serving is verified; no dual UI path unless a temporary dev fallback is explicitly requested.

### Token/auth handling

- Current server accepts `Authorization: Bearer <token>` or `?token=`. The dashboard can read `token` from the initial URL query, store it in memory/sessionStorage, and then use Authorization headers for API/SSE where possible.
- Browser `EventSource` cannot set Authorization headers; keep `?token=` for `/api/v1/events` unless replacing EventSource with `fetch` streaming.
- Avoid persisting tokens in localStorage unless product explicitly accepts the risk. Session storage is acceptable for local v1.
- Preserve token in internal navigation only if needed; prefer clean URLs after session storage is populated.

### Ordered implementation steps

1. Finalize N-0003 response contracts and add shared TypeScript types or duplicated client types with a clear sync point.
2. Add Vite/React dependencies and app skeleton in a contained dashboard directory.
3. Implement fetch client, route parser, connection state, and global refresh key.
4. Build landing picker and session overview against real APIs with robust loading/error/empty states.
5. Implement detailed agents, attention, artifacts, timeline, global attention, and history routes.
6. Add copy command UX with clipboard success feedback.
7. Replace `dashboardHtml` server route handling with static asset serving and SPA fallback, keeping `/api/v1/*` and `/a/*` precedence.
8. Wire package scripts so `npm run build -w @bravo/tango` builds both server and dashboard.
9. Manual smoke on the existing worktree/server before touching active main package or relinking global CLI.

### Architectural implications and smells

- Smell: inline HTML in `server.ts` is already a dead-end; remove it cleanly once React assets serve.
- Smell: client reconstructing attention/history from raw agents would duplicate N-0003 business logic; treat this as a blocker if view-model APIs are missing.
- Keep frontend state shallow: server owns classification, forest building, and artifact ownership; React owns presentation, route, and transient loading/copy states.
- Avoid adding a full design system or global state library for v1.
- Build output must not make the host-native server depend on a running Vite dev server.

### Tests and validation

- Frontend typecheck/build: `npm run check -w @bravo/tango` and `npm run build -w @bravo/tango`.
- Add minimal component tests only where they protect important behavior: status badge mapping, route parsing, API error rendering, copy button feedback. If no runner exists, consider adding Vitest with React Testing Library only if dependency cost is acceptable.
- Add a server static-serving smoke/integration test if an HTTP test harness is introduced: API routes win over SPA fallback; `/sessions/x` returns `index.html`; built JS/CSS get correct MIME; `/a/...` unchanged.
- Manual smoke:
  1. Start `tango server` from the worktree.
  2. Open `/?token=...`.
  3. Verify picker excludes legacy by default.
  4. Navigate selected root overview/agents/attention/artifacts/timeline/global routes and refresh directly on each route.
  5. Trigger `tango status blocked|done` from an agent and verify SSE state/refetch updates UI.
  6. Copy attach/look/result commands and confirm clipboard feedback.

### Rollout and observability risks

- Existing live agents are running from the main workspace; implement in `/home/joe/Documents/projects/bravo-pi-mono-tango-server` and avoid relinking/rebuilding the active package until explicit rollout testing.
- Static asset path bugs can make the dashboard blank while APIs work; keep server health/API curl checks separate from browser UI smoke.
- Frequent SSE invalidation can cause request storms; debounce reloads (e.g. 250-500ms) and refetch only the active route plus dashboard summary.
- Query-token URLs are convenient but leak in browser history; clean URL after capturing token when possible.
- Vite dependency footprint changes package install/build time; call out in PR/review.

### Open questions/assumptions

- Assume React + Vite dependency footprint is approved by N-0001.
- Decide whether to introduce `GET /api/v1/history` and timeline API now; otherwise label those routes as partial in rollout notes.
- Decide whether generated dashboard assets are committed, packaged, or built by consumers; package scripts must make this unambiguous.


# Note 2026-04-27T03:17:24.339Z

## N-0004 implementation update after quota interruption

Initial worker `n0004-react-dashboard-impl` hit provider quota while fixing dashboard TypeScript checks. Coordinator stopped the stalled worker and completed the validation fixes directly.

Implemented/validated:

- Added React/Vite dashboard under `packages/tango/dashboard/`.
- Integrated dashboard build into `@bravo/tango` scripts:
  - `build`: TypeScript server build + dashboard build.
  - `check`: TypeScript server check + dashboard `tsc --noEmit`.
- Server now serves dashboard SPA from built dashboard assets when available, with inline prototype HTML retained as fallback.
- Dashboard covers root-session/workstream-first navigation, attention, artifacts, timeline/history, agent tree, and stable command copy UI.
- Fixed dashboard TS issues by removing unused React imports and adding Vite env typing.

Validation:

```bash
npm test --workspace @bravo/tango   # 109 tests pass
npm run check --workspace @bravo/tango
npm run build --workspace @bravo/tango
```

Smoke:

- Started built `tango server` with temp `TANGO_HOME`.
- `/api/v1/health` returned OK.
- `/` served dashboard HTML.
- `/api/v1/dashboard` returned root-session dashboard JSON.


# Note 2026-04-27T03:20:26.458Z

## N-0004 review blocker fixes

Reviewer `n0004-dashboard-review` blocked on dashboard token leakage/UX:

- dashboard HTML was served before authorization and injected the server token;
- SPA did not read injected meta token, so `/` was still not usable without `?token=...`;
- dashboard source maps were publicly served as a non-blocking risk.

Coordinator fixes:

- Dashboard page routes now require authorization before serving SPA/fallback HTML.
- Static assets can still be served, but `/` and `/index.html` are not served by the static file shortcut.
- Unauthorized `GET /` returns 401 and does not expose the token.
- Dashboard API remains protected without token.
- Dashboard production source maps are disabled.

Validation:

```bash
npm test --workspace @bravo/tango   # 114 tests pass
npm run check --workspace @bravo/tango
npm run build --workspace @bravo/tango
```
