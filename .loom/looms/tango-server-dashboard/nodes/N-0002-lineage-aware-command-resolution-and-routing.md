---
id: N-0002
title: Lineage-aware command resolution and routing
kind: task
state: open
parent: N-0001
summary: Lineage-aware command resolution and routing
tags: []
edges: []
created_at: "2026-04-27T00:41:30.365Z"
updated_at: "2026-04-27T01:43:59.175Z"
---







# Summary

Lineage-aware command resolution and routing

# Context


# Analysis


# Result

Pending.


# Note 2026-04-27T00:41:41.787Z

## Focus

Fix the current UX/runtime bug where a lead must `cd` to a child's cwd for `tango attach/look/result/message` to resolve, and where status notifications can route to the wrong lead session.

## Required outcomes

- Add a shared target resolver used by `attach`, `look`, `result`, `message`, `stop`, `delete`, `children`, and `wait`.
- Resolution order:
  1. direct children of current `TANGO_RUN_ID` / `TANGO_RUN_DIR`;
  2. descendants in current `TANGO_ROOT_SESSION_ID` / `TANGO_WORKSTREAM_ID`;
  3. cwd/project scope;
  4. globally unique name;
  5. ambiguity error with useful choices.
- Route status notifications by explicit lineage rather than cwd-only matching.
- Add tests/manual validation for parent and child agents in different cwd/project roots.


# Note 2026-04-27T00:43:13.295Z

## Concrete implementation plan: lineage-aware command resolution and routing

### Objective and scope

Implement a single lineage-aware target resolver and apply it to all agent-targeting commands so a lead/root session can address child agents from any cwd. Replace status/message/event filtering that relies only on cwd/project slug with explicit run/root/workstream lineage where available, while preserving legacy cwd/global lookup only as a lower-priority fallback for old metadata.

Scope is limited to Tango runtime correctness in the existing host-native/file-backed prototype. Do not introduce server auto-start, database storage, Loom-specific coupling, or dashboard UI work in this task.

### Target resolver algorithm

Add a shared resolver module, likely `packages/tango/src/targetResolver.ts`, with an interface similar to:

```ts
type ResolveTargetOptions = {
  query: string;
  cwd: string;
  currentRunId?: string;
  currentRunDir?: string;
  currentRootSessionId?: string;
  currentWorkstreamId?: string;
  includeTerminal?: boolean;
};

type ResolveTargetResult = {
  agent: AgentMetadata;
  scope: "direct-child" | "root-descendant" | "cwd" | "global" | "run-id" | "run-dir";
  candidates?: AgentMetadata[];
};
```

Resolution order:

1. **Explicit stable identifiers first when supplied by flags** (recommended addition):
   - `--run-id <id>` exact match on `AgentMetadata.runId`;
   - `--run-dir <dir>` exact normalized path match on `AgentMetadata.runDir`.
   - These are not compatibility shims; they provide deterministic escape hatches for ambiguous names and copyable dashboard commands.
2. **Direct children of the current run**:
   - Current run identity comes from `process.env.TANGO_RUN_ID` and `process.env.TANGO_RUN_DIR`, overridable internally for tests.
   - Match candidates where `(candidate.parentRunId === currentRunId)` when both exist, or legacy fallback `(candidate.parentRunDir === currentRunDir)`.
   - Then filter by `candidate.name === query` unless the command explicitly supports non-name selectors.
   - Prefer non-terminal agents only for interactive operations (`attach`, `message`, `stop`); allow terminal agents for `look`, `result`, `wait`, `delete` unless command-specific behavior says otherwise.
3. **Descendants under the current root/workstream**:
   - Restrict to `candidate.rootSessionId === currentRootSessionId` when set.
   - If `currentWorkstreamId` is set, prefer same `workstreamId`; if no same-workstream match, allow same-root match only if unique.
   - Build ancestry from `parentRunId` first and `parentRunDir` as a legacy fallback. Prefer true descendants of current run over unrelated agents in the same root; if descendant tree cannot be proven because of missing legacy fields, treat same-root candidates as lower-confidence and require uniqueness.
