# Codex Auth Balancer Design

`@bravo/codex-auth-balancer` owns Codex account state, usage snapshots, account selection, launch isolation, sync-back, and cleanup safety.

Runtime callers:

- Pi footer extension imports the TypeScript source directly from this repo-local package.
- Async subagents imports the package by name and prepares a per-run `auth/codex-balancer` directory before launch.
- `pi-balanced` is a pilot interactive launcher that reserves a Codex slot, starts the real `pi` with isolated Codex/Pi auth homes, preserves normal Pi config and session storage, then syncs refreshed auth back on exit.
- Usage refresh is package-owned: each configured slot is probed through an isolated Codex CLI run and parsed from Codex session `rate_limits` events.

State model:

- Authoritative state is SQLite at `${stateRoot}/balancer.sqlite3` using WAL, `foreign_keys`, a `busy_timeout`, and schema metadata/user versioning.
- Existing JSON usage caches at `${stateRoot}/cache/usage.json` are migrated on first SQLite open, including schema v2 `{ accounts }` caches and older raw slot maps. After migration, SQLite is authoritative and refreshes do not rewrite the JSON cache.
- SQLite stores account inventory, usage snapshots/windows, policy version/config, reservations, and launch events.

Selection and reservations:

- `prepareLaunch()` performs an atomic choose+reserve with `BEGIN IMMEDIATE`; it does not probe or copy auth files while the transaction is open.
- Selection rejects broken accounts and accounts below hard floors, subtracts active reservations, applies a weekly conservation curve from `resetAt`, penalizes stale/unknown/limited accounts and active reservations, and uses a deterministic hash tie-break rather than first-sorted order.
- Reservations are active only while `pending`/`prepared` and not expired. Success, conflict, failure, cleanup, and TTL expiry move them to inactive states.
- Launch metadata includes reservation and launch IDs so `syncBack()` and cleanup can release the correct reservation.
- `prepareLaunch()` writes both `codex/auth.json` and `pi-agent/auth.json`. `syncBack()` copies both back to the selected slot with compare-and-swap conflict checks so interactive Pi OAuth refreshes are retained without overwriting newer slot state.

Security constraints:

- Isolated directories must be absolute and safe; cleanup requires package metadata and matching isolated-dir/state metadata.
- Raw tokens, keys, token-derived auth hashes, and generation IDs are internal only and are redacted/omitted from CLI/API/log output.
- Sync-back conflicts retain the isolated directory with a marker or wrapper warning instead of overwriting newer state.

Authswap is not a supported runtime or migration dependency. Account state and usage cache are owned by this package.
