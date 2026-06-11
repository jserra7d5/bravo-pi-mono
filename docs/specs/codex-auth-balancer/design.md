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

Credential health and recovery:

- Lease-time OAuth refresh failures are classified through the shared `classifyOAuthRefreshError` (`src/oauth-error.ts`). A *hard* failure — `invalid_grant`, a reused/rotated refresh token, an HTTP 400/401/403, or a structurally unusable token response — durably marks the slot `broken` (via a `source: 'broken'` usage snapshot), so selection skips it and the footer badges it red. A *transient* failure (network/timeout/408/429/5xx) does **not** mark the slot broken; the provider cools it down and rotates instead.
- `broken` is self-healing: any later successful request writes a fresh `source: 'live'` `ok`/`limited` snapshot that supersedes the broken snapshot (newer `id` wins in the `latestUsageEntries` view), so a recovered account un-breaks automatically.
- `unbrickSlot(stateRoot, slot)` is the operator escape hatch: it writes a `source: 'manual'`, `status: 'unknown'` snapshot so a slot becomes selectable again without hand-editing the database.
- The footer extension exposes `/reauth <slot>`: it backs up the slot's credentials, runs `codex logout`/`codex login` against that slot's `CODEX_HOME` (surfacing and auto-opening the auth URL), seeds `pi-openai-codex.json` from the refreshed `auth.json`, then re-probes usage — a successful probe clears any `broken` status.

Security constraints:

- Isolated directories must be absolute and safe; cleanup requires package metadata and matching isolated-dir/state metadata.
- Raw tokens, keys, token-derived auth hashes, and generation IDs are internal only and are redacted/omitted from CLI/API/log output.
- OAuth refresh failures are recorded with a non-secret `error_kind` (`invalid_grant` | `transient` | `unknown`) and an upstream message redacted through the shared `redactSecretsInText` (JWTs and `Bearer` headers stripped) before it reaches the reservation event log or stderr. The error thrown to callers remains the generic `selected slot access token refresh failed`.
- Sync-back conflicts retain the isolated directory with a marker or wrapper warning instead of overwriting newer state.

Authswap is not a supported runtime or migration dependency. Account state and usage cache are owned by this package.
