---
id: N-0003
title: Root-session dashboard view-model APIs
kind: task
state: open
parent: N-0001
summary: Root-session dashboard view-model APIs
tags: []
edges:
  - type: depends_on
    to: N-0009
  - type: depends_on
    to: N-0010
created_at: "2026-04-27T00:41:30.366Z"
updated_at: "2026-04-27T02:26:18.276Z"
---











# Summary

Root-session dashboard view-model APIs

# Context


# Analysis


# Result

Pending.


# Note 2026-04-27T00:41:41.954Z

## Focus

Create server-shaped dashboard APIs so the frontend does not reconstruct operational state from raw metadata.

## Required endpoints

- `GET /api/v1/dashboard`
- `GET /api/v1/workstreams`
- `GET /api/v1/workstreams/:rootSessionId`
- `GET /api/v1/workstreams/:rootSessionId/agents`
- `GET /api/v1/workstreams/:rootSessionId/attention`
- `GET /api/v1/workstreams/:rootSessionId/artifacts`
- `GET /api/v1/attention`

## Required model behavior

- Root session/workstream is the primary grouping key.
- Classify active, attention, recently completed, historical, and legacy.
- Hide old completed/legacy runs by default.
- Build agent forests by `parentRunId`, falling back to `parentRunDir` for old runs.


# Note 2026-04-27T00:42:30.325Z

Planning in progress placeholder


# Note 2026-04-27T00:43:00.063Z

## Implementation plan: dashboard view-model APIs

### Objective and scope

Implement server-side dashboard view-model APIs in `packages/tango` so React does not infer product state from raw `AgentMetadata`. Scope is read-only aggregation/classification over existing file-backed metadata, root-session records, artifacts, metrics, and recent events. Do not add a compatibility shim or Loom-specific parsing; expose generic Tango concepts only.

### Proposed files/areas

- `packages/tango/src/server.ts`: route wiring, static/dashboard routing coordination, auth preservation.
- New `packages/tango/src/dashboard.ts` (or similarly named): pure view-model builders and classifiers.
- `packages/tango/src/types.ts`: exported dashboard API TypeScript shapes if shared with frontend.
- `packages/tango/src/metadata.ts` / `events.ts` only if small helper exports are needed; avoid changing persisted schemas unless required.
- Tests under `packages/tango/src/*.test.ts` or a new test layout if the package adds a runner.

### API routes and response shapes

All routes require existing bearer/query token auth except public artifact URLs and dashboard shell. Keep `schemaVersion: 1` and `ok: true` wrappers.

1. `GET /api/v1/dashboard`
   - Purpose: landing/global snapshot.
   - Shape:
     ```ts
     {
       ok: true,
       schemaVersion: 1,
       generatedAt: string,
       totals: { active: number; attention: number; recentlyCompleted: number; historical: number; legacy: number; artifacts: number },
       workstreams: WorkstreamSummary[],
       globalAttention: AttentionItem[],
       recentTimeline: TimelineItem[],
       legacy: { count: number; sample: AgentCard[] }
     }
     ```

2. `GET /api/v1/workstreams`
   - Purpose: picker list; default excludes purely historical/legacy roots unless `?include=history,legacy` is supplied.
   - Shape: `{ ok, schemaVersion, generatedAt, workstreams: WorkstreamSummary[], hidden: { historical: number; legacy: number } }`.

3. `GET /api/v1/workstreams/:rootSessionId`
   - Purpose: selected root overview.
   - Shape:
     ```ts
     {
       ok: true,
       schemaVersion: 1,
       generatedAt: string,
       workstream: WorkstreamSummary,
       overview: { activeAgents: number; attentionItems: number; completedAgents: number; artifactCount: number; lastEventAt?: string },
       rootAgent?: AgentCard,
       agentsPreview: AgentTreeNode[],
       attentionPreview: AttentionItem[],
       artifactsPreview: ArtifactCard[],
       timelinePreview: TimelineItem[]
     }
     ```

