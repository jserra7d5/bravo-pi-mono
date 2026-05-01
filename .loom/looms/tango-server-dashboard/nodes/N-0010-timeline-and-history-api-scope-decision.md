---
id: N-0010
title: Timeline and history API scope decision
kind: decision
state: resolved
parent: null
summary: Timeline and history APIs are in v1 scope as server-shaped view models
tags: []
created_at: "2026-04-27T00:47:15.074Z"
updated_at: "2026-04-27T00:47:40.660Z"
resolution: decided
---



# Summary

Timeline and history API scope decision

# Context


# Analysis


# Result

Pending.


# Note 2026-04-27T00:47:40.354Z

## Decision

Include timeline and history APIs in v1 dashboard view-model scope rather than forcing the React dashboard to infer them from raw agent metadata.

Add to N-0003 scope:

- `GET /api/v1/workstreams/:rootSessionId/timeline`
- `GET /api/v1/history`

Rules:

- Timeline is initially a bounded recent event projection, not a full audit explorer.
- History is opt-in and includes historical root sessions and legacy runs.
- React dashboard should consume these APIs; it should not reconstruct timeline/history classification client-side from `/api/v1/agents`.


# Resolution 2026-04-27T00:47:40.660Z

Timeline and history APIs are in v1 scope as server-shaped view models
