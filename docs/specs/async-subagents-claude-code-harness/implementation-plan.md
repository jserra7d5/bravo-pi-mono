# Implementation Plan and Open Questions

This plan is sequenced to avoid building UI/demo layers before the control-plane invariants are testable.

## Phase 1 — Schema, resolution, and parent surfaces

- Add `AgentHarness` and harness-aware definition/variant fields.
- Implement harness boundary inheritance and provenance (`notInheritedAcrossHarness`).
- Fail pre-spawn on explicit Claude `tools`, `extensions`, `thinkingLevel`, unsupported execution mode, missing normal Claude auth for `dangerous-auth`, v1 extra MCP server requests, and incompatible skills.
- Extend status/result/launch metadata types with harness fields.
- Update parent prompt module, agent catalog, and tool descriptions/schemas.
- Add tests for definition resolution, catalog rendering, prompt text, and tool schema text.

Stop/replan trigger: if existing definition resolution cannot preserve provenance cleanly, build a separate resolved-definition structure before adding Claude launch.

## Phase 2 — Claude command builder, auth/home strategy, dangerous mode, and memory posture

- Add `claudeHarness.ts` command builder.
- Generate Claude home/auth-home metadata, shell-home, bin wrapper, MCP config, task/system artifacts, and settings.
- Implement generated settings for dangerous bypass (`defaultMode=bypassPermissions`, `skipDangerousModePermissionPrompt=true`) and `--dangerously-skip-permissions`.
- Default launches must not pass `--bare`; implement normal Claude auth preflight and truthfully record whether auth uses seeded run-home or operator-home.
- Add redacted launch/preflight logs.
- Add fake command-construction and shell-home tests.

Stop/replan trigger: if Claude Code requires ambient operator home for auth and Bash subprocess HOME cannot be redirected reliably, record that limitation in metadata and TUI instead of claiming shell-home isolation.

## Phase 3 — Claude oneshot harness

- Launch fake/real Claude oneshot through existing supervisor subprocess path.
- Parse `--output-format stream-json` into terminal result.
- Add sanitized stream-json fixtures.
- Record failures with redacted stderr/stdout tails.

Stop/replan trigger: if installed Claude stream-json format differs substantially from fixtures, isolate parser by version and update validation before interactive work.

## Phase 4 — Harness-aware skills

- Implement shared skill resolver for Pi/Claude.
- Add Claude skill copy/install logic with symlink/path traversal protections.
- Record resolved skill metadata.
- Add skill success/failure/isolation tests.

Stop/replan trigger: if Claude Code skill discovery requires metadata beyond copied directory layout, update `skills.md` before continuing.

## Phase 5 — MCP child-control server

- Add CLI entrypoint `async-subagents claude-child-mcp --run-dir`.
- Implement MCP JSON-RPC stdio initialize/tools/list/tools/call.
- Implement stdio process ownership assumptions, runDir containment checks, and lineage validation.
- Implement `subagent_event`, `subagent_read_inbox`, `subagent_ack_inbox`, `subagent_complete`, `subagent_block`, and liveness tool.
- Add per-run mutation gate/file lock.
- Add concurrency and fault-injection tests.

Stop/replan trigger: if MCP stdio lifecycle under Claude differs from direct MCP tests, adjust fake-Claude conformance to mirror Claude exactly before tmux integration.

## Phase 6 — Interactive tmux transport and delivery state machine

- Add tmux-backed supervisor adapter.
- Persist transport ownership metadata.
- Implement parent message nudge through tmux send path.
- Implement delivery state machine (`queued`, `injected`, `received`, `handled`, `failed`).
- Add `ackLevel`/`ackTimeoutSeconds` handling to tool schemas and tool logic.
- Implement required tmux fake-Claude lane.

Stop/replan trigger: if tmux cannot reliably inject/read state in headless tests, do not ship interactive default; either make Claude default oneshot or choose a single alternative transport and update the spec.

## Phase 7 — Liveness, timeout, reconciliation, and cleanup

- Persist liveness fields and durable budget fields.
- Implement idle/rate-limit/comatose/stale-transport/orphan detection.
- Implement status recovery checks for tmux/helper liveness.
- Implement pause/continue/cancel over intended process group/session.
- Implement terminal-result dominance and wakeup suppression.
- Add liveness/reconciliation tests.

Stop/replan trigger: if liveness cannot distinguish comatose vs rate-limited with reliable signals, expose conservative `unknown_unhealthy` state instead of lying as `idle`.

## Phase 8 — TUI/read-model and scripted smoke

- Extend status rows, live widget, tool cards, result cards, failure cards, and wakeup envelopes.
- Add real Pi `sendMessage` wakeup boundary tests.
- Add renderer width-boundary tests.
- Add `npm run smoke:claude-harness --workspace @bravo/async-subagents` scripted smoke.
- Add optional live smoke instructions/artifact bundle.

Stop/replan trigger: if smoke requires natural-language parent model compliance, it is not a validation gate; replace it with direct extension/tool handler driving.

## Open questions

1. Should the tmux helper be extracted from Tango into a shared package, or reimplemented minimally inside async-subagents?
2. Which `--mcp-config` form is stable across supported Claude Code versions: file path or inline JSON?
3. How should macOS keychain-backed Claude auth be handled without exposing operator home?
4. Should `ackLevel="received"` be exposed to the parent prompt, or kept as an advanced/internal option to avoid misuse?

## Recommended v1 defaults

- `harness: "claude"` defaults to `mode: "interactive"`; built-in Claude variants should still declare `mode: interactive` explicitly for readability.
- No extra MCP servers except async-subagents child-control.
- Execution mode defaults to `dangerous-auth`: normal Claude auth, no `--bare`, dangerous permission bypass, best-effort non-bare memory minimization.
- Built-in target models are `claude-sonnet-5` and `claude-opus-4-8`.
- `requiresAck=true` waits for `handled`.
- Live Claude smoke remains optional; fake/MCP/tmux seams are mandatory.
