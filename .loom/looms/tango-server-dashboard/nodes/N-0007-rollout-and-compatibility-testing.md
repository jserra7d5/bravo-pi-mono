---
id: N-0007
title: Rollout and compatibility testing
kind: task
state: open
parent: N-0001
summary: Rollout and compatibility testing
tags: []
edges: []
created_at: "2026-04-27T00:41:30.369Z"
updated_at: "2026-04-27T03:35:59.901Z"
---




# Summary

Rollout and compatibility testing

# Context


# Analysis


# Result

Pending.


# Note 2026-04-27T00:41:42.604Z

## Focus

Protect live Tango users while implementing and testing.

## Required behavior

- Continue implementation in separate git worktree.
- Do not rebuild/relink active main package while live agents are using Tango unless explicitly testing rollout.
- Test with isolated `TANGO_HOME` for server/dashboard changes.
- Validate old no-server CLI behavior still works.
- Validate old metadata without `runId`/`rootSessionId` degrades to legacy/history buckets.


# Note 2026-04-27T00:43:23.997Z

## Implementation plan: rollout and compatibility testing

### Objective and scope

Protect active Tango users and live agents while server/dashboard changes are implemented in the separate worktree. Validate that new server/root-session behavior coexists with old no-server CLI behavior and old metadata, without rebuilding or relinking the active main package except during an explicit rollout test window.

### Staging plan

1. Worktree isolation:
   - implement only in `/home/joe/Documents/projects/bravo-pi-mono-tango-server` on branch `tango-server-dashboard`;
   - keep `/home/joe/Documents/projects/bravo-pi-mono` as the active live workspace untouched for source edits/build outputs;
   - check `git status` in both worktrees before and after changes.
2. Test-home isolation:
   - run all server/dashboard tests with a temp `TANGO_HOME`;
   - use random/free local ports or port `0` when supported;
   - never point tests at the user's real `$TANGO_HOME`.
3. Baseline compatibility pass before major changes:
   - run existing Tango CLI tests/build in the feature worktree;
   - manually verify `tango start/list/look/message/stop` no-server path still works or dry-run equivalents if spawning real agents is too heavy.
4. Incremental feature validation:
   - artifact/security tests from N-0005;
   - generic ref storage/API tests from N-0006;
   - dashboard view-model and React smoke from N-0003/N-0004;
   - lineage resolver/routing tests from N-0002 where they overlap with compatibility.
5. Legacy metadata fixture pass:
   - create fixture metadata missing `runId`, `rootSessionId`, and `workstreamId`;
   - verify dashboard/API classifies it into legacy/history buckets, not active root-session views;
   - verify command resolution can still fall back to cwd/global uniqueness where required by N-0001.
6. Explicit rollout rehearsal:
   - install/run the feature build from the feature worktree in a disposable shell only;
   - start server with isolated `TANGO_HOME`, create root session, publish/revoke artifact, add generic ref, open dashboard;
   - stop server and confirm discovery file cleanup/replacement behavior is sane.
7. Only after successful isolated rehearsal, schedule any test against the active package with a clear stop condition and rollback command. Do not relink/rebuild live package opportunistically.

### Files/areas likely to change

- Test files under `/home/joe/Documents/projects/bravo-pi-mono-tango-server/packages/tango` once the existing test framework is identified.
- `packages/tango/src/cli.ts`, `server.ts`, `metadata.ts`, `events.ts`, `types.ts` indirectly through feature work.
- Package scripts/config only if needed to add targeted tests; avoid global build pipeline churn.

### Acceptance criteria

- All new and existing targeted tests pass in the feature worktree with isolated `TANGO_HOME`.
- Old no-server CLI workflows still work when no `tango server` discovery file or env override is present.
- `TANGO_SERVER_URL`/`TANGO_SERVER_TOKEN` override behavior does not break CLI commands that should remain local-only.
- Old metadata with missing lineage fields is tolerated and classified as legacy/history, not dropped or misattributed to current root sessions.
- Feature work can be run without touching the active live workspace or real Tango home.
- Rollback is simple: stop feature server, unset `TANGO_SERVER_*`, discard temp `TANGO_HOME`, return to existing active binary/link.

### Tests / validation matrix

- Build/typecheck: package-level TypeScript build for `packages/tango` in the feature worktree.
- Existing behavior: `list`, `look`, `children`, `message`, `wait`, `stop` tests or manual dry-run fixtures without a running server.
- Server discovery: no discovery file, valid discovery file, stale PID/port, env URL/token override, wrong token.
- Artifact security: valid token, wrong token, revoke, traversal, secret-looking paths, source deletion after publish.
- Generic refs: create/list/persist generic refs; static no-Loom-coupling check.
- Dashboard/API: root-session picker excludes legacy by default; global history includes legacy; SSE reconnect/refresh does not corrupt state.
- Cross-cwd lineage: parent can target direct child by lineage while cwd differs; ambiguous legacy names produce choices rather than wrong target.

### Risks and mitigations

- Live agent disruption from package relink/build artifacts: keep worktree and `TANGO_HOME` isolated; do not run global link until explicit rollout test.
- Port/discovery collisions with a real server: prefer env overrides and temp homes; log the discovery path used in manual smoke commands.
- Backward-compatibility drag can create shims. Prefer direct new behavior; only add compatibility for verified retained workflows: old no-server CLI and old metadata classification.
- Tests that spawn real tmux/agents may be flaky. Use metadata fixtures and dry-run where possible, reserve one manual end-to-end smoke for release readiness.

### Open questions / assumptions

- Exact test runner/package script must be confirmed before implementation.
- Root session lifecycle states are still open in N-0001; compatibility tests should assert classification behavior, not final archive policy.
- Active package rollout timing requires user approval because live agents are present.


# Note 2026-04-27T03:35:59.901Z

## N-0007 rollout and compatibility pass

Implemented rollout compatibility tests/docs and fixed review blocker.

Coverage added/validated:
- CLI read-only commands (`tango list --json`, `tango roles list`) work without server discovery and do not create discovery state.
- `tango start --dry-run` does not auto-start or create server discovery state.
- `TANGO_SERVER_URL` / `TANGO_SERVER_TOKEN` override file discovery for reads.
- `tango server` shutdown removes its own discovery file even when env discovery overrides are set, avoiding stale file discovery leaking into later artifact URLs.
- `tango artifact publish` returns no URL without server discovery and returns tokenized URL with discovery.
- Built dashboard static assets serve from the server.
- README now documents server/dashboard rollout checks.

Validation:
```bash
npm test --workspace @bravo/tango   # 123 tests pass
npm run check --workspace @bravo/tango
npm run build --workspace @bravo/tango
```

Reviewer `n0007-rollout-compat-rereview`: PASS.

Final smoke passed with built CLI:
- `/api/v1/health`
- discovery file written
- dashboard HTML
- `/api/v1/dashboard`
- published artifact tokenized URL serves content
- wrong artifact token returns 404
