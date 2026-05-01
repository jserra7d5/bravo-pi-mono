---
id: N-0016
title: "Review: Loom coupling boundary"
kind: review
state: open
parent: null
summary: "Review: Loom coupling boundary"
tags: []
created_at: "2026-04-27T00:47:16.336Z"
updated_at: "2026-04-27T00:48:02.527Z"
edges:
  - type: reviews
    to: N-0006
---



# Summary

Review: Loom coupling boundary

# Context


# Analysis


# Result

Pending.


# Note 2026-04-27T00:48:02.527Z

## Review scope

Review N-0006 for Tango/Loom boundary correctness.

Checklist:

- No `@bravo/loom` dependency or import in `packages/tango`.
- Tango does not read/write `.loom` internals.
- Refs are provider-neutral/opaque; Loom semantics live outside Tango.
- Generic refs can represent Loom nodes but do not require Loom installed.
- Static grep/dependency checks validate the boundary.