4. `GET /api/v1/workstreams/:rootSessionId/agents`
   - Shape: `{ ok, schemaVersion, generatedAt, rootSessionId, agents: AgentCard[], forest: AgentTreeNode[], orphaned: AgentCard[], counts: StatusCounts }`.

5. `GET /api/v1/workstreams/:rootSessionId/attention`
   - Shape: `{ ok, schemaVersion, generatedAt, rootSessionId, items: AttentionItem[] }`.

6. `GET /api/v1/workstreams/:rootSessionId/artifacts`
   - Shape: `{ ok, schemaVersion, generatedAt, rootSessionId, artifacts: ArtifactCard[] }`.

7. `GET /api/v1/attention`
   - Purpose: global attention view across active roots.
   - Shape: `{ ok, schemaVersion, generatedAt, items: AttentionItem[], byRootSession: Array<{ rootSessionId?: string; title: string; count: number }> }`.

Optional but useful for N-0004 route parity: `GET /api/v1/workstreams/:rootSessionId/timeline` and `GET /api/v1/history`; if deferred, have React derive these from overview/dashboard previews only temporarily and track explicit follow-up.

### Core view-model types

```ts
type DashboardStatus = 'running' | 'blocked' | 'error' | 'done' | 'stopped' | 'unknown';
type AgentBucket = 'active' | 'attention' | 'recentlyCompleted' | 'historical' | 'legacy';

type WorkstreamSummary = {
  rootSessionId: string;
  workstreamId?: string;
  title: string;
  kind?: 'pi' | 'cli' | 'dashboard' | 'restored' | 'legacy';
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  lastSeenAt?: string;
  lastActivityAt?: string;
  status: DashboardStatus;
  bucket: AgentBucket;
  counts: StatusCounts & { attention: number; artifacts: number; legacy: number };
};

type AgentCard = {
  runId?: string;
  runDir: string;
  name: string;
  role?: string;
  harness: string;
  mode: 'oneshot' | 'interactive';
  status: DashboardStatus;
  bucket: AgentBucket;
  cwd: string;
  task: string;
  summary?: string;
  needs?: string;
  createdAt: string;
  updatedAt: string;
  parentRunId?: string;
  parentRunDir?: string;
  rootSessionId?: string;
  workstreamId?: string;
  metrics?: AgentMetricsSnapshot;
  commands: { attach?: string; look: string; result: string };
};

type AgentTreeNode = AgentCard & { children: AgentTreeNode[] };
type AttentionItem = { id: string; severity: 'blocked' | 'error' | 'needs' | 'stopped'; rootSessionId?: string; agent: AgentCard; message: string; since: string };
type ArtifactCard = { artifactId: string; title: string; url?: string; entry: string; ownerRunDir?: string; rootSessionId?: string; status: 'active' | 'revoked'; createdAt: string; revokedAt?: string };
type TimelineItem = { id: string; time: string; type: 'agent.status' | 'artifact.published' | 'root.updated'; rootSessionId?: string; title: string; status?: DashboardStatus; runDir?: string };
```

### Grouping and classification logic

- Load all agents with `listMetadata()` once per request; join metrics via `readMetrics(runDir)`.
- Primary grouping key: `agent.rootSessionId`. Join to `RootSessionRecord` by id.
- For agents with no `rootSessionId`, classify as `legacy` and place in a synthetic legacy bucket. Do not show in default workstream picker except under explicit history/legacy views.
- If a `RootSessionRecord` exists with no agents, still return a workstream card using its `lastSeenAt` and zero counts.
- Classification per agent:
  - `attention`: `status in ['blocked','error']` or non-empty `needs`.
  - `active`: `status in ['created','running','unknown']` and not attention.
  - `recentlyCompleted`: `status in ['done','stopped']` and `updatedAt` within a fixed recent window (recommend 24h) or root has other active/attention agents.
  - `historical`: completed/stopped outside the recent window with root metadata.
  - `legacy`: missing `rootSessionId` or insufficient lineage metadata.