4. **cwd/project scope fallback**:
   - Current behavior via `listMetadata(cwd)` / project run root. This remains only for legacy/manual workflows outside a Tango run.
5. **Globally unique name fallback**:
   - Search all metadata for `name === query`; succeed only if exactly one candidate remains after command-specific terminal filtering.
6. **Ambiguity / not found**:
   - If multiple candidates remain at any scope, fail without choosing.
   - Human error text should list choices with `name`, `status`, `role`, `cwd`, `runDir`, `runId`, `parentRunId`, `rootSessionId`, and `updatedAt`.
   - JSON errors should include a machine-readable shape such as `{ ok:false, error:"Ambiguous agent target", candidates:[...] }` if existing `fail()` plumbing is extended; otherwise keep text for this task and plan JSON error shape as follow-up.
   - Ambiguity should recommend stable forms: `--run-id ...` or `--run-dir ...`.

Important behavior details:

- Always normalize paths for `runDir`, `parentRunDir`, and cwd comparisons.
- Refresh/reconcile candidates before returning so status-sensitive filters see current status.
- Do not match broad substrings by default; exact name matching avoids surprising target selection. Add fuzzy/name-prefix matching only as a separate explicit design if requested later.
- Legacy agents without `runId`/`rootSessionId` must never outrank explicit lineage matches.

### Affected CLI commands

Replace current `loadByName(name, cwd)` use with the shared resolver in:

- `look <name>`: resolve via lineage, allow terminal; show source metadata in `--json` as today.
- `attach <name>`: resolve via lineage, require `mode === "interactive"`; if stopped/terminal, fail with resolved agent details.
- `message <name> <message>`: resolve via lineage, require interactive/running tmux target.
- `stop <name>`: resolve via lineage, prefer running/created but allow idempotent terminal handling if current behavior already tolerates it.
- `delete <name>`: resolve via lineage and delete exact resolved run directory.
- `result <name>`: resolve via lineage, allow terminal/nonterminal and preserve summary fallback.
- `wait <name...>`: resolve each name once per loop using the same context; fail early on ambiguity. Consider caching resolved runDir values after first resolution so a later duplicate name from another branch cannot change the target mid-wait.
- `children [parent-name]`: if `parent-name` is supplied, resolve parent through lineage. If omitted, use current run identity. Child listing should prefer `parentRunId === currentRunId` and fallback to `parentRunDir === currentRunDir`; tree building should use both IDs and dirs.

Also update command help to document `--run-id` / `--run-dir` for target-taking commands if these flags are implemented.

### Metadata and event fields

Existing fields are mostly sufficient and should be treated as the routing contract:

- `AgentMetadata.runId`
- `AgentMetadata.runDir`
- `AgentMetadata.parentRunId`
- `AgentMetadata.parentRunDir`
- `AgentMetadata.rootSessionId`
- `AgentMetadata.workstreamId`
- `AgentMetadata.cwd`
- `AgentMetadata.status`, `role`, `updatedAt`

Events already carry the same lineage fields in `TangoEvent`. Tighten use of those fields instead of adding a new event schema version unless implementation discovers missing data. For synthetic/doctor events, add optional flags to emit `runId`, `parentRunId`, `rootSessionId`, and `workstreamId` so routing tests can cover lineage without real agents.

If changing interfaces, keep `schemaVersion: 1` only if fields remain optional additive fields; bumping schema should not be necessary for this task.

### Status/message/event routing plan

1. Replace or supplement `eventMatchesCwd(event, cwd)` with routing helpers in `events.ts`, for example:

