# Codex auth balancer

The balancer owns account credentials, leases, usage normalization, and persistent SQLite state under `CODEX_AUTH_BALANCER_HOME` (normally `~/.bravo/codex-auth-balancer`).

## Re-authentication

Reset a slot's OAuth session safely with `relogin codex <slot>`. The command backs up the live credential before starting device authorization, verifies account identity, and restores the original credential on every failed or interrupted login.

## Shared live SQLite compatibility contract

> **Read this before changing schema, persistence, affinity, selection, or any live-state behavior.** The SQLite file is shared by long-lived Pi and service processes. Deployed processes may keep an older build resident while a newer process opens the same database.

- Additive nullable columns that old code neither reads nor writes are added idempotently after inspecting `PRAGMA table_info`. They **do not bump `DB_SCHEMA_VERSION`**. A version bump would make resident old readers reject their still-live shared database.
- Bump the schema version only when old readers are intentionally incompatible. Such a change requires a coordinated drain/restart and rollback plan. Never let a new build migrate the shared database before every old reader has stopped.
- Before any incompatible migration, back up the database and verify the rollback path.
- Test old-build/new-database interoperability explicitly for compatible additive changes. An old reader must continue selecting named columns, inserting rows without the new nullable field, and reading the shared schema version.
- Unknown future versions fail closed before schema creation or mutation.
- Keep `schema_metadata.schema_version` and `PRAGMA user_version` consistent. Brand-new databases initialize both to the current compatibility version.

`usage_windows.window_minutes` is the reference compatible migration: it is nullable, discovered through `PRAGMA table_info`, added only when absent, and leaves schema version 1 unchanged.

The same rule applies to the v1 integrity state added for Codex balancing:

- `session_affinity` is keyed by a state-root-scoped `session_hash` and public balanced model id. Selection reads it inside the same transaction that reserves a slot, publishes or fences the affinity generation before token prep, and only then returns a lease.
- `rate_limit_cooldowns` stores fleet-visible short 429 cooldowns. A slot that 429s before content is excluded from later selections until the cooldown expires; status/listing reads do not consume or clear the row.
- `auth_attempts` stores redacted provider-local attempt records that validate against `@bravo/auth-balancer-contract`. It intentionally does not foreign-key to reservations: observability must survive mixed tests, pruning, and partial legacy state, and must never turn a successful request into a user-visible failure.

These tables are additive schema-version-1 state. Opening an older v1 database creates them idempotently without bumping `schema_metadata.schema_version` or `PRAGMA user_version`.

During the mixed-resident rollout, new processes also mirror SQLite affinity into the old file path under `leases/affinity/`. Published mirrors carry `compatibility: "sqlite_affinity_mirror"`, `compatibility_state: "published_for_mixed_resident_versions"`, `sqlite_generation`, and a `removal_gate`. If token prep fails after publication, the mirror is atomically unlinked so a resident old process cannot resurrect the provisional slot; SQLite `session_affinity.legacy_file_removed_at` and `launch_events` keep the removal metadata. Remove the mirror path entirely only after old resident processes are known drained for a release boundary.

## Balanced model capabilities

The `bravo-codex-balanced/gpt-6-luna` model explicitly supports the `max` thinking level. Other balanced models preserve the thinking-level mappings advertised by the upstream Codex catalog.

## Selection policy

Two rules keep a usable install from refusing to serve:

- **In-flight reservations are a preference, never a quota deduction.** Concurrency is charged once, as a small score penalty (`activeReservationPenalty`), and never against a window's remaining percent. A busy slot is deprioritized; it is never excluded for being busy. Charging concurrency against quota is what turned a 7%-remaining slot into `slot unavailable by policy` after two concurrent requests.
- **The hard floors gate on real remaining quota only.** Genuine exhaustion is caught by the floors and, at runtime, by 429 rotation — not by a speculative hold.

Slot requests have two modes. An explicit `--slot` is **hard**: only that slot is considered, and an unusable one is an error. A session-affinity or rotation hint is **soft**: it wins when the slot is selectable, otherwise selection falls back to the full account set and records `preferred_slot_unavailable:<slot>` in the selection penalties. A preference must never fail a lease that another slot could serve.

## Lease lifetimes and affinity fencing

Codex token leases expose three separate lifetimes:

- `reservation_expires_at`: when this local slot reservation expires.
- `token_expires_at`: when the selected Codex access token expires.
- `affinity_expires_at`: when the session/model affinity expires.

The legacy `expires_at` field remains temporarily as a compatibility alias for `reservation_expires_at`; new code should read the explicit fields. If token prep fails after affinity publication, the provisional affinity is invalidated/expired and the mixed-version legacy mirror file is removed before any later selection can reuse it. A later fresh selection may reuse the same `(session_hash, public_model_id)` row by advancing its generation over the expired row.

## Provider transport, replay, and rotation invariants

The balanced Codex provider keeps the public saved model identity as `bravo-codex-balanced/<model>`, but normalizes prior balanced assistant messages only in the ephemeral outbound replay view to `openai-codex/<model>`. Reasoning signatures, tool-call ids, and native same-provider replay metadata must remain byte-for-byte intact.

Balanced transport is SSE-only until Pi exposes an account-aware WebSocket connection identity/cache seam. Explicit `auto`, `websocket`, or `websocket-cached` requests are degraded to SSE and recorded as `degraded_transport_selected`; the balancer must not enter Pi's session-only WebSocket cache because that cache can reuse a connection authenticated to the wrong account.

A pre-content upstream 429 observed at the response boundary records an attempt, publishes a shared cooldown, marks the current lease failed, and rotates to another slot without forwarding the suppressed 429 to the user. Error-message text alone is diagnostic only: without the observed upstream 429, it must not publish cooldown, claim `explicit_429_rejection`, or authorize replay/rotation. Once content has started, the provider does not replay or rotate the request.

## Usage windows

Normalized `UsageWindow` values expose percentages as **remaining quota**, optional reset fields, and optional `windowMinutes`. Live response metadata, probes, legacy cache entries, and recognized header fields accept `window_minutes`/`windowMinutes`; unrelated input validation remains strict. The footer derives labels from `windowMinutes` rather than assuming primary means 5 hours and secondary means one week.

## Lease service (multi-node)

Run `codex-auth-balancer serve [--port 8790]` on the account-owning hub. The listener binds **only** to `127.0.0.1`; connect remote nodes through an authenticated SSH tunnel. The persistent bearer nonce is stored at `<stateRoot>/runtime/lease-service-credential.json` (0600), reused on restart. Never expose the listener or the nonce publicly.

All endpoints use `POST`, `Authorization: Bearer <nonce>`, and `Content-Type: application/json`. Requests and responses are JSON; omitted `stateRoot` is always replaced by the hub's root. Missing/incorrect bearer returns 401 without executing the operation. Errors return `{ "error": "..." }` and a non-2xx status.

| Path | Request JSON | Response JSON |
| --- | --- | --- |
| `/startLease` | `StartTokenLeaseInput` | `TokenLease` (short-lived `access_token`, never refresh token) |
| `/finishLease` | `FinishTokenLeaseInput` | `FinishTokenLeaseResult` |
| `/ingestUsage` | `LiveUsageIngestInput` | `LiveUsageIngestResult` |
| `/publishCooldown` | `{slot, sourceAttemptId?, reason?, expiresAt}` | `CodexRateLimitCooldown` |
| `/recordAttempt` | `CodexAttemptRecord` input | recorded attempt |
| `/listSlots` | `{}` | `[{slot, primaryRemaining?, cooldownUntil?}]` |
| `/markBroken` | `{slot, code, message}` | `null` |
| `/getConservationQuota` | `{staleAfterMs?}` | `ConservationQuota[]` |
| `/getUsage` | `{staleAfterMs?}` | `CodexUsage` |

On clients, set `CODEX_AUTH_BALANCER_URL` to the tunneled loopback URL and `CODEX_AUTH_BALANCER_KEY_COMMAND` to a command printing the nonce on stdout. The key is cached in memory; HTTP 401 re-runs the command once and retries once. URL mode fails closed: no local SQLite or auth files are consulted, and a disconnected hub errors with the URL. The client streams directly from chatgpt.com using the leased access token. The hub's own Pi processes can continue using the in-process SQLite path without these env vars. Async-subagents Pi children inherit both variables; the copied-credential Codex CLI harness is unsupported in URL mode and fails closed.

## Validation

```bash
npm run check --workspace @bravo/codex-auth-balancer
npm test --workspace @bravo/codex-auth-balancer
```