- Workstream bucket precedence: `attention` > `active` > `recentlyCompleted` > `historical`; legacy only for synthetic legacy group.
- Forest building for a root:
  - index by `runId` when present; otherwise by normalized `runDir`.
  - link child to parent by `parentRunId` first; fallback to `parentRunDir` for old runs.
  - keep unresolved children in `orphaned` with a visible marker rather than dropping them.
  - sort siblings by `createdAt`, then `name`.
- Artifact association:
  - preferred: `ownerRunDir` -> agent -> rootSessionId.
  - fallback: artifact `cwd` only for display/global history, not as proof of root ownership.
  - exclude `revokedAt` artifacts from active counts but include them in per-root artifact route with status.
- Timeline:
  - read recent `events.jsonl` via existing helpers or a bounded reverse/tail helper; filter by `rootSessionId` for root routes.
  - include only generic Tango events; do not inspect Loom files.

### Ordered implementation steps

1. Extract existing `listAgents()` shaping into a pure helper returning `AgentCard` with commands and metrics.
2. Add `dashboard.ts` with pure functions: `buildDashboardModel`, `buildWorkstreamSummaries`, `buildAgentForest`, `classifyAgent`, `buildAttentionItems`, `associateArtifacts`, and bounded timeline construction.
3. Add response interfaces in `types.ts` or colocated exports consumed by both server and future frontend.
4. Wire the seven required GET routes in `handleRequest`, preserving current `/api/v1/agents`, `/api/v1/root-sessions`, and `/api/v1/artifacts` for low-level/debug use.
5. Add query controls: `?include=history,legacy`, `?limit=N`, and `?recentHours=24` only if needed; keep defaults product-oriented.
6. Return 404 `{ ok:false, error:'Root session not found' }` for unknown concrete `:rootSessionId`, except synthetic legacy if explicitly supported.
7. Keep commands lineage-friendly where possible (`tango attach <name>` from agent cwd for now) but plan to swap to stable `--run-id` when N-0002 resolver work lands.

### Architectural implications and smells

- Smell: server currently mixes HTTP routing, dashboard HTML, artifact serving, root-session persistence, and view shaping in one file. Isolate view-model code now to prevent React work from cementing `server.ts` as a god file.
- Smell: command strings include `cd cwd && tango ...`, which conflicts with the root-session lineage goal. Do not redesign here, but centralize command generation so resolver changes can update one place.
- Avoid a frontend-side state machine; server should own classification so CLI, dashboard, and tests agree.
- Avoid compatibility layers for old metadata beyond explicit `legacy` buckets and `parentRunDir` forest fallback.

### Tests and validation

- Add pure unit tests for classification precedence, recent cutoff, legacy hiding, root records with no agents, and stopped/done historical handling.
- Add forest tests covering `parentRunId`, `parentRunDir` fallback, missing parent -> orphan, and stable sort.
- Add artifact association tests for ownerRunDir match, revoked status, and cwd-only fallback not being counted as owned.
- Add route-level tests against `handleRequest` if feasible; otherwise use pure model tests plus manual curl smoke.
- Validation commands: `npm run check -w @bravo/tango`, `npm run build -w @bravo/tango`; add a test script once a runner is introduced.
- Manual smoke: start `tango server`, call all API routes with token, verify default picker omits old legacy agents and selected root returns forest/attention/artifacts.

### Rollout and observability risks

- Response-shape churn will affect N-0004; freeze the TypeScript contracts before implementing React screens.
- Reading all metadata/events per request is acceptable for v1 but may need bounded event reads and caching if dashboard reloads on frequent SSE events.
- Old agents without root identity must remain visible in `/global/history`/legacy, not silently disappear.
- Auth remains local token/query for v1; do not expose these APIs on non-local bind without the existing `--allow-private-bind` gate.

### Assumptions/open questions

- Recent completed window defaults to 24h unless product chooses a different value.
- Root-session lifecycle states are not persisted yet; infer active/historical from child agent state and timestamps for v1.
- Timeline route was not listed for N-0003 but is required by N-0004 UX; decide whether to add it now or explicitly defer.


