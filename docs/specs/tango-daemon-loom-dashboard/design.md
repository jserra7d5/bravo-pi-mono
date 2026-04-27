# Tango Server and Loom Dashboard Design Exploration

Date: 2026-04-26
Status: exploratory draft

## Problem

Tango is evolving from a lightweight CLI wrapper around child agents into an agent orchestration runtime. Several recent design threads point at the same pressure:

- lifecycle state can become stale when a child process exits without a recorded terminal status;
- parent Pi sessions currently tail event files and can miss or replay notifications;
- metrics updates are awkward when every child independently writes metadata or shells out to the CLI;
- agent-to-agent messaging has no single delivery authority;
- Loom captures durable work structure, but there is no live dashboard that correlates Loom tasks with active Tango agent trees.

The current no-daemon architecture intentionally keeps Tango simple and file-oriented. That has been valuable for bootstrapping. However, Tango is now accumulating daemon-like behavior in distributed pieces: event watchers, reconciliation timers, delivery-state files, process supervisors, metadata snapshots, child self-reporting, and Pi extension polling.

## Goals

- Explore whether Tango should gain a persistent local server/control plane.
- Define a clean split between Tango runtime authority and Loom durable graph authority.
- Preserve file-based durability and debuggability where it is valuable.
- Support a future local web dashboard for active agent trees and Loom work graphs.
- Identify the server responsibilities that would materially simplify lifecycle coordination, messaging, artifact hosting, metrics, and event delivery.
- Avoid committing to an implementation path before the runtime/control-plane boundaries are clear.

## Non-goals

- Do not design a full production service protocol yet.
- Do not require Loom to move away from file-based storage.
- Do not require a 24/7 Docker or system daemon as the first step.
- Do not remove CLI usability or file-based recovery/debugging.
- Do not specify UI implementation details beyond the product shape and data model needs.

## Architectural smell

Tango is currently simulating a live control plane with CLIs, files, polling, and child self-reporting. The smell is not any single bug; it is that lifecycle truth, event delivery, messaging, and metrics are distributed across many short-lived processes and extension hooks.

A recurring pattern appears:

```text
The cleaner runtime solution wants one live coordinator,
but the current design compensates with more file polling,
reconciliation, dedupe, and shell-out paths.
```

This is a signal that Tango may need an explicit runtime control plane.

## Core distinction

Tango and Loom should not have the same authority model.

```text
Tango = active runtime control plane
Loom  = durable work graph and decision/task memory
```

For Tango, the server should be active and authoritative for live control-plane concerns: trees, messages, event streams, artifacts, attention state, and dashboard-visible runtime state.

Host-native Tango CLI/runner code remains authoritative for host process reality: launching Pi/Claude Code/tmux processes, observing PIDs/sessions, and applying stop/cancel operations.

For Loom, the server/dashboard should initially be read-mostly or write-through via Loom APIs/CLI, while Loom files remain the durable source of truth.

## Proposed system shape

The preferred split is a **server/control-plane process** plus **host-native agents**.

```text
Host computer
├─ Pi / Claude Code / generic agents run as normal host processes
├─ Tango CLI / thin host runner starts and supervises those processes
└─ Shared Tango/Loom/workspace files
        │
        ▼
Tango server/control plane, optionally Dockerized
        │
        ├─ web dashboard
        ├─ event streaming/subscriptions
        ├─ message routing and delivery state
        ├─ artifact registration/serving
        ├─ metrics/event aggregation
        ├─ Tango/Loom indexing and correlation
        └─ durable server-side control-plane state
                  │
                  ▼
          Loom file-based graphs
```

The server does **not** need to host or sandbox individual agent processes. Agents should continue to run on the user's computer with access to the user's normal shell, credentials, PATH, tmux, project environments, Pi, Claude Code, and local tools.

This keeps the high-friction process-runtime responsibilities on the host while moving dashboard, event streaming, messaging coordination, artifact hosting, and indexing into a stable server process.

Files remain the durable recovery and audit layer.

## Tango server responsibilities

### 1. Runtime coordination without process hosting

