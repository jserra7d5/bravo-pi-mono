---
id: N-0018
title: Update Tango prompt modules for server and root-session semantics
kind: task
state: resolved
parent: N-0001
summary: Prompt/include/role docs updated for server/root-session semantics; validation passed
tags: []
created_at: "2026-04-27T01:51:48.099Z"
updated_at: "2026-04-27T02:38:40.099Z"
resolution: implemented
---








# Summary

Update Tango shared prompt includes and roles for server/root-session/lineage/attention semantics

# Context


# Analysis


# Result

Pending.


# Note 2026-04-27T01:51:56.321Z

## Scope: Tango prompt/common module updates for server/root-session semantics

Update Tango's reusable prompt includes, role docs, and examples so agents understand the new runtime model.

Likely files:

- `packages/tango/includes/orchestration-core.md`
- `packages/tango/includes/orchestration-cli.md`
- `packages/tango/includes/orchestration-pi-tools.md`
- `packages/tango/includes/orchestration.md`
- `packages/tango/includes/status-protocol.md`
- `packages/tango/roles/*.md`
- `packages/tango/examples/roles/*.md`
- `packages/tango/src/roles.ts` only if role assembly/docs require code changes.

Required semantic updates:

- Prefer lineage-aware commands over cwd-dependent targeting.
- Teach stable target forms: `--run-id` and `--run-dir` where available.
- Explain root session / workstream / run / parent run identity.
- Tell leads they should not need to `cd` into child cwd for `look`, `result`, `message`, `wait`, `children`; cwd remains for project-local shell commands.
- Update status/attention guidance for durable delivery state: completion may be handled by wait/result/dashboard open; blocked/error/needs remain visible until resolved/dismissed/superseded.
- Explain server v1 semantics: explicit `tango server`, HTTP+SSE, dashboard/artifact/control-plane surfaces, optional file-backed CLI mode still works.
- Claude Code harness guidance: no Pi persistent extensions; use CLI/env/server surfaces.
- Avoid Loom coupling: prompts may mention generic refs/events/artifacts but Tango should not instruct agents to manipulate Loom internals unless explicitly assigned Loom context.

Dependencies:

- `N-0002` lineage-aware command resolution.
- `N-0011` durable attention/delivery state.
- Should complete before `N-0007` rollout/compatibility testing.

Validation:

- Check prompt files for stale `cd <child cwd>` guidance.
- Check role docs for cwd-first command assumptions.
- Build Tango package if role packaging includes files in build output.


# Note 2026-04-27T01:57:50.369Z

--message Completed implementation. Changed files and validation results recorded.


# Note 2026-04-27T01:58:09.131Z

--message ## Implementation complete

### Changed files
- packages/tango/includes/orchestration-core.md — added runtime identity/lineage, stable targeting, server/dashboard/artifacts, durable attention, Loom coupling policy, Claude Code harness limitations
- packages/tango/includes/orchestration-cli.md — added --run-id/--run-dir flags to all relevant commands, stable targeting guidance, server/artifact commands, non-Pi harness guidance
- packages/tango/includes/orchestration-pi-tools.md — added lineage-aware targeting, server/dashboard, durable attention/delivery semantics
- packages/tango/includes/orchestration.md — updated aggregator with stable targeting and split-include pointers
- packages/tango/includes/status-protocol.md — added root session event scoping, durable attention record semantics
- packages/tango/roles/claude-team-lead.md — added stable targeting guidance and Claude Code CLI-only reminder
- packages/tango/examples/roles/team-lead.md — added stable targeting guidance

### Validation
- grep search: no stale 'cd into child cwd' guidance remains in roles or includes; only explicit 'do not cd' instruction exists
- grep search: all tango look/message/result/stop/attach/children references now include [--run-id] or [--run-dir]
- npm run check --workspace @bravo/tango: passed (tsc --noEmit)
- npm run build --workspace @bravo/tango: passed (tsc -p tsconfig.json)
- No code changes required for packaging; only prompt/include/role docs edited.


# Resolution 2026-04-27T01:58:16.644Z

Prompt/include/role docs updated for server/root-session semantics; validation passed


# Note 2026-04-27T02:01:36.566Z

## N-0018 review result: BLOCKED

Reviewer `n0018-prompt-semantics-review` returned BLOCKED. Direction is good, but prompt updates overclaim several not-yet-implemented capabilities.

Blocking findings:

1. Server/messaging capability is overclaimed. Server does not expose message-routing endpoints; prompts should keep agents using `tango message` CLI.
2. Pi `tango_cli` artifact support is documented but `artifact` is not in the Pi extension allowlist.
3. Dedicated Pi tools are described as stable-target-capable, but their schemas do not expose `run-id` / `run-dir`; guidance should point to `tango_cli` for stable targeting until tools expose those fields.
4. Name-only resolution order is documented inaccurately: global/cwd fallback is only when no lineage context exists.
5. Root-session semantics are overstated as generally tracked; normal CLI starts may lack rootSessionId/workstreamId unless env context is present.
6. Attention/inbox semantics are ahead of dashboard/API implementation; dashboard attention is still status-derived/TODO.
7. Generic Tango prompts introduce Loom-specific coupling; remove Loom-specific `.loom`/SQLite/frontmatter guidance from generic includes.

Required fix: reword prompts to match implemented contracts or implement missing tool/server support before documenting it. Prefer conservative prompt wording for v1.


# Note 2026-04-27T02:37:56.225Z

## N-0018 final coordinator fixes after rereview2

`n0018-prompt-semantics-rereview2` found two remaining prompt-doc overclaims. Coordinator fixed both directly:

- `packages/tango/includes/orchestration-cli.md`: `tango artifact publish` now says it registers/copies an artifact, and only includes a tokenized URL when the server is running and discoverable; otherwise it returns an artifact ID/manifest for later serving.
- `packages/tango/includes/status-protocol.md`: status transitions now say they emit Tango events, and include root-session/workstream metadata only when that metadata is present.

The remaining design/spec references to future server-client behavior are treated as future design exploration, not current role/include guidance.


# Note 2026-04-27T02:38:40.099Z

## N-0018 final targeted re-review: PASS

Reviewer `n0018-prompt-semantics-rereview3` returned PASS after coordinator fixes.

Verified:

- `packages/tango/includes/orchestration-cli.md` now says `tango artifact publish` includes a tokenized URL only when the server is running and discoverable; otherwise it returns an artifact ID/manifest.
- `packages/tango/includes/status-protocol.md` no longer states events are unconditionally scoped to root/workstream; it says lineage metadata is included when present.
- No remaining blocker in the targeted include review.
