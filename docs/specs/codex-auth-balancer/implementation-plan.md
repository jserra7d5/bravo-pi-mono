# Codex Auth Balancer Implementation Notes

Current architecture is owned by `@bravo/codex-auth-balancer` in this monorepo. Runtime consumers import/call that package directly; account balancing does not depend on external auth-management tools.

## Runtime contracts

- Pi local extension imports `packages/codex-auth-balancer/src/index.ts` so it works without a package build.
- `packages/async-subagents` keeps importing `@bravo/codex-auth-balancer` by package name.
- `prepareLaunch()` creates a run-local isolated directory (normally `<runDir>/auth/codex-balancer`) and writes internal `balancer-metadata.json`.
- `syncBack()` uses internal metadata hashes to detect conflicts, but API/CLI/launch output must not expose token-derived auth hashes or generation values.
- `syncBack()` syncs both Codex CLI auth (`codex/auth.json` -> slot `auth.json`) and Pi provider auth (`pi-agent/auth.json` -> slot `pi-openai-codex.json`) when present.
- `cleanupLaunch()` may recursively delete only directories prepared by this package and verified by matching metadata.
- `pi-balanced` is the pilot interactive wrapper. It mirrors normal Pi config into the isolated Pi agent dir with symlinks, preserves session history with `PI_CODING_AGENT_SESSION_DIR`, launches the real `pi`, then syncs and cleans up on exit.
- Usage reads are SQLite-only after first open. `getUsage()` reports stale when the latest SQLite snapshot timestamp is older than `staleAfterMs` and marks returned windows stale.

## SQLite state

- Database path: `${stateRoot}/balancer.sqlite3`.
- Open pragmas: WAL journal mode, foreign keys enabled, and busy timeout.
- Schema metadata and SQLite `user_version` guard migrations.
- Tables cover account inventory, usage snapshots/windows, policy, reservations, and launch events.
- Existing JSON usage caches are migrated once on first open; schema v2 `{ accounts }` caches and older raw slot maps are both accepted. SQLite becomes authoritative afterward.

## Selection lifecycle

- `chooseSlot()` scans account files before the transaction, then opens `BEGIN IMMEDIATE` to expire old reservations, read latest usage, choose a candidate, and insert a `pending` reservation.
- `prepareLaunch()` copies auth files only after reservation creation, writes reservation/launch IDs plus Pi auth source hash to metadata, then marks the reservation `prepared`; prepare failures mark it `failed`.
- `syncBack()` marks reservations `completed`, `conflict`, or `failed` based on the sync-back outcome. Codex auth and Pi auth each have conflict checks before either file is replaced.
- `cleanupLaunch()` releases only active pending/prepared reservations, records cleanup events for terminal reservations, and removes the isolated directory.
- Async subagents now pass run ID, root run ID, and runtime TTL to reservations.
- The provider lease path (`startTokenLease`) defaults run ID and root run ID from the child's `ASYNC_SUBAGENTS_*` environment, so provider leases are attributable too; an explicit `run_id` on the lease input wins.
- Window semantics are keyed off `windowMinutes`, never off the `primary`/`secondary` label the upstream happened to use. The conservation taper selects the longest window of at least one day and tapers against that window's own length. A window carrying no remaining/duration/reset signal normalizes to `undefined` — unknown, not full.

## Selection policy

Policy is nine scalars. It lives in the `policy` table rather than only in each process's memory, because a resident process never sees a rebuild.

- Publication is **upgrade-only**: a build writes `version`, `json`, `published_by` and `published_at` only when its compiled `POLICY.version` exceeds the stored one. An older build never steps the published policy backwards.
- Selection merges the published policy over the running build's defaults, key by key, accepting only keys the build already knows and only as finite numbers. A corrupt row degrades to compiled defaults rather than failing a lease.
- Tie-breaks key off the published version so every process orders candidates identically regardless of build.
- A build older than the published policy is **flagged, not refused**: selection records `stale_policy_build:…` in the reservation's penalties. Failing closed on a version mismatch would brick every resident process at once.

This propagates tunables. It does not propagate changed selection *logic* — for that, a stale build is identified by the flag above and must be restarted.

## Retention

Nothing ever deleted forensic rows; the live database reached 431 MB.

- `pruneDatabase()` / `prune --json` deletes past a retention window (default 14 days).
- Never deletes an active reservation, always keeps a three-snapshot tail per slot so an idle slot cannot become `unknown`, and promotes the `migrated_usage_cache_v2` marker into `schema_metadata` before deleting any launch event.
- Deletes are chunked at 500 rows per transaction, and the result reports how many transactions were used. The write lock is released between chunks.
- **Retention is off the request path.** It briefly ran on `finishTokenLease` and took the fleet down: with no index on `launch_events(reservation_id)` the FK `ON DELETE SET NULL` made each reservation delete full-scan the whole events table, one long `BEGIN IMMEDIATE` held the write lock throughout, and because the sweep recorded completion only at the end, every lease finish started another. Run it from cron or by hand; `CODEX_BALANCER_AUTO_PRUNE=1` opts a process back in.
- `idx_launch_events_reservation` is load-bearing, not an optimisation.
- `--vacuum` is opt-in: it rewrites the database, needs free space equal to its size, and holds an exclusive lock for its duration.

## Diagnostics

CLI JSON diagnostics:

- `db-status --json`
- `policy --json` — reports the policy in force (`policy`, `selection_policy_version`) separately from what the running build compiled (`compiled`, `compiled_selection_policy_version`), plus `build` and `stale_build`. Deliberately not named `version`: that collided with the SQLite schema version in operator-facing output.
- `reservations --json [--all]` carries each selection's penalties, so `stale_policy_build:…` answers "which processes are running old code".

Interactive pilot:

- `pi-balanced [pi args...]`
- `prune --json [--older-than-days N] [--keep-per-slot N] [--vacuum] [--dry-run]`

## Removed dependencies

Authswap is not a supported runtime or migration dependency. The package owns account state, launch isolation, sync-back, cleanup, and usage cache refresh directly.

Usage refresh executes `codex exec` in a temporary `CODEX_HOME` containing only the selected slot's `auth.json`, then parses the newest session JSONL `payload.rate_limits` event. The persisted cache is now SQLite usage snapshots/windows with remaining percentages and millisecond reset timestamps.
