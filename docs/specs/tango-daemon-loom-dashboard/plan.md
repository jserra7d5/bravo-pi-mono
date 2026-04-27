# Tango Server and Loom Dashboard Implementation Plan

Date: 2026-04-26
Status: exploratory draft

## Direction

Build a **host-native Node server first**, designed so it can later run in Docker. Agents continue to run on the user's host computer through the existing Tango/Pi/Claude Code/tmux environment. The server provides the control plane, dashboard, event stream, message routing, artifact hosting, and Tango/Loom indexing.

Do not start Docker-first. The first hard problem is the control-plane contract, not packaging.

Implementation should happen in a separate git worktree/branch. Do not rebuild, relink, or otherwise disturb the currently active main workspace/package while live agents are using Tango.

## Authority model

```text
Server:
  live control-plane state, root sessions/workstreams, event stream,
  message queue, artifact registry, dashboard state, attention inbox,
  generic refs, metrics snapshots

Host CLI/runner:
  actual process launch/stop, PID/tmux/session observation, host environment access

Files:
  durable recovery/audit snapshots, logs, results, artifact store, Loom graphs

Loom:
  durable work graph, decisions, tasks, reviews, inboxes, notes, artifacts/references
```

Tango exposes generalized surfaces. Loom consumes those surfaces through refs/events. Tango must not import or mutate Loom internals.

## V1 scope

### In scope

- `tango server` host-native Node process.
- HTTP API plus SSE event stream.
- First-class root session/workstream registry.
- Live run registry and parent/child tree API.
- Automatic lineage rollup from root session to all descendants.
- Basic message queue and delivery state.
- Registered artifact publishing and serving.
- Generic external refs/links on runs/messages/artifacts.
- Basic attention inbox.
- Dashboard v1 as a real root-session-oriented frontend:
  - root session/workstream switcher;
  - selected root session overview;
  - agent forest scoped to root session;
  - attention inbox scoped to root session plus optional global attention;
  - artifacts scoped to root session;
  - basic timeline/recent activity.
- React + Vite dashboard app served by the Tango server.
- CLI uses server when available and falls back to file mode for read/recovery surfaces.
- Pi extension subscribes to server events when available.
- Claude Code harness continues to use `tango ... --json`; CLI forwards to server when available.

### Out of scope for v1

- Docker as the primary implementation path.
- WebSockets, unless SSE proves insufficient.
- Automatic server startup from `tango start`.
- Separate persistent host runner.
- Full Loom graph visualization.
- Treating a flat global historical agent list as the primary dashboard.
- Automatic Loom mutation by default.
- Complex distributed host runners.
- Multi-user auth.
- Internet exposure.
- Arbitrary filesystem browsing/serving.
- Replacing Loom file storage.

## Phase 0: Control-plane contracts

Define the durable/generic schemas before implementation.

Deliverables:

- Root session/workstream schema:
  - `rootSessionId`;
  - `workstreamId`;
  - session kind: Pi root, CLI, dashboard, restored;
  - cwd/workspace roots;
  - created/updated/lastSeen fields;
  - optional title/summary/refs.
- Run identity schema:
  - `runId`;
  - `runDir`;
  - `agentName`;
  - `rootSessionId`;
  - `workstreamId`;
  - `parentRunId` / `parentRunDir`;
  - role/harness/mode/model;
  - created/updated/status fields.
- API/event versioning:
  - HTTP endpoints under `/api/v1/...`;
  - event payloads include `schemaVersion: 1`.
- Event schema:
  - `root_session.started`;
  - `root_session.resumed`;
  - `workstream.updated`;
  - `run.started`;
  - `run.status_changed`;
  - `run.completed`;
  - `run.failed`;
  - `message.created`;
  - `message.delivered`;
  - `artifact.created`;
  - `artifact.revoked`;
  - `attention.created`;
  - `metrics.updated`.
- Generic ref schema:

```json
{
  "provider": "loom",
  "kind": "work.graph.node",
  "uri": "loom://project/N-0001",
  "rel": "implements",
  "label": "Optional label"
}
```

- Artifact manifest schema.
- Message schema and minimum delivery states:
  - `queued`;
  - `delivered`;
  - `failed`;
  - optional later: `seen`, `handled`.

Validation:

- Schema examples for root Pi sessions, CLI-started sessions, Pi runs, Claude Code runs, and generic runs.
- Schema examples showing root/workstream lineage propagated to child and grandchild agents.
- Schema examples for Loom refs without importing Loom.

## Phase 1: Host-native server skeleton

Implement a minimal `tango server` process.

Deliverables:

- CLI command: `tango server`.
- Explicit startup only; `tango start` does not auto-start the server in v1.
- Server discovery file at `$TANGO_HOME/server/server.json` containing URL, token, PID, and start metadata.
- Environment overrides:
  - `TANGO_SERVER_URL`;
  - `TANGO_SERVER_TOKEN`.
- Config:
  - bind host/port, default `127.0.0.1`;
  - server token;
  - `TANGO_HOME`;
  - artifact store path;
  - workspace roots.
- HTTP health endpoint under `/api/v1/...`.
- Basic event stream endpoint using SSE.
- File-backed server state directory under `$TANGO_HOME/server/`.
- JSON/JSONL snapshots and journals for v1 server state; no SQLite for Tango server state in v1.
- Root session creation/resume endpoint.
- Workstream creation/update endpoint.

Validation:

- Server starts/stops cleanly.
- Health endpoint works.
- Root session can be created and resumed.
- Event stream can receive a synthetic event.
- Server refuses non-local binding unless explicitly configured.
- Discovery file is created on startup and removed or marked stale on shutdown.

## Phase 2: CLI/server integration

Make the existing CLI server-aware without removing file fallback.

Deliverables:

- CLI discovers server endpoint/token from `$TANGO_HOME/server/server.json` or env overrides.
- `tango list` reads server state when available, file state otherwise.
- `tango start` continues launching host-native agents, then registers/updates the run with server.
- `tango start` attaches new runs to the current root session/workstream when available.
- Child-started runs inherit root session/workstream from the parent environment and set parent run identity.
- `tango status` forwards status transition to server when available and persists durable files through shared core logic.
- `tango watch` can consume server event stream when available.

Validation:

- Existing no-server CLI behavior still works.
- If the server is unavailable, `tango start` uses current behavior and may print a tip, but does not auto-start the server.
- Server-backed `start/list/status/watch` works for Pi and Claude Code harnesses.
- Server restart can reconstruct enough state from files to list existing runs.
- Root session rollup shows direct children and recursive descendants.
- Runs without root session metadata are grouped into legacy/history buckets, not mixed into current root-session dashboards by default.

## Phase 3: Messaging

Make messaging a first-class server-backed surface.

Deliverables:

- `tango message` creates a durable message record through the server when available.
- Server routes message to live target through host/Pi/tmux mechanism available today.
- Message delivery state is recorded.
- Dashboard/API can list messages by run/tree.
- Loom `inbox send` can continue using `tango message` and benefit from server delivery semantics without direct Tango/Loom coupling.

Validation:

- Send parent → child, child → parent, and sibling/targeted messages.
- Failed delivery records an error and appears in attention inbox.
- Claude Code harness can receive messages through the existing Tango path.

## Phase 4: Artifact hosting

Add registered artifact publishing and serving.

Deliverables:

- CLI:

```bash
tango artifact publish <path> --title "..." [--entry index.html] [--mime text/html]
tango artifact list
tango artifact revoke <artifact-id>
```

- Default publish behavior copies files/directories into controlled artifact store:

```text
$TANGO_HOME/artifacts/<artifact-id>/
  manifest.json
  content/...
```

- Optional explicit reference mode later:

```bash
tango artifact publish --reference <path>
```

- Tokenized artifact URLs even on localhost.
- Server serves only registered artifacts.
- `artifact.created` events include owner run and generic refs.
- Dashboard artifact gallery.

Validation:

- Publish single HTML file.
- Publish HTML directory with assets.
- URL opens from localhost.
- Revoked artifact stops serving.
- Server rejects arbitrary path traversal and hidden/secret-looking files by default.
- Tailnet/private-interface serving only works with explicit opt-in config.

## Phase 5: Dashboard v1

Build a real root-session-oriented dashboard. The dashboard should treat each root session/workstream as a separate project-like workspace. Do not default to a flat global list of historical agents.

### Phase 5a: dashboard view models

Deliverables:

- Add server-shaped dashboard APIs:
  - `GET /api/v1/dashboard` for global summary/root-session picker;
  - `GET /api/v1/workstreams` for root session/workstream cards;
  - `GET /api/v1/workstreams/:rootSessionId` for selected-session overview;
  - `GET /api/v1/workstreams/:rootSessionId/agents`;
  - `GET /api/v1/workstreams/:rootSessionId/attention`;
  - `GET /api/v1/workstreams/:rootSessionId/artifacts`;
  - `GET /api/v1/attention` for global attention.
- Classify server-side:
  - active;
  - needs attention;
  - recently completed;
  - historical.