# Note 2026-04-27T00:47:50.393Z

## Consistency update: timeline/history routes are in v1 scope

Decision N-0010 resolved that timeline and history APIs are part of v1 dashboard view-model scope.

Add to required routes:

- `GET /api/v1/workstreams/:rootSessionId/timeline`
- `GET /api/v1/history`

React must consume these server-shaped APIs and should not infer timeline/history directly from raw `/api/v1/agents` metadata.


# Note 2026-04-27T01:36:46.458Z

probe note syntax


# Note 2026-04-27T01:37:21.725Z

## Implementation-ready API contract: root-session dashboard view models

This note supersedes the preceding probe note. It is based on `docs/specs/tango-daemon-loom-dashboard/design.md`, `plan.md`, and read-only inspection of `packages/tango/src/server.ts`, `types.ts`, `metadata.ts`, and `events.ts`.

### Objective and scope

Implement server-shaped dashboard APIs in `packages/tango` so React consumes root-session/workstream view models instead of reconstructing state from raw `/api/v1/agents`. Keep Tango generic: no Loom imports, no `.loom/` reads, no Loom-specific state transitions. Use existing file-backed state: `listMetadata()`, `readMetrics(runDir)`, `listRootSessions()`, `listArtifacts()`, and bounded `events.jsonl` reads.

### Module split recommendation

- Add `packages/tango/src/dashboard.ts` for pure builders/classifiers:
  - `buildDashboardModel(input, options)`
  - `buildWorkstreamSummaries(input, options)`
  - `buildWorkstreamDetail(rootSessionId, input, options)`
  - `buildAgentCards(agents)`
  - `buildAgentForest(cards)`
  - `buildAttentionItems(cards, attentionState?)`
  - `buildArtifactCards(artifacts, cards)`
  - `buildTimelineItems(events, cards, artifacts, rootSessionId?)`
  - `buildHistoryModel(input, options)`
- Keep `packages/tango/src/server.ts` as route wiring/auth/static serving only. Existing `listAgents()` shaping in `server.ts` should move or be replaced by shared `AgentCard` shaping.
- Export view-model interfaces from `packages/tango/src/types.ts` if the future React app imports package types; otherwise colocate in `dashboard.ts` and export from there.
- Do not alter persisted metadata schemas for this node unless an implementation gap is discovered.

### Common response and query conventions

All JSON responses use `{ ok: true, schemaVersion: 1, generatedAt: string, ... }`; errors use existing `{ ok:false, error:string }`. Preserve existing auth behavior: dashboard shell/public artifact URLs are exceptions; APIs require bearer/query token.

Default dashboard views hide old historical and legacy runs. Supported query options:

- `include=history,legacy` on collection routes to opt into hidden buckets.
- `limit=N` for previews/timeline/history; clamp to a safe maximum.
- `recentHours=24` optional override for tests/manual smoke; default 24h.

### View-model shapes