The server should coordinate live lifecycle state for Tango agents, but it does not have to directly spawn or host the agent processes.

A host-native runner/CLI layer remains responsible for process reality:

- launching Pi, Claude Code, generic shell, and tmux sessions on the host;
- recording host PID/tmux identity;
- observing process exits where possible;
- forwarding lifecycle observations to the server;
- applying stop/cancel requests from the server to host processes.

The server is responsible for the control-plane view:

- create and track root sessions/workstreams;
- record parent/child relationships;
- propagate root/workstream lineage to all descendants;
- track current lifecycle state;
- receive lifecycle observations from host runners and agents;
- perform or coordinate terminal status transitions;
- emit lifecycle events;
- support subtree cancellation or stopping by delegating to the host runner;
- provide current state to CLI, Pi sessions, and dashboard clients.

This still reduces reliance on ad-hoc Pi-side watchdogs and file tailing, while avoiding the friction of running host-native agents inside a container.

### 2. First-class root sessions and lineage

Tango should make root-session lineage first-class. A top-level Pi session or human CLI session may start child agents without itself being a Tango child agent. Today, nested Tango agents can be related through `parentRunDir`, but a root user-facing session does not always have a durable Tango identity. That makes it hard to answer:

```text
Show me every agent spawned under this main session.
Show me the full recursive tree for this workstream.
Cancel or inspect all descendants of this root.
Which Loom projects/nodes are active under this root?
```

The server should introduce stable root/workstream identifiers:

```json
{
  "rootSessionId": "sess_abc123",
  "workstreamId": "ws_456",
  "runId": "run_worker_a",
  "parentRunId": "run_team_lead",
  "parentRunDir": "/home/joe/.tango/runs/.../team-lead"
}
```

Recommended semantics:

- `runId`: stable identity for one Tango agent run.
- `runDir`: durable file location for that run.
- `parentRunId` / `parentRunDir`: exact tree parent for agent-to-agent lineage.
- `rootSessionId`: the top-level user/Pi/CLI session that initiated the tree.
- `workstreamId`: logical grouping that may outlive one root session and can correlate reopened sessions, dashboard views, and Loom contexts.

Lineage propagation rules:

- When a root Pi session starts, the server creates or resumes a `rootSessionId`.
- When that root starts children, each child receives the root session/workstream IDs.
- When a Tango child starts grandchildren, the child passes through the same root/workstream IDs and sets itself as `parentRunId` / `parentRunDir`.
- Dashboard rollups group by root/workstream first, then render the parent/child tree.
- Commands such as `tango children`, `tango list`, and future dashboard APIs should be able to filter by root session or workstream.

This should be first-class server state, not inferred only from cwd or event timing.

### 3. Message routing

Agent-to-agent communication is a strong reason for an active server.

The server can provide a single path for:

- send message to an agent by run directory or stable ID;
- send message to parent;
- broadcast to a child subtree;
- queue messages for temporarily unavailable targets;
- record delivery and acknowledgement state;
- expose message history to CLI and dashboard;
- escalate undelivered or unhandled messages.

This is difficult to model cleanly with only files and ad-hoc CLI invocations.

### 4. Event bus

The server should own live event delivery:

- lifecycle events;
- message events;
- metrics snapshot events;
- Loom correlation events;
- subscriber cursors;
- delivery acknowledgements where useful.

The existing `events.jsonl` can remain a durable journal, but live subscribers should not have to tail and dedupe the file directly.

### 5. Metrics aggregation

Agents can stream or periodically report metrics to the server:

- tool calls;
- active tool calls;
- token/context usage;
- cost estimates;
- last tool;
- runtime/staleness.

The server can keep latest snapshots in memory and persist periodically. This avoids high-frequency metadata writes and avoids making Pi tool hooks shell out during sensitive events.

### 6. Artifact hosting

The server should provide generic registered artifact hosting. This is separate from logs/results: artifacts are explicit user-viewable outputs that an agent wants to expose through the dashboard or a URL.

Example workflow:

```text
User: Make me an HTML slide deck walking me through this feature.
Agent: writes deck.html and assets locally.
Agent: tango artifact publish ./deck --entry deck.html --title "Feature walkthrough".
Server: copies/registers the artifact, emits artifact.created, and returns a URL.
User: opens the URL from localhost or, if enabled, another machine on Tailnet/local network.
```

Artifact surfaces should be generic:

- publish a file or directory by copying into a controlled Tango artifact store;
- optionally register a reference to an existing workspace file/directory with explicit opt-in;
- store artifact metadata: ID, title, owner run, entrypoint, MIME type, refs, creation time, visibility, expiration/revocation state;
- serve only registered artifacts, never arbitrary filesystem paths;
- emit `artifact.created` / `artifact.revoked` events;
- show artifacts in the dashboard and allow copying/opening URLs.

Safe defaults:

- bind dashboard/artifact server to `127.0.0.1` by default;
- require explicit config for Tailnet/private-interface binding;
- use unguessable artifact IDs and/or per-artifact tokens;
- copy artifacts into a controlled store by default;
- reject hidden/secret-looking paths by default;
- support revocation and deletion.

Loom can record hosted artifacts as generic references on nodes, but Tango should not know Loom artifact semantics. Tango emits the generic artifact event with external refs; Loom or the dashboard may project it into Loom notes/artifact references.

### 7. Coordination primitives

A server can later provide simple coordination primitives that are awkward with only files:

- locks or leases;
- task claims;
- queue depth/concurrency limits;
- pause/resume;
- restart policies;
- parent-directed cancellation;
- blocked/escalation queues.

These should be introduced cautiously and only when real workflows need them.

## Durable storage model

The server should not be memory-only. Important state should still be persisted in files under Tango's data root:

- root session/workstream records;
- agent metadata snapshots;
- event journal;
- result files;
- output/log files;
- message log or inbox records;
- metrics snapshots or rollups.

Recommended principle:

```text
Server = live control-plane authority
Host runner = process-runtime authority
Files  = durable recovery, audit, and offline inspection layer
CLI    = server client when available; file reader/recovery tool when not
```

This keeps Tango debuggable and avoids making a server crash catastrophic.

## Harness integration

The server should be harness-neutral. Pi, Claude Code, and generic harnesses should all be represented as the same Tango runtime entities once launched.

### Claude Code harness

The Claude Code harness is one of the strongest reasons to prefer a Tango-side server instead of harness-local extensions.

Current Claude harness constraints:

- Claude Code does not support Tango's Pi extension mechanism;
- roles with `harness: claude` reject Pi extensions;
- Tango currently disables ambient MCP servers for isolation with `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`;
- Claude-native subagents are disabled so delegation remains observable through Tango;
- orchestration is primarily through prompt instructions, environment variables, CLI calls, and the `CLAUDE_CODE_SHELL_PREFIX` shell wrapper.

Because of those constraints, Claude agents cannot rely on custom persistent code running inside Claude Code the way Pi agents can use extensions. A Tango server running outside the harness changes that boundary:

```text
Claude Code agent
  ├─ uses normal shell/CLI commands
  ├─ has TANGO_RUN_DIR / TANGO_HOME / TANGO_AGENT_NAME
  └─ talks to local Tango server through CLI, HTTP, or Unix socket

Tango server
  ├─ supervises Claude process lifecycle
  ├─ routes messages to/from Claude agents
  ├─ records status and events
  ├─ correlates runs with Loom nodes
  └─ exposes dashboard/API state
```

This gives Claude-harness agents many benefits that otherwise require unavailable custom extensions:

- reliable lifecycle supervision outside Claude Code;
- server-mediated `tango message` delivery and acknowledgement;
- live status/event subscriptions for parent sessions and dashboards;
- active parent/child tree visibility;
- Loom node correlation without relying on Claude-specific runtime hooks;
- optional metrics inferred from process/runtime events, even if detailed token/tool metrics are less available than in Pi.

The server should not require Claude Code to host a persistent process. It should treat Claude Code as a host-native child process represented in the control plane.

Possible Claude integration surfaces, in increasing sophistication:

1. Claude agents continue to use `tango ... --json`; the CLI forwards to the server when available.
2. The `CLAUDE_CODE_SHELL_PREFIX` wrapper injects server endpoint environment and can normalize shell-side Tango calls.
3. A future optional MCP server could expose Tango server operations to Claude Code, but this should not be required for v1 because the current harness intentionally disables ambient MCP servers for isolation.

### Pi harness

Pi can continue to use its extension for rich local signals, but the extension should become a server client rather than a lifecycle authority:

- subscribe to server events instead of spawning `tango watch`;
- send metrics snapshots to the server instead of writing files directly;
- render UI/footer state from server snapshots;
- route Tango tool calls through server-backed CLI/API paths.

### Generic harness

Generic/tmux harnesses should also benefit from the server because lifecycle and messaging can be coordinated outside the agent process.

## CLI relationship

Long term, the CLI should not be the core implementation that everything shells out to. Instead:

```text
Tango core library
├─ server uses core directly
├─ CLI talks to server when available
├─ CLI can read/recover from files when server is unavailable
├─ Pi extension subscribes to server events
└─ web dashboard uses server API
```

Some commands can degrade gracefully without the server:

- `tango list` can read snapshots;
- `tango result` can read result files;
- `tango look` can read logs;
- `tango doctor` can inspect files.

Other commands may eventually require the server for reliable behavior, but v1 should not auto-start it:

- `tango start`;
- `tango message`;
- live `tango watch`;
- streaming metrics;
- queue/coordination operations.

## Loom integration model

Loom should remain file-based and durable. The server/dashboard should index Loom and correlate it with Tango, not replace Loom storage.

The integration must be tight through shared protocols and references, but loose through package boundaries:

```text
Tango must not import, mutate, or understand Loom internals.
Tango exposes generalized runtime surfaces.
Loom consumes those surfaces and maps them to Loom graph semantics.
```

This preserves Loom's current runtime-agnostic model. The existing Loom agent guide explicitly treats Tango, Pi, Claude Code, Codex, or another runtime as interchangeable execution providers: Loom owns durable graph context, while the runtime owns process/session execution.

### Loom remains responsible for

- proposals;
- research;
- design alternatives;
- decisions;
- plans;
- tasks;
- reviews;
- results;
- unresolved questions;
- durable rationale and history.

### Tango remains responsible for

- which agents are alive;
- who is working on a task now;
- message delivery;
- runtime status;
- process supervision;
- logs/results for live runs;
- operational escalation.

### Integration layer responsibilities

The integration layer maps Tango runtime entities to Loom graph entities:

- a Tango run may carry an external reference to a work graph node;
- a Loom task may reference active or completed Tango runs;
- Tango status changes may update Loom task/review state;
- blocked Tango agents may create Loom inbox items or question nodes;
- completed agents may append results to Loom nodes;
- review agents may resolve Loom review nodes.

Tango should model this as generic external references, not as Loom-specific fields. Prefer an opaque reference shape such as:

```json
{
  "refs": [
    {
      "provider": "loom",
      "kind": "work.graph.node",
      "uri": "loom://tango-server/N-0042",
      "rel": "implements",
      "label": "Implement metrics persistence"
    }
  ]
}
```

Tango may store and emit this reference, but should not parse Loom node files, update Loom SQLite indexes, interpret Loom node states, or import `@bravo/loom`.

A Loom-side adapter, dashboard indexer, or user command can consume Tango events containing the generic ref and perform Loom-specific actions.

This reference can be mirrored into Loom node metadata or notes, but one side should be treated as authoritative and the other as a derived/indexed projection to avoid drift.

### Generic Tango surfaces for Loom to consume

Tango should expose generalized surfaces that any work graph or ticketing system could consume:

- stable root/workstream identity: `rootSessionId`, `workstreamId`;
- stable run identity: `runId`, `runDir`, `agentName`;
- tree identity: `parentRunId` / `parentRunDir`;
- role/harness/mode/model metadata;
- status transitions with reasons and summaries;
- message events with sender, recipient, delivery state, and optional correlation refs;
- artifacts/results/log pointers;
- metrics snapshots and staleness;
- labels/tags;
- external refs/links;
- attention events such as blocked, needs input, review requested, result available.

