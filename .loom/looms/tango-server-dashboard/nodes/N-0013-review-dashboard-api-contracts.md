---
id: N-0013
title: "Review: dashboard API contracts"
kind: review
state: open
parent: null
summary: "Review: dashboard API contracts"
tags: []
created_at: "2026-04-27T00:47:15.662Z"
updated_at: "2026-04-27T00:48:01.627Z"
edges:
  - type: reviews
    to: N-0003
---



# Summary

Review: dashboard API contracts

# Context


# Analysis


# Result

Pending.


# Note 2026-04-27T00:48:01.627Z

## Review scope

Review N-0003 dashboard view-model API contracts before React implementation depends on them.

Checklist:

- APIs are server-shaped and root-session-first.
- `/api/v1/dashboard`, `/api/v1/workstreams`, selected root session routes, timeline, history, and global attention are present or explicitly deferred.
- Active/attention/recent/historical/legacy classification is server-owned.
- Old runs without root metadata are hidden from current dashboard defaults and exposed through history/legacy.
- Agent forests prefer `parentRunId` and fall back to `parentRunDir`.
- Response types are stable enough for N-0004.
