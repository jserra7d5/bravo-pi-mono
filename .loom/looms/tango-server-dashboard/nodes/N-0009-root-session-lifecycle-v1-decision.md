---
id: N-0009
title: Root session lifecycle v1 decision
kind: decision
state: resolved
parent: null
summary: Use inferred active/attention/recent/historical/legacy lifecycle for v1; explicit archive is deferred
tags: []
created_at: "2026-04-27T00:47:14.885Z"
updated_at: "2026-04-27T00:47:40.026Z"
resolution: decided
---



# Summary

Root session lifecycle v1 decision

# Context


# Analysis


# Result

Pending.


# Note 2026-04-27T00:47:39.708Z

## Decision

Use inferred lifecycle semantics for v1 rather than requiring explicit close/archive flows before implementation.

Root/workstream classification:

- `attention`: any child agent is `blocked`/`error` or has `needs`.
- `active`: any child agent is `created`/`running`/`unknown` and no attention item outranks it.
- `recentlyCompleted`: all children are terminal but last activity is within the recent window; default recent window is 24 hours.
- `historical`: all children are terminal and last activity is outside the recent window.
- `legacy`: runs without `rootSessionId`/sufficient lineage metadata; hidden from current dashboards by default and shown through history/legacy views.

Root session records may later gain explicit `closed`/`archived` state, but v1 dashboard and APIs should not block on that. Explicit archive/close is deferred.

## CLI selection rule

When multiple active roots exist in the same cwd and a command lacks current `TANGO_ROOT_SESSION_ID`, CLI must not guess. It should use cwd fallback only for legacy behavior or require explicit stable selectors/choices.


# Resolution 2026-04-27T00:47:40.026Z

Use inferred active/attention/recent/historical/legacy lifecycle for v1; explicit archive is deferred