Loom can then project these into Loom concepts:

- `run.started + rel=implements` may annotate a task node with an active agent;
- `run.blocked` may create or update a Loom inbox item/question;
- `run.completed` may append a note or artifact reference;
- `review.completed` may resolve a review node;
- `message.escalated` may create a durable Loom inbox item.

These projections should live outside Tango core.

## Agent-to-agent communication and Loom

Loom should not be the live chat bus. Much of the operational communication around Loom tasks should flow through Tango:

```text
Loom says what work exists and why.
Tango coordinates who does it and how agents communicate while doing it.
```

Example flow:

```text
Loom task: implement metrics persistence
  ↓
Tango starts worker with loomNodeId=task-abc123
  ↓
Worker blocks and sends message through Tango server
  ↓
Parent answers or escalates
  ↓
Worker completes
  ↓
Tango event updates Loom task result/review state
```

Loom records durable outcomes. Tango carries live operational messages.

Existing Loom inbox delivery already calls `tango message` as a runtime-neutral delivery mechanism while keeping the durable inbox item canonical. A server-backed Tango would make this stronger without making Tango Loom-specific: Loom would continue to create inbox items and request runtime delivery; Tango would provide reliable message routing, queueing, delivery state, and live wakeups through generic messaging APIs.

### Package boundary rules

Tango core and server should not:

- import `@bravo/loom`;
- read or write `.loom/` internals directly;
- know Loom node kinds such as design, decision, task, review, or variant;
- mutate Loom `events.jsonl`, `index.sqlite`, or `runtime/runtime.sqlite`;
- implement Loom-specific graph traversal or readiness rules.

Loom or a separate integration/dashboard package may:

- call Tango generic APIs;
- subscribe to Tango events;
- start Tango agents with generic refs;
- deliver Loom inbox wakeups through Tango messages;
- index Tango metadata next to Loom graph data;
- write Loom notes, resolutions, inbox updates, and artifacts using Loom CLI/library surfaces.

A possible package split is:

```text
packages/tango           generic runtime control plane
packages/loom            file-based graph and Loom CLI
packages/workstream-ui   optional dashboard/indexer over both
```

## Dashboard product shape

The dashboard should be a true orchestration console, not a flat historical run table. The primary organizing unit is the **root session/workstream**. Treat each root session as its own separate project-like workspace with all children, artifacts, messages, attention items, timeline events, and future Loom references underneath it.

The recommended v1 dashboard should prioritize:

1. root session/workstream switcher;
2. selected root session overview;
3. agent forest within that root session;
4. attention inbox scoped to that root session, with an optional global attention view;
5. artifacts scoped to that root session.

Loom graph exploration is important, but it can follow once the root-session runtime substrate is solid.

Recommended navigation:

```text
/
  Root session/workstream picker

/sessions/:rootSessionId
  Overview for one root session

/sessions/:rootSessionId/agents
/sessions/:rootSessionId/attention
/sessions/:rootSessionId/artifacts
/sessions/:rootSessionId/timeline
/sessions/:rootSessionId/loom        future

/global/attention
/global/history
```

Global views are secondary. They help search and triage across sessions, but the default product path should keep each root session separate.

### 1. Root session/workstream switcher

The landing page should show one card per root session/workstream, not one row per historical agent. Each card should summarize:

- title or inferred task label;
- cwd/project;
- root session ID and workstream ID;
- active/running/blocked/error/done counts;
- latest activity time;
- active team leads or root agents;
- attention count;
- artifact count;
- linked external refs such as Loom nodes/projects, when present;
- open/resume/copy commands.

Default filtering should emphasize live work:

- active root sessions;
- sessions with blocked/error/needs-attention items;
- recently completed sessions;
- hide old historical sessions unless the user opens history/search.

### 2. Root session overview

For a selected root session, show everything under that root as one project-like workspace:

- high-level status and counts;
- active agent forest preview;
- attention inbox;
- recent messages/events;
- latest artifacts;
- copyable commands;
- future Loom/context refs.