```ts
type DashboardStatus = 'created' | 'running' | 'blocked' | 'error' | 'done' | 'stopped' | 'unknown';
type WorkstreamBucket = 'attention' | 'active' | 'recent' | 'historical' | 'legacy';
type AttentionSeverity = 'needs' | 'blocked' | 'error' | 'stopped' | 'completion';
type ArtifactStatus = 'active' | 'revoked';

type StatusCounts = {
  created: number; running: number; blocked: number; error: number;
  done: number; stopped: number; unknown: number;
};

type CommandView = { attach?: string; look: string; result: string };

type WorkstreamSummary = {
  rootSessionId: string;
  workstreamId?: string;
  title: string;
  kind?: 'pi' | 'cli' | 'dashboard' | 'restored' | 'legacy';
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  lastSeenAt?: string;
  lastActivityAt?: string;
  status: DashboardStatus;
  bucket: WorkstreamBucket;
  counts: StatusCounts & { agents: number; attention: number; artifacts: number; legacy: number };
  commands?: { open?: string; copyContext?: string };
};

type AgentCard = {
  runId?: string;
  runDir: string;
  name: string;
  role?: string;
  harness: string;
  mode: 'oneshot' | 'interactive';
  model?: string;
  status: DashboardStatus;
  bucket: WorkstreamBucket;
  cwd: string;
  task: string;
  summary?: string;
  needs?: string;
  createdAt: string;
  updatedAt: string;
  parentRunId?: string;
  parentRunDir?: string;
  rootSessionId?: string;
  workstreamId?: string;
  metrics?: AgentMetricsSnapshot;
  commands: CommandView;
};

type AgentTreeNode = AgentCard & { children: AgentTreeNode[] };

type AttentionItem = {
  id: string;
  rootSessionId?: string;
  workstreamId?: string;
  severity: AttentionSeverity;
  state?: 'new' | 'delivered' | 'seen' | 'handled' | 'dismissed' | 'superseded';
  agent: AgentCard;
  message: string;
  since: string;
};

type ArtifactCard = {
  artifactId: string;
  title: string;
  url?: string;
  entry: string;
  ownerRunDir?: string;
  rootSessionId?: string;
  workstreamId?: string;
  status: ArtifactStatus;
  createdAt: string;
  revokedAt?: string;
};

type TimelineItem = {
  id: string;
  time: string;
  type: 'agent.status' | 'artifact.created' | 'artifact.revoked' | 'root.updated';
  rootSessionId?: string;
  workstreamId?: string;
  title: string;
  status?: DashboardStatus;
  runId?: string;
  runDir?: string;
  artifactId?: string;
};
```

### Required endpoints

1. `GET /api/v1/dashboard`

Global landing/root picker snapshot.

```ts
type DashboardResponse = {
  ok: true; schemaVersion: 1; generatedAt: string;
  totals: { active: number; attention: number; recent: number; historical: number; legacy: number; artifacts: number };
  workstreams: WorkstreamSummary[];        // default: attention, active, recent
  globalAttention: AttentionItem[];
  recentTimeline: TimelineItem[];
  hidden: { historical: number; legacy: number };
};
```

2. `GET /api/v1/workstreams`

Root/workstream card list. Default excludes `historical` and `legacy`; include via query.

```ts
{ ok: true; schemaVersion: 1; generatedAt: string; workstreams: WorkstreamSummary[]; hidden: { historical: number; legacy: number } }
```

3. `GET /api/v1/workstreams/:rootSessionId`

Selected root overview; 404 for unknown non-legacy root. Include root records with no agents.

```ts
{
  ok: true; schemaVersion: 1; generatedAt: string;
  workstream: WorkstreamSummary;
  overview: { activeAgents: number; attentionItems: number; completedAgents: number; artifactCount: number; lastEventAt?: string };
  rootAgent?: AgentCard;
  agentsPreview: AgentTreeNode[];
  attentionPreview: AttentionItem[];
  artifactsPreview: ArtifactCard[];
  timelinePreview: TimelineItem[];
}
```

4. `GET /api/v1/workstreams/:rootSessionId/agents`

```ts
{ ok: true; schemaVersion: 1; generatedAt: string; rootSessionId: string; agents: AgentCard[]; forest: AgentTreeNode[]; orphaned: AgentCard[]; counts: StatusCounts }
```

5. `GET /api/v1/workstreams/:rootSessionId/attention`

```ts
{ ok: true; schemaVersion: 1; generatedAt: string; rootSessionId: string; items: AttentionItem[] }
```

6. `GET /api/v1/workstreams/:rootSessionId/artifacts`

```ts
{ ok: true; schemaVersion: 1; generatedAt: string; rootSessionId: string; artifacts: ArtifactCard[] }
```

7. `GET /api/v1/workstreams/:rootSessionId/timeline`

Bounded recent event projection for the selected root; not a full audit explorer.

```ts
{ ok: true; schemaVersion: 1; generatedAt: string; rootSessionId: string; items: TimelineItem[]; nextCursor?: string }
```

8. `GET /api/v1/attention`

