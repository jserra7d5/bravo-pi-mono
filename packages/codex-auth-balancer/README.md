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

## Usage windows

Normalized `UsageWindow` values expose percentages as **remaining quota**, optional reset fields, and optional `windowMinutes`. Live response metadata, probes, legacy cache entries, and recognized header fields accept `window_minutes`/`windowMinutes`; unrelated input validation remains strict. The footer derives labels from `windowMinutes` rather than assuming primary means 5 hours and secondary means one week.

## Validation

```bash
npm run check --workspace @bravo/codex-auth-balancer
npm test --workspace @bravo/codex-auth-balancer
```
