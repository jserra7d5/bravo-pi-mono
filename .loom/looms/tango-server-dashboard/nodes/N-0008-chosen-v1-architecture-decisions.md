---
id: N-0008
title: Chosen v1 architecture decisions
kind: decision
state: resolved
parent: null
summary: Locked v1 architecture decisions for server, dashboard, persistence, security, and Loom boundary
tags: []
created_at: "2026-04-27T00:47:14.704Z"
updated_at: "2026-04-27T00:47:39.388Z"
resolution: decided
---



# Summary

Chosen v1 architecture decisions

# Context


# Analysis


# Result

Pending.


# Note 2026-04-27T00:47:39.070Z

## Decision

The v1 implementation is locked to the following architecture:

- Host-native Node `tango server` first; Docker-compatible later but not Docker-first.
- Agents remain host-native on the user's machine; server/dashboard does not host Pi/Claude/tmux processes.
- HTTP `/api/v1/...` APIs plus SSE for server-to-client event streaming; no WebSockets in v1 unless SSE proves insufficient.
- Explicit `tango server` startup; `tango start` does not auto-start the server in v1.
- Server discovery via `$TANGO_HOME/server/server.json`, with `TANGO_SERVER_URL` and `TANGO_SERVER_TOKEN` env overrides.
- JSON/JSONL file-backed server state under `$TANGO_HOME/server/`; no Tango server SQLite in v1.
- Root sessions/workstreams are first-class and are the primary dashboard/product unit.
- React + Vite is the chosen dashboard frontend stack; inline HTML is only a temporary smoke-test bridge.
- Artifact hosting is registered/copy-by-default/tokenized/localhost-first.
- Loom integration is through generic refs/events/messages/artifacts only; Tango must not import or parse Loom internals.
- Implementation remains in the separate worktree until explicit rollout testing.

## Rationale

These choices preserve host-native agent ergonomics, avoid disrupting live agents, keep durable file recovery, and provide a real control-plane/dashboard path without prematurely committing to Docker, WebSockets, SQLite, or Loom coupling.


# Resolution 2026-04-27T00:47:39.388Z

Locked v1 architecture decisions for server, dashboard, persistence, security, and Loom boundary
