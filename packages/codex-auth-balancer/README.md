# Codex auth balancer

The balancer owns account credentials, leases, usage normalization, and persistent SQLite state under `CODEX_AUTH_BALANCER_HOME` (normally `~/.bravo/codex-auth-balancer`).

## Shared live SQLite compatibility contract

> **Read this before changing schema, persistence, affinity, selection, or any live-state behavior.** The SQLite file is shared by long-lived Pi and service processes. Deployed processes may keep an older build resident while a newer process opens the same database.

- Additive nullable columns that old code neither reads nor writes are added idempotently after inspecting `PRAGMA table_info`. They **do not bump `DB_SCHEMA_VERSION`**. A version bump would make resident old readers reject their still-live shared database.
- Bump the schema version only when old readers are intentionally incompatible. Such a change requires a coordinated drain/restart and rollback plan. Never let a new build migrate the shared database before every old reader has stopped.
- Before any incompatible migration, back up the database and verify the rollback path.
- Test old-build/new-database interoperability explicitly for compatible additive changes. An old reader must continue selecting named columns, inserting rows without the new nullable field, and reading the shared schema version.
- Unknown future versions fail closed before schema creation or mutation.
- Keep `schema_metadata.schema_version` and `PRAGMA user_version` consistent. Brand-new databases initialize both to the current compatibility version.

`usage_windows.window_minutes` is the reference compatible migration: it is nullable, discovered through `PRAGMA table_info`, added only when absent, and leaves schema version 1 unchanged.

## Balanced model capabilities

The `bravo-codex-balanced/gpt-5.6-luna` model explicitly supports the `max` thinking level. Other balanced models preserve the thinking-level mappings advertised by the upstream Codex catalog.

## Selection policy

Two rules keep a usable install from refusing to serve:

- **In-flight reservations are a preference, never a quota deduction.** Concurrency is charged once, as a small score penalty (`activeReservationPenalty`), and never against a window's remaining percent. A busy slot is deprioritized; it is never excluded for being busy. Charging concurrency against quota is what turned a 7%-remaining slot into `slot unavailable by policy` after two concurrent requests.
- **The hard floors gate on real remaining quota only.** Genuine exhaustion is caught by the floors and, at runtime, by 429 rotation — not by a speculative hold.

Slot requests have two modes. An explicit `--slot` is **hard**: only that slot is considered, and an unusable one is an error. A session-affinity or rotation hint is **soft**: it wins when the slot is selectable, otherwise selection falls back to the full account set and records `preferred_slot_unavailable:<slot>` in the selection penalties. A preference must never fail a lease that another slot could serve.

## Usage windows

Normalized `UsageWindow` values expose percentages as **remaining quota**, optional reset fields, and optional `windowMinutes`. Live response metadata, probes, legacy cache entries, and recognized header fields accept `window_minutes`/`windowMinutes`; unrelated input validation remains strict. The footer derives labels from `windowMinutes` rather than assuming primary means 5 hours and secondary means one week.

## Validation

```bash
npm run check --workspace @bravo/codex-auth-balancer
npm test --workspace @bravo/codex-auth-balancer
```
