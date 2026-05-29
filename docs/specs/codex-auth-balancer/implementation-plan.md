# Codex Auth Balancer Implementation Notes

Current architecture is owned by `@bravo/codex-auth-balancer` in this monorepo. Runtime consumers import/call that package directly; account balancing does not depend on external auth-management tools.

## Runtime contracts

- Pi local extension imports `packages/codex-auth-balancer/src/index.ts` so it works without a package build.
- `packages/async-subagents` keeps importing `@bravo/codex-auth-balancer` by package name.
- `prepareLaunch()` creates a run-local isolated directory (normally `<runDir>/auth/codex-balancer`) and writes internal `balancer-metadata.json`.
- `syncBack()` uses internal metadata hashes to detect conflicts, but API/CLI/launch output must not expose token-derived auth hashes or generation values.
- `cleanupLaunch()` may recursively delete only directories prepared by this package and verified by matching metadata.
- Usage reads are SQLite-only after first open. `getUsage()` reports stale when the latest SQLite snapshot timestamp is older than `staleAfterMs` and marks returned windows stale.

## SQLite state

- Database path: `${stateRoot}/balancer.sqlite3`.
- Open pragmas: WAL journal mode, foreign keys enabled, and busy timeout.
- Schema metadata and SQLite `user_version` guard migrations.
- Tables cover account inventory, usage snapshots/windows, policy, reservations, and launch events.
- Existing JSON usage caches are migrated once on first open; schema v2 `{ accounts }` caches and older raw slot maps are both accepted. SQLite becomes authoritative afterward.

## Selection lifecycle

- `chooseSlot()` scans account files before the transaction, then opens `BEGIN IMMEDIATE` to expire old reservations, read latest usage, choose a candidate, and insert a `pending` reservation.
- `prepareLaunch()` copies auth files only after reservation creation, writes reservation/launch IDs to metadata, then marks the reservation `prepared`; prepare failures mark it `failed`.
- `syncBack()` marks reservations `completed`, `conflict`, or `failed` based on the sync-back outcome.
- `cleanupLaunch()` releases only active pending/prepared reservations, records cleanup events for terminal reservations, and removes the isolated directory.
- Async subagents now pass run ID, root run ID, and runtime TTL to reservations.

## Diagnostics

CLI JSON diagnostics:

- `db-status --json`
- `reservations --json [--all]`
- `policy --json`

## Removed dependencies

Authswap is not a supported runtime or migration dependency. The package owns account state, launch isolation, sync-back, cleanup, and usage cache refresh directly.

Usage refresh executes `codex exec` in a temporary `CODEX_HOME` containing only the selected slot's `auth.json`, then parses the newest session JSONL `payload.rate_limits` event. The persisted cache is now SQLite usage snapshots/windows with remaining percentages and millisecond reset timestamps.