This is the main dashboard surface. A user should be able to switch between root sessions and see an isolated view of everything happening underneath each one.

### 3. Agent forest within a root session

Show active Tango parent/child trees scoped to the selected root session:

- root agents/team leads;
- workers/scouts/reviewers;
- status, role, model, runtime;
- metrics/cost/context;
- recent messages/events;
- linked Loom projects/nodes;
- quick terminal attach commands for tmux-backed agents.

For each tmux-backed interactive agent, the dashboard should provide a copy button for a pasteable terminal command, for example:

```bash
cd /home/joe/Documents/projects/bravo-pi-mono && tango attach worker-a
```

The command should use the agent's recorded `cwd` and stable agent name or run identity. If names can collide, prefer a future run-id/run-dir attach form; until then, include the cwd so `tango attach <name>` resolves in the correct project context.

For non-interactive or completed one-shot agents, the dashboard may instead offer copy buttons for related inspection commands:

```bash
cd /home/joe/Documents/projects/bravo-pi-mono && tango look worker-a --lines 200
cd /home/joe/Documents/projects/bravo-pi-mono && tango result worker-a
```

### 4. Attention inbox

Show what needs the user's attention within the selected root session, with a separate global attention view available across all root sessions:

- blocked agents;
- child errors;
- completed agents with unread results;
- messages that need response;
- artifact review requests;
- Loom decisions pending, if Loom integration is enabled;
- review nodes pending, if Loom integration is enabled;
- tasks with no active owner.

### 5. Artifacts

Show registered artifacts by root session, run, workstream, project, and external refs:

- HTML reports/decks;
- generated docs;
- diagrams and images;
- coverage/benchmark reports;
- JSON traces;
- copied URL and open actions;
- revoke/delete controls.

### 6. Loom graph explorer

Show Loom projects as node-like explorable graphs:

- proposal → research → design → decision → plan → tasks → reviews;
- unresolved decisions;
- blocked nodes;
- stale branches;
- nodes with active agents;
- nodes with completed but unreviewed results.

### 7. Combined root-session/workstream view

For a selected root session or Loom project:

- Tango tree on one side;
- Loom graph on the other;
- selecting an agent highlights its Loom node;
- selecting a Loom task highlights active/completed Tango runs;
- attention items appear in the selected root session inbox.

Useful attention items:

- blocked agents;
- child errors;
- completed agents with unread results;
- Loom decisions pending;
- review nodes pending;
- Tango/Loom link drift;
- tasks with no active owner.

## Server deployment options

### Option A: Per-session server

Started by a root Pi session or explicit command. Exits with that session.

Pros:

- small failure domain;
- easy to introduce;
- avoids always-on service management;
- solves parent notification and active tree issues for current work.

Cons:

- no cross-session continuity unless state is reconstructed;
- not ideal for truly long-running background agents;
- multiple sessions may need coordination.

### Option B: User-level server

A persistent user service, likely managed by systemd user services or a foreground `tango server` / `tango daemon` process.

Pros:

- owns all active agents across sessions;
- enables persistent dashboard;
- best fit for long-running background orchestration;
- simpler global message/event semantics.

Cons:

- requires install/start/health/update story;
- introduces server availability as an operational concern;
- needs socket auth and version compatibility.

### Option C: Dockerized server with host-native agents

A 24/7 container with mounted Tango/Loom/workspace data roots. The container hosts the dashboard, event streaming, artifact server, indexing, and messaging control plane. It does **not** directly run individual agents.

Pros:

- explicit runtime packaging;
- easier to expose dashboard and dependencies;
- good fit for HTTP/SSE APIs;
- good fit for Tailscale/local-network access;
- clean artifact serving and dashboard deployment;
- avoids putting Pi/Claude/tmux/runtime credentials inside the container.

Cons:

- requires a host runner/CLI protocol for start/stop/lifecycle observations;
- shared mount path mapping must be explicit;
- server must avoid serving arbitrary mounted files;
- server/runner connectivity and auth become real design concerns.