```ts
type EventRouteContext = {
  cwd: string;
  currentRunId?: string;
  currentRunDir?: string;
  currentRootSessionId?: string;
  currentWorkstreamId?: string;
};

function eventMatchesRoute(event, ctx): boolean {
  if (ctx.currentRunId && event.parentRunId) return event.parentRunId === ctx.currentRunId;
  if (ctx.currentRunDir && event.parentRunDir) return normalize(event.parentRunDir) === normalize(ctx.currentRunDir);
  if (ctx.currentRootSessionId && event.rootSessionId) {
    if (event.rootSessionId !== ctx.currentRootSessionId) return false;
    return !ctx.currentWorkstreamId || !event.workstreamId || event.workstreamId === ctx.currentWorkstreamId;
  }
  return eventMatchesCwd(event, ctx.cwd);
}
```

2. Apply this to `tango watch` so a lead sees direct child status notifications before falling back to cwd. Keep `--all` as the escape hatch.
3. For root-session dashboard/server filtering, use `rootSessionId` and optionally `workstreamId` only; do not infer dashboard attention from cwd except in explicit legacy/history buckets handled by later dashboard nodes.
4. For command-delivered messages, the critical routing fix is target resolution before `sendTmux`; no separate message bus exists in the current CLI, so avoid inventing one here.
5. Ensure `appendStatusEvent()` continues to copy lineage from metadata. Verify all harness env builders propagate `TANGO_RUN_ID`, `TANGO_RUN_DIR`, `TANGO_PARENT_RUN_DIR`, `TANGO_ROOT_SESSION_ID`, and `TANGO_WORKSTREAM_ID`; current prototype appears to do this.

### Ordered implementation steps

1. **Inventory current call sites and data assumptions**
   - Confirm all current `loadByName()`/`findRunDir()` users in `cli.ts`.
   - Confirm `metadata.ts:listMetadata(undefined)` can enumerate all projects and old records efficiently enough for v1.
2. **Add resolver module**
   - Implement exact `runId`/`runDir`, direct-child, root-descendant, cwd, global scopes.
   - Add reusable candidate formatting and ambiguity error helpers.
3. **Wire CLI target commands**
   - Replace `loadByName()` for target-taking commands listed above.
   - Keep a thin `loadTarget(parsed,cwd,commandPolicy)` helper in `cli.ts` to reduce repeated flag/context plumbing.
4. **Update children/tree logic**
   - Use `parentRunId` as primary edge key with `parentRunDir` fallback.
   - Include resolved parent identity in JSON output (`parentRunId`, `parentRunDir`).
5. **Update event routing**
   - Add route-context helper in `events.ts` and use it in `cmdWatch`.
   - Keep `eventMatchesCwd()` for legacy fallbacks and tests.
6. **Improve doctor/test hooks**
   - Add optional doctor event flags for lineage fields, or build tests directly against `appendEvent()`/`eventMatchesRoute()`.
7. **Update help/docs strings**
   - Document new deterministic target flags and ambiguity guidance.
8. **Run validation in the separate worktree**
   - Use `/home/joe/Documents/projects/bravo-pi-mono-tango-server` on branch `tango-server-dashboard`; do not relink the active main package until rollout testing.

### Files/areas likely to change

- `packages/tango/src/cli.ts`: resolver wiring, command-specific target policies, `children`, `watch`, help text.
- `packages/tango/src/metadata.ts`: possibly keep `findRunDir()` for legacy callers but stop using it for target commands; maybe add normalized helpers if not placed in resolver.
- `packages/tango/src/events.ts`: route context helper replacing cwd-only matching for watch/server consumers.
- `packages/tango/src/types.ts`: only if new target/route types are exported from shared modules; avoid changing persisted schema unless necessary.
- `packages/tango/src/server.ts`: only if current API filters agents/events by cwd or needs root/workstream event routing for attention; defer broader dashboard view-model work to N-0003.
- `packages/tango/package.json` / test files: add Node test runner script if introducing tests.

### Architectural implications and smells

