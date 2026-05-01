---
id: N-0015
title: "Review: artifact hosting security"
kind: review
state: open
parent: null
summary: "Review: artifact hosting security"
tags: []
created_at: "2026-04-27T00:47:16.112Z"
updated_at: "2026-04-27T00:48:02.221Z"
edges:
  - type: reviews
    to: N-0005
---



# Summary

Review: artifact hosting security

# Context


# Analysis


# Result

Pending.


# Note 2026-04-27T00:48:02.221Z

## Review scope

Security review for N-0005 artifact hosting before enabling private/Tailnet exposure.

Checklist:

- Only registered artifacts are served.
- Publish copies into controlled artifact store by default.
- Per-artifact token required for every artifact URL.
- Path traversal, symlink escape, and secret-looking paths are rejected.
- Revocation is durable and serving checks `revokedAt`.
- No arbitrary filesystem browsing or raw path serving.
- Non-loopback bind still requires explicit opt-in.
- Logs/events do not expose tokens or sensitive source paths.