Global attention view across visible roots. Default should exclude handled/dismissed items once N-0011 exists.

```ts
{ ok: true; schemaVersion: 1; generatedAt: string; items: AttentionItem[]; byRootSession: Array<{ rootSessionId?: string; title: string; count: number }> }
```

9. `GET /api/v1/history`

Opt-in historical/legacy listing.

```ts
{
  ok: true; schemaVersion: 1; generatedAt: string;
  workstreams: WorkstreamSummary[];   // historical roots and optionally legacy synthetic group
  legacyAgents: AgentCard[];
  timeline: TimelineItem[];
  hiddenFromDefault: { historical: number; legacy: number };
}
```

Keep existing low-level/debug endpoints (`/api/v1/agents`, `/api/v1/root-sessions`, `/api/v1/artifacts`) during this work; dashboard React should use the view-model endpoints.

### Classification and grouping rules

- Primary grouping key is `AgentMetadata.rootSessionId`; join with `RootSessionRecord.rootSessionId`.
- A `RootSessionRecord` with no agents still produces a workstream summary with zero agent counts and activity from `lastSeenAt`/`updatedAt`.
- Agents missing `rootSessionId` are `legacy`; they are hidden from default workstream/dashboard routes and visible through `/api/v1/history` or `include=legacy`.
- Per-agent bucket:
  - `attention`: `status === 'blocked' || status === 'error' || needs`.
  - `active`: `status in ['created','running','unknown']` and not attention.
  - `recent`: terminal (`done`/`stopped`) and `updatedAt` within recent window, or terminal under a root that also has active/attention agents.
  - `historical`: terminal outside recent window with root metadata.
  - `legacy`: missing `rootSessionId` or insufficient lineage metadata for root grouping.
- Workstream bucket precedence: `attention` > `active` > `recent` > `historical`; `legacy` only for synthetic legacy grouping/history.
- Workstream status should reflect the highest-precedence child status; use root record timestamps for empty roots.
- Sort workstreams by bucket precedence then `lastActivityAt` descending.

### Forest rules

- Build one forest per root from agents with matching `rootSessionId`.
- Index parents by `runId` first; fallback to normalized `runDir` for old runs.
- Link child by `parentRunId` first; fallback to normalized `parentRunDir`.
- Unresolved children go in `orphaned`; do not drop them.
- Root nodes are agents with no resolvable parent inside the same root.
- Sort siblings by `createdAt`, then `name`.

### Attention rules

- Before N-0011, derive attention read-only from current metadata:
  - `error` -> severity `error`
  - `blocked` -> severity `blocked`
  - non-empty `needs` -> severity `needs`
  - optional completion attention for recent `done` can be omitted unless a delivery-state source exists.
- After N-0011, merge durable attention/delivery records and expose `state`; default filters should hide `handled`, `dismissed`, and `superseded` but keep blocked/error/needs visible when only `seen`.
- Stable derived item id before N-0011: `att:${runId ?? normalizedRunDir}:${status}:${updatedAt}`.
- Do not implement acknowledgement mutation routes in N-0003 unless N-0011 provides the state store/API contract first.

### Artifact rules

- Use `ArtifactManifest.ownerRunDir` -> `AgentCard.runDir` to associate artifact with root/workstream.
- Include revoked artifacts in per-root artifact route with `status:'revoked'`; exclude revoked from active counts.
- Current `publishArtifact()` returns URL only when discovery exists; route builders may reconstruct `/a/:artifactId/:token/:entry` paths for local UI, but avoid leaking token outside authenticated API payloads except existing artifact behavior.
- `cwd` fallback is display/search only, not proof of root ownership.

### Timeline/history rules

- Source initial timeline from bounded `events.jsonl` reads plus artifact/root-session synthetic items where cheap.
- Filter root timeline by `event.rootSessionId === :rootSessionId`; do not fall back to cwd for root routes.
- Global recent timeline can include visible roots; `/api/v1/history` can include historical/legacy events.
- Current `readEvents(state)` is forward-from-offset. For route use, add a bounded helper that reads/parses the tail or whole file with limit clamp for v1; avoid unbounded large responses.