- Current `findRunDir(name,cwd)` bakes project/cwd priority into lookup and is now a smell for orchestration commands. Keep it only as a legacy primitive or remove once resolver fully replaces it.
- Resolver logic should not live inline in `cli.ts`; otherwise command behavior will drift and ambiguity fixes will be duplicated.
- Lineage routing must prefer immutable IDs (`runId`) over paths (`runDir`) because paths are legacy/environmental; `runDir` remains necessary for old metadata and local filesystem operations.
- Avoid server-dependent resolution for CLI commands in this task. CLI should continue to work from file-backed state if the server is not running.
- Do not add compatibility dual paths that preserve cwd-first behavior for active Tango runs; cwd should only be fallback when lineage context is absent or no lineage match exists.

### Validation strategy

Automated tests to add if the package test setup is acceptable:

1. **Resolver unit tests** with temporary `TANGO_HOME`/data root:
   - direct child in different cwd beats same-name cwd agent;
   - same-root descendant resolves from parent cwd without `cd`;
   - cwd fallback works outside Tango env;
   - globally unique fallback works outside Tango env;
   - ambiguous direct children or root descendants fail and list choices;
   - `--run-id` and `--run-dir` select exact targets;
   - legacy child with only `parentRunDir` resolves when `parentRunId` is absent;
   - legacy global duplicates do not silently select first.
2. **Event routing tests**:
   - event with `parentRunId === currentRunId` matches even when cwd differs;
   - unrelated same-cwd event does not match when current run lineage is available;
   - same `rootSessionId`/`workstreamId` matches dashboard/root routing;
   - fallback cwd matching works when no lineage context exists.
3. **CLI smoke tests** using built `dist/cli.js` or direct TS harness if available:
   - create fake metadata for parent/child in different cwd roots and assert `tango look child --cwd parentCwd` resolves child by lineage when env is set;
   - `tango wait child --timeout 1` uses stable resolved runDir.
4. **Manual validation**:
   - Start a lead under a root session, spawn a child in a different project cwd, then from the lead run `tango look child`, `tango message child ...`, `tango children`, and `tango wait child` without changing cwd.
   - Run `tango watch` in the lead and verify only direct child status events appear unless `--all` is used.

Always run at minimum:

```bash
cd /home/joe/Documents/projects/bravo-pi-mono-tango-server
pnpm --filter @bravo/tango check
pnpm --filter @bravo/tango build
```

If tests are added, add and run the package-specific test script as well.

### Rollout and observability risks

- **Ambiguity is newly visible**: users who relied on cwd-first accidental selection may now get an ambiguity error inside a Tango run. This is desired for safety; mitigate with clear choices and `--run-id`/`--run-dir` guidance.
- **Old metadata may lack lineage**: resolver must tolerate missing fields and classify them as fallback candidates only.
- **Event replay noise**: `tango watch --from-start` can still replay old cwd-matched events when no lineage context is present. Inside a run, lineage filters should avoid broad replay.
- **Path identity drift**: `parentRunDir` comparisons can break if paths differ by symlink/relative spelling; normalize before comparing and prefer `parentRunId`.
- **Performance**: global `listMetadata(undefined)` scans all run roots. Acceptable for v1 JSON files, but watch/wait loops should avoid excessive repeated full scans where easy (cache resolved targets in wait; event routing does not need metadata scans).
- **Server/dashboard consistency**: dashboard/API code may still present copyable cwd-based commands until N-0003/N-0004. Prefer emitting commands with `--run-id` once implemented.

### Open questions / assumptions

- Assumption: `runId` is stable and unique enough for target identity; no additional index file is required for v1.
- Assumption: exact name matching is the intended command UX; prefix/fuzzy matching is out of scope.
- Question: Should `attach/message/stop` reject terminal agents immediately or let tmux operations produce existing errors? Recommended: validate and print a clearer command-specific error.
- Question: Should `children` default to direct children only or support `--recursive`/`--tree` across descendants? Current `--tree` can show recursion; keep direct default and tree recursion.
- Question: JSON ambiguity errors may require changing `fail()` to carry structured payloads. If too invasive, implement rich text first and schedule JSON error shape later.