This is the preferred Docker interpretation: Docker packages the server, not the agents.

### Recommendation for exploration

Prototype as a host-native Node process first:

```bash
tango server
```

The first hard problem is the control-plane contract, not packaging. A host process avoids Docker path mapping, shared mount, permissions, and host-runner connectivity issues while the APIs are still changing.

Design the server so it can later run in Docker:

- configurable `TANGO_HOME` and workspace roots;
- explicit host/container path mapping layer;
- HTTP APIs and SSE event streams;
- token/auth configuration;
- artifact store configuration;
- no dependency on direct host process access from the server.

Docker is a good target for the server/dashboard/artifact/indexing layer later, but v1 should not make Docker the primary development path.

## Open questions

- Should the server be one per user, one per project, or one per root session?
- What is the stable agent identity: name, run directory, generated UUID, or all three?
- Which commands are allowed to mutate files directly when the server is running?
- After v1, should `tango start` offer opt-in server auto-start?
- How should Claude Code and other non-Pi harnesses expose server-backed messaging and metrics without requiring harness-local persistent extensions?
- Should Loom writes happen through Loom CLI, a Loom library, or a daemon plugin?
- Which side owns Tango/Loom correlation records?
- What browser security model is acceptable for a localhost dashboard?
- What is the default artifact URL/token/expiration model?
- How should Tailnet/private-network access work?

## Risks

- A server can become a single point of failure if files are not kept recoverable.
- Dual server/file write paths can cause split-brain state if ownership is unclear.
- A web dashboard can encourage over-modeling before workflows stabilize.
- Loom integration can blur durable planning state with noisy operational chatter.
- Dockerizing too early can complicate path mapping, shared mounts, server/runner connectivity, and local development.

## Locked v1 direction

The agreed v1 direction is:

1. Implement a host-native `tango server` first. Design for future Docker deployment, but do not start Docker-first.
2. Keep host-native agents on the user's computer; do not require the server to host agent processes.
3. Use HTTP APIs plus **SSE** for server-to-client event streaming. Do not use WebSockets in v1 unless SSE proves insufficient.
4. Use explicit server startup in v1:
   ```bash
   tango server
   ```
   Do not auto-start the server from `tango start` yet.
5. Discover the server through `$TANGO_HOME/server/server.json`, with `TANGO_SERVER_URL` and `TANGO_SERVER_TOKEN` environment overrides.
6. Make root sessions/workstreams first-class. Pi extension sessions should register a root session on startup; CLI can attach to an existing/default session when available.
7. Persist server state with JSON/JSONL snapshots and journals under `$TANGO_HOME/server/` for v1. Do not introduce SQLite for Tango server state until query complexity requires it.
8. Use tokenized artifact URLs even on localhost. Bind to `127.0.0.1` by default; Tailnet/private binding is explicit opt-in.
9. Serve only registered artifacts. Copy artifacts into a controlled artifact store by default; do not expose arbitrary filesystem browsing.
10. Build a real dashboard frontend around root sessions/workstreams as project-like containers. The default view is a root-session switcher and selected-session overview, not a global historical agent dump. Include agent forest, attention inbox, artifacts, timeline basics, and run detail pages. Defer full Loom graph visualization.
11. Version APIs and events immediately with `/api/v1/...` and `schemaVersion: 1` event payloads.
12. Do not add a separate persistent host runner in v1. Use the existing host-native CLI/process launch path and add a runner only if lifecycle gaps remain.
13. Keep all durable Tango state file-backed and recoverable.
14. Make CLI and Pi extension server clients when available, with file-mode fallback for read/recovery surfaces.
15. Keep Loom file-based and integrate via generic refs plus event-driven or user-approved projections. Do not perform automatic Loom writes by default.
16. Implement in a separate git worktree and avoid rebuilding/relinking the active main package while live agents are using Tango.
17. Use React + Vite for the product dashboard. Keep any inline/server-rendered dashboard only as a temporary smoke-test bridge.

This preserves the useful simplicity of files while acknowledging that Tango's live orchestration concerns are better handled by a persistent server/control plane and a proper root-session-oriented dashboard.