### Dependency notes

- N-0002: command resolution/run identity is the contract for stable dashboard commands and forest linking. Prefer command strings with `--run-id` when supported; otherwise centralize current `cd <cwd> && tango attach/look/result <name>` generation so N-0002 changes update one place. Forest logic must use `parentRunId` primary and `parentRunDir` fallback.
- N-0011: durable attention/delivery state is not required to ship read-only dashboard view models, but it is required for correct seen/handled/dismissed semantics and duplicate notification suppression. N-0003 should expose optional `AttentionItem.state` and keep mutation/ack routes out until N-0011 lands.
- N-0010: timeline and history APIs are in v1 scope; do not force React to infer them from raw agents.
- N-0009: use inferred lifecycle; no explicit archive/close required for v1.

### Validation strategy

Automated tests should focus on pure `dashboard.ts` builders:

- classification precedence: attention outranks active/recent/historical; `needs` creates attention; recent cutoff defaults to 24h.
- default filtering hides historical and legacy; `include=history,legacy` reveals them.
- root record with no agents still returns a workstream card.
- forest building: `parentRunId`, `parentRunDir` fallback, orphan handling, stable sorting.
- artifact association: ownerRunDir match, revoked status/count exclusion, cwd-only not counted as owned.
- attention derivation now, and later N-0011 state filtering.
- timeline filtering by rootSessionId and bounded limits.

Route smoke/contract tests if feasible: call `handleRequest` or start a test server and assert all nine endpoints return `schemaVersion:1`, auth is preserved, unknown root returns 404, and existing low-level endpoints still work.

Validation commands:

```bash
cd /home/joe/Documents/projects/bravo-pi-mono-tango-server
npm run check --workspace @bravo/tango
npm run build --workspace @bravo/tango
npm test --workspace @bravo/tango
```

Manual smoke: start `tango server`, create/resume a root session, run parent/child agents with lineage, publish an artifact, mark one child blocked/error, then curl all API routes with token and verify default dashboard/workstream responses show active/attention/recent roots but hide historical/legacy unless requested.


# Note 2026-04-27T02:01:10.044Z

## N-0003 review result: BLOCKED

Reviewer `n0003-dashboard-api-review` returned BLOCKED. Targeted checks passed (`npm --prefix packages/tango run check`, `npm --prefix packages/tango run build`, `node --test packages/tango/dist/rootSessions.test.js`) but contract blockers remain.

Blocking findings:

1. Required workstream subroutes are missing. Current route wiring handles `/api/v1/workstreams/:rootSessionId` and `/agents`, but not required scoped `/attention`, `/artifacts`, and `/timeline` routes.
2. Workstream detail leaks all artifacts instead of root-session-scoped artifacts. `buildWorkstreamDetail()` returns all `listArtifacts()` and `buildArtifacts(rootSessionId?)` ignores its scope. Because artifact URLs include tokens, this is a cross-workstream data exposure risk.

Required fix:

- Wire `/api/v1/workstreams/:rootSessionId/attention`, `/artifacts`, and `/timeline`.
- Scope artifacts by matching artifact owner run dirs to agents in the selected root/workstream.
- Add tests for scoped routes/artifact filtering.


# Note 2026-04-27T02:26:18.276Z

## N-0003 final re-review: PASS

Reviewer `n0003-dashboard-api-rereview3` returned PASS.

Resolved final blocker:

- Artifact explicit lineage matching is now conjunctive when both `rootSessionId` and `workstreamId` are present.
- If only one explicit lineage field is present, only that field is matched.
- `ownerRunDir` fallback is used only when no explicit lineage fields exist.
- Regression covers conflicting lineage (`rootSessionId=r2`, `workstreamId=w1`) and asserts the artifact appears in neither mismatched workstream.

Validation:

```bash
npm run check
npm test -w packages/tango
```

Typecheck passed; Tango tests passed: 103 tests, 19 suites, 0 failures.