# Note 2026-04-27T00:44:37.411Z

## Additional requirement: notification/attention dedupe with direct inspection

Current Tango can deliver stale duplicate wake-ups when a parent has already waited on or inspected a child result. The server/control-plane design must unify event delivery, attention state, and direct inspection state.

Required behavior:

- Completion/error/block events create or update a durable attention/delivery record keyed by at least:
  - recipient run/root session;
  - target child `runId` / `runDir`;
  - event kind/status;
  - event id or status transition version.
- `tango wait`, `tango result`, dashboard result open, or explicit notification acknowledgement should mark relevant completion attention as `seen` or `handled` for that recipient.
- A later Pi/dashboard/server notification should not re-deliver a completion wake-up that is already handled for the same recipient/root session.
- Blocking/error/input/decision items may become `seen` without becoming `handled`; they should remain visible until resolved, dismissed, or superseded.
- Server/Pi delivery should use the same attention queue/state, not separate best-effort delivery files plus direct CLI reads.

Suggested states:

```ts
type AttentionState = "new" | "delivered" | "seen" | "handled" | "dismissed" | "superseded";
```

Plain `done` child completion can be auto-handled when the parent waits on or reads the result. `blocked`, `error`, and `needs=*` should require resolution or explicit dismissal.


# Note 2026-04-27T00:47:50.071Z

## Consistency update: validation command correction

Use npm workspace commands for this monorepo, not pnpm. Validation examples for this node should be:

```bash
cd /home/joe/Documents/projects/bravo-pi-mono-tango-server
npm run check --workspace @bravo/tango
npm run build --workspace @bravo/tango
```

If tests are added, add and run a package-specific npm test script, for example:

```bash
npm test --workspace @bravo/tango
```


# Note 2026-04-27T01:10:41.159Z

## Implementation complete

Added lineage-aware command resolution and routing per N-0002 scope.

### Changed files
- packages/tango/src/targetResolver.ts (new shared resolver)
- packages/tango/src/cli.ts (wired resolver into attach/look/result/message/stop/delete/children/wait; updated children/tree logic; updated watch routing; updated help text)
- packages/tango/src/events.ts (added eventMatchesLineage)
- packages/tango/src/metadata.ts (removed obsolete findRunDir)
- packages/tango/src/targetResolver.test.ts (new unit tests for resolver and isChildOf)
- packages/tango/src/events.test.ts (new unit tests for event routing)
- packages/tango/package.json (added test script)

### Validation
- npm run check --workspace @bravo/tango: pass (tsc --noEmit)
- npm run build --workspace @bravo/tango: pass
- npm test --workspace @bravo/tango: 17 tests pass, 0 fail

### Resolver behavior
Resolution order implemented exactly as specified:
1. explicit --run-id / --run-dir
2. direct children of current TANGO_RUN_ID / TANGO_RUN_DIR
3. descendants in current rootSessionId / workstreamId
4. cwd/project fallback
5. globally unique name
6. ambiguity error with useful choices

Children/tree logic now prefers parentRunId with parentRunDir fallback. Event/watch routing uses eventMatchesLineage (explicit lineage/root/workstream before cwd fallback). No Loom-specific imports or server/dashboard UI changes introduced.


# Note 2026-04-27T01:43:59.175Z

## Implementation update: remaining lineage blockers fixed

Coordinator applied direct fixes after re-review found remaining lineage fallback issues:

- Disabled cwd/global fallback when explicit lineage context is present, preventing unrelated same-project agents from being selected after lineage mismatch.
- Added metadata-backed descendant event matching so `tango watch` can recognize grandchild/great-grandchild events by walking `parentRunId` / normalized `parentRunDir` ancestry.
- Added regression coverage for same-cwd fallback suppression under lineage and metadata-backed grandchild event routing.

Validation passed in worktree:

```bash
npm test --workspace @bravo/tango
npm run check --workspace @bravo/tango
npm run build --workspace @bravo/tango
```

Result: 31/31 tests passing.
