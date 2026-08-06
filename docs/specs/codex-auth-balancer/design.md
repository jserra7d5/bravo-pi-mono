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

- The refresh-token exchange is owned by this package (`src/codex-oauth.ts`), not delegated to `@earendil-works/pi-ai`. Pi's extension loader aliases every `@earendil-works/pi-ai*` specifier to the *hosting* Pi's copy and loads through jiti, whose CJS interop degrades a missing named export to `undefined` at the call site rather than raising a link error — so an upstream entrypoint that is emptied (as `@earendil-works/pi-ai/oauth` was in 0.81.x) fails silently at runtime while type-checking clean. The balancer already owned the refresh lock, the atomic write-back, and the claim guard; pi-ai supplied only the `fetch`. `scripts/check-pi-ai-drift.mjs` (wired into `npm run check`) fails the build whenever the declared pi-ai devDependency differs from the version the installed Pi bundles, since extensions run against the host copy.
- Refresh is *proactive*, not purely lease-driven. `ensureFreshTokens()` runs from the provider extension's `session_start` and rotates any slot whose access token expires within `PROACTIVE_REFRESH_LEAD_MS` (4 days against a ~10-day token). Lease-time-only refresh means a broken refresh path stays invisible until the token actually dies, making the first symptom a hard outage; refreshing with days of headroom turns that into an early warning. It takes the same per-slot refresh lock, re-reads under it (adopting a credential another process already rotated instead of rotating again), persists through the same shared write as the lease path, and reports failures rather than throwing. A failed attempt is recorded and retried no more than once per 6 hours so a persistently dead refresh cannot spin on every session start.
- `getSlotTokenHealth()` reports per-slot expiry and whether a slot can still refresh itself. The footer extension warns at session start for any slot that needs re-auth or is inside the expiry window, and renders an `exp <duration>` chip on the account — amber under 3 days, red under 24 hours, and absent otherwise. Because proactive refresh fires with 4 days of headroom, a visible chip means refresh is failing, not merely that time is passing.
- Lease-time OAuth refresh failures are classified through the shared `classifyOAuthRefreshError` (`src/oauth-error.ts`). A *hard* failure — `invalid_grant`, a reused/rotated refresh token, an HTTP 400/401/403, or a structurally unusable token response — durably marks the slot `broken` (via a `source: 'broken'` usage snapshot), so selection skips it and the footer badges it red. A *transient* failure (network/timeout/408/429/5xx) does **not** mark the slot broken; the provider cools it down and rotates instead.
- `broken` is self-healing: any later successful request writes a fresh `source: 'live'` `ok`/`limited` snapshot that supersedes the broken snapshot (newer `id` wins in the `latestUsageEntries` view), so a recovered account un-breaks automatically.
- `unbrickSlot(stateRoot, slot)` is the operator escape hatch: it writes a `source: 'manual'`, `status: 'unknown'` snapshot so a slot becomes selectable again without hand-editing the database.
- The footer extension exposes `/reauth <slot>`: it backs up the slot's credentials, runs `codex logout`/`codex login` against that slot's `CODEX_HOME` (surfacing and auto-opening the auth URL), seeds `pi-openai-codex.json` from the refreshed `auth.json`, then re-probes usage — a successful probe clears any `broken` status. **`/reauth` requires a local browser and is unsafe over SSH**: it runs `codex logout` first, which revokes the refresh token server-side, and its `codex login` uses the localhost callback flow that cannot complete headlessly — so a failed attempt leaves the slot strictly worse off. Headless recovery is, in order: `CODEX_HOME=<slotDir> codex exec --skip-git-repo-check "say ok"` to force a refresh through the Codex CLI (works whenever the refresh token is still live, no browser needed; `codex login status` does *not* refresh), and only if that reports the refresh token revoked, `CODEX_HOME=<slotDir> codex login --device-auth`.

Security constraints:

- Isolated directories must be absolute and safe; cleanup requires package metadata and matching isolated-dir/state metadata.
- Raw tokens, keys, token-derived auth hashes, and generation IDs are internal only and are redacted/omitted from CLI/API/log output.
- OAuth refresh failures are recorded with a non-secret `error_kind` (`invalid_grant` | `transient` | `unknown`) and an upstream message redacted through the shared `redactSecretsInText` (JWTs and `Bearer` headers stripped) before it reaches the reservation event log or stderr. The error thrown to callers remains the generic `selected slot access token refresh failed`.
- Sync-back conflicts retain the isolated directory with a marker or wrapper warning instead of overwriting newer state.

Authswap is not a supported runtime or migration dependency. Account state and usage cache are owned by this package.
