---
id: N-0006
title: Loom generic refs integration
kind: task
state: open
parent: N-0001
summary: Loom generic refs integration
tags: []
edges: []
created_at: "2026-04-27T00:41:30.368Z"
updated_at: "2026-04-27T00:43:23.827Z"
---



# Summary

Loom generic refs integration

# Context


# Analysis


# Result

Pending.


# Note 2026-04-27T00:41:42.443Z

## Focus

Integrate Loom without coupling Tango to Loom internals.

## Required behavior

- Tango stores/serves generic refs only.
- Loom consumes Tango refs/events/messages/artifacts externally.
- No Tango imports from `@bravo/loom`.
- No Tango parsing or writing `.loom` internals.
- Dashboard can later display Loom refs under selected root sessions.


# Note 2026-04-27T00:43:23.827Z

## Implementation plan: generic Loom refs integration

### Objective and scope

Allow Tango root sessions, runs, events, messages, and artifacts to carry generic external references that Loom can consume, without Tango importing `@bravo/loom`, parsing `.loom`, writing Loom files, or encoding Loom workflow semantics. Tango is a neutral reference/event transport; Loom integration remains external.

### Ordered steps

1. Define a generic reference shape in Tango types/API, e.g. `ExternalRef { type, id?, uri?, label?, source?, relation?, metadata?, createdAt, rootSessionId?, runId? }`, with `type` values treated as opaque strings such as `loom.node`, not as built-in business logic.
2. Add file-backed storage for refs under Tango state, scoped by root session/run where possible. Prefer JSON/JSONL append-friendly storage consistent with server v1 durability.
3. Add REST endpoints that are generic, not Loom-specific:
   - create/list refs for a root session and optionally a run/artifact;
   - include refs in dashboard view-model responses once N-0003/N-0004 consume them;
   - optional event emission over existing SSE as `ref.created` with opaque payload.
4. Add CLI affordance only if needed for validation, named generically (for example `tango ref add/list`) rather than `tango loom ...`.
5. Ensure artifacts can be associated with refs by ID, so a Loom node can later point at a Tango artifact URL or Tango can show that an artifact relates to an external node.
6. Add guardrails that prevent accidental coupling:
   - no dependency on `@bravo/loom` in `packages/tango/package.json`;
   - no imports from Loom packages;
   - no code that walks `.loom`, assumes `N-0001` style IDs, or writes Loom notes/events.
7. Document the integration contract for external consumers: Loom or a bridge can read Tango APIs/events and write Loom notes/artifacts itself, while Tango simply stores/display refs.
8. Coordinate UI surfacing with dashboard work: initial display can be a generic "External refs" section under selected root session; full Loom graph visualization remains out of scope.

### Files/areas likely to change

- `/home/joe/Documents/projects/bravo-pi-mono-tango-server/packages/tango/src/types.ts` — generic ref types if shared.
- `/home/joe/Documents/projects/bravo-pi-mono-tango-server/packages/tango/src/server.ts` — file-backed ref persistence, API endpoints, SSE event payloads, view-model inclusion.
- `/home/joe/Documents/projects/bravo-pi-mono-tango-server/packages/tango/src/cli.ts` — optional generic ref CLI/help.
- Dashboard/API files added by N-0003/N-0004 if ref display lands there.
- `packages/tango/package.json` — should not gain a Loom dependency.

### Acceptance criteria

- Tango can store and return opaque refs associated with a root session/run/artifact.
- Ref APIs and persisted records are generic and do not require Loom packages or `.loom` access.
- A ref with `type: "loom.node"` and `id: "N-0005"` round-trips as data, with no Tango interpretation beyond validation/sanitization.
- SSE/API responses can expose ref-created events for dashboard refresh.
- Grep/static check confirms no `@bravo/loom` import, no `.loom` filesystem parsing/writing, and no Loom-specific workflow decisions in Tango.
- Legacy sessions with no refs behave unchanged.

### Tests / validation

- Unit tests for ref validation: required type, bounded string lengths, serializable metadata, token/secret redaction if metadata is displayed/logged.
- Integration test with isolated `TANGO_HOME`: create root session, add generic ref, list refs by root/run/artifact, restart server or reload storage, verify persistence.
- Contract test that an opaque `loom.node` ref round-trips without special handling.
- Static validation in test or CI script: `grep`/dependency check for forbidden `@bravo/loom` imports and `.loom` path access in `packages/tango/src`.
- Dashboard smoke after N-0004: selected root session shows refs if present and hides section if absent.

### Risks and staging

- Schema can become accidentally Loom-shaped. Keep field names provider-neutral and place Loom-specific meaning in external bridge/docs.
- Ref metadata may contain secrets. Apply size limits, avoid logging raw metadata, and redact key names matching token/secret/password patterns.
- API proliferation could distract from core dashboard. Stage minimal storage/list/create first; postpone mutation/delete and rich graph views until a real consumer needs them.
- Event ordering with JSONL can be eventually consistent. Accept for v1 if dashboard refreshes via REST after SSE notification.