- Group by root session/workstream first, then by parent/child agent tree.
- Hide old completed historical runs by default; expose them through history/search.
- Add command view model:

```ts
commands: {
  attach?: string;
  look: string;
  result: string;
}
```

### Phase 5b: React + Vite frontend

Deliverables:

- Add a React + Vite dashboard app under `packages/tango/dashboard/`.
- Serve built static assets from the Tango server.
- Replace inline HTML with the built dashboard app once the API/view models are ready.
- Suggested routes:
  - `/` root session/workstream picker;
  - `/sessions/:rootSessionId` selected session overview;
  - `/sessions/:rootSessionId/agents`;
  - `/sessions/:rootSessionId/attention`;
  - `/sessions/:rootSessionId/artifacts`;
  - `/sessions/:rootSessionId/timeline`;
  - `/global/attention`;
  - `/global/history`.
- Suggested components:
  - `AppShell`;
  - `RootSessionCard`;
  - `SessionOverview`;
  - `AgentTree`;
  - `AgentRow`;
  - `StatusChip`;
  - `AttentionInbox`;
  - `ArtifactCard`;
  - `CommandButton`.
- Basic run detail page/drawer:
  - status;
  - role/harness/mode;
  - parent/children;
  - messages;
  - artifacts;
  - refs;
  - logs/result links;
  - copyable terminal commands.
- For tmux-backed interactive agents, provide a copy button for:

```bash
cd <agent-cwd> && tango attach <agent-name>
```

- For one-shot or terminal agents, provide inspection command copy buttons where useful:

```bash
cd <agent-cwd> && tango look <agent-name> --lines 200
cd <agent-cwd> && tango result <agent-name>
```

Validation:

- Dashboard landing page shows root session/workstream cards, not a flat historical run dump.
- Opening a root session shows only the agents, attention items, artifacts, and activity under that root.
- Global history is opt-in and can show older completed runs.
- Start a root session, parent, and child agent; full lineage tree updates live.
- Interactive tmux-backed agent shows a copyable `cd ... && tango attach ...` command that works in a fresh terminal.
- Block or complete a child; selected-session attention and global attention update live.
- Publish an HTML deck; artifact appears in the selected root session and opens.

## Phase 6: Pi and Claude harness polish

Use the server from both major harnesses.

Deliverables:

- Pi extension subscribes to server events instead of spawning `tango watch` when available.
- Pi footer/list renders server-backed snapshots.
- Claude Code harness receives server endpoint/token env.
- Claude agents continue using `tango ... --json`; CLI forwards to server.
- Metrics snapshots flow to server when available.

Validation:

- Pi child status updates reach dashboard and parent session.
- Claude child status/message flows reach dashboard.
- No custom persistent Claude Code process is required.

## Phase 7: Loom integration layer

Keep Tango generic and make Loom consume Tango surfaces.

Deliverables:

- Dashboard/indexer reads Loom containers and nodes from file-based Loom storage.
- Tango refs with `provider: "loom"` are resolved by the integration layer, not Tango core.
- V1 projections are user-approved suggestions:
  - attach result to Loom node;
  - create Loom note from completed run;
  - create Loom inbox/question from blocked run;
  - link artifact to Loom node.
- Optional project config for automatic projections later.

Validation:

- Start Tango run with Loom ref and see linked node in dashboard.
- Completed run can be attached to Loom node through explicit user action.
- Loom remains usable without server.
- Tango remains usable without Loom installed/active.

## Phase 8: Docker-ready hardening

Prepare Docker deployment after host-native server proves useful.

Deliverables:

- Path mapping abstraction between host paths and container paths.
- Shared mount documentation.
- Server config for Tailnet/private binding.
- Token/auth model for dashboard and artifact URLs.
- Container image for server/dashboard only.
- Host-native agents still run outside Docker.

Validation:

- Container can read mounted `$TANGO_HOME` and workspaces.
- Dashboard serves over configured private interface.
- Artifact URLs work over Tailnet/private LAN.
- Host CLI/runner can connect to container server.

## Security defaults

- Bind to `127.0.0.1` by default.
- Require explicit opt-in for Tailnet/private interface binding.
- Require server token for write APIs.
- Use unguessable artifact URLs or per-artifact tokens.
- Serve only registered artifacts.
- Copy artifacts into controlled store by default.
- Do not expose arbitrary filesystem browsing.
- Support artifact revocation.

## Open decisions before implementation

- Whether v1 uses generated `runId` in addition to `runDir`.
- Minimal dashboard frontend stack.
- Whether artifact URLs expire by default.
- How much server state is reconstructed from existing Tango files on startup.
