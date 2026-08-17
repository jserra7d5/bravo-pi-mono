# @bravo/claude-auth-balancer

A local proxy that balances Claude Code across multiple Claude subscription
accounts **without breaking prompt-cache continuity**.

Start it, then launch Claude Code through the local gateway:

```bash
claude-auth-balancer serve
claude-auth-balancer claude [args...]
```

Existing Claude sessions must be restarted through the launcher.

## Why affinity is the whole design

Measured across the 60 most recently modified Claude Code transcripts
(38,179 assistant requests):

```
  input_tokens                             126,535
  output_tokens                         30,331,395
  cache_creation_input_tokens           91,253,655   (100% at the 1h TTL, 0% at 5m)
  cache_read_input_tokens            9,435,905,175

  cache hit share of all input = 99.0%
  long sessions average ~260,000 cache-read tokens per request
```

99% of input is cache reads. A cache read costs 0.1x base input; a 1-hour cache
write costs 2.0x. Caches are scoped per account and per model, with no escape
hatch. So moving a live session to a different account costs **20x on its next
request** — $2.60 instead of $0.13 for a 260k prefix on Opus 5 — plus a full
prefill.

A naive round-robin balancer would pay that on *every* request. This one holds a
session on one account until it genuinely cannot serve.

## Routing rules

1. **Affinity first.** Each `(session, model)` pair is pinned to one account and
   stays there. The key is `X-Claude-Code-Session-Id` plus the request's model —
   caches are scoped per account *and* per model, so a decision about one
   model's budget must not move another model's warm prefix.
2. **The lease expires exactly when the cache does** (1 hour, sliding on each
   request). Past that the prefix is gone, so an idle session is a *free*
   rebalancing point. Fresh sessions rank accounts by spendable headroom: raw
   remaining quota minus the fraction of each server window still left. This
   spends quota that resets sooner instead of stranding it while consuming an
   account whose reset is days farther away.
3. **Evacuate at 95%, but only when it buys something.** An account at or above
   95% raw utilization stops taking new sessions and existing ones move off —
   *unless* that window resets within the cache TTL, in which case moving pays
   20x to conserve a bucket that refills on its own. If *every* account is at
   95%+, sessions stay put for the same reason.
4. **Overage is never spent silently.** Accounts with `overage-status: allowed`
   can bill real money past 100%; that path requires `--allow-overage`.
5. **429 waits before it rotates.** With a short `Retry-After`, the proxy waits
   on the warm account rather than paying a cache re-create to dodge a few
   seconds. Only a long or absent `Retry-After` rotates. Either way the client
   never sees the 429.
6. **The session is pinned at selection time**, not after the response, so a
   session's concurrent opening requests (`/v1/messages` and `count_tokens` fire
   ~20ms apart) cannot split across two accounts and both pay a full cache write.

## Quota model

Four claims are visible on subscription responses:

| Claim | Meaning |
|---|---|
| `5h` | rolling 5-hour window |
| `7d` | rolling weekly |
| `7d_oi` | **Fable only** — its own weekly sub-budget (up to 50% of weekly) |
| `overage` | org-level; may be `rejected` / `org_level_disabled` |

`representative-claim` names the claim actually binding for that account.

**Fable burns general quota at 2x, and its budget is half-sized.** Every claim
is normalized into the same unit — Opus-equivalent requests as a fraction of the
general weekly budget `B`, at request cost `c`:

```
general claim, remaining r     ->  r·B / (2c)         ->  r / 2
7d_oi,         remaining r_oi  ->  r_oi·0.5·B / (2c)  ->  r_oi · 0.5 / 2
```

The `0.5` is the Fable cap as a fraction of weekly, taken from the response's
own `anthropic-ratelimit-unified-fallback-percentage` (observed 0.5 on both
accounts, every model) and falling back to the model table. Skipping it treats a
half-sized budget as full-sized and reads **4x too generous** on Fable — and
makes cross-account ranking meaningless whenever one account binds on `7d_oi`
and another on `7d`.

The 95% evacuation threshold reads **raw utilization**, not model-scaled
headroom: "is this account nearly spent?" is a question about the plan's meter,
not about how fast the requested model happens to burn it.

### Usage refresh and reset projection

Inference response headers are authoritative quota observations. Before a fresh
session is pinned—or stale/absent quota would cause an evacuation or exhaustion
decision—the proxy may refresh due slots with:

```
GET /api/oauth/usage
Authorization: Bearer <that slot's canonical OAuth token>
anthropic-beta: oauth-2025-04-20
```

This is a small account-usage read, not an LLM/messages call, so it spends no
model tokens. The selected slot is token-refreshed first and its canonical
credential is reread before the GET. Probes have an absolute wall-clock deadline covering headers and
the complete response body, plus a body-size limit. Concurrent requests for one
slot share one in-flight probe, and failures or 429s persist a per-slot backoff.
They never fail an otherwise serviceable client request. Any selection that
preserves a serviceable warm affinity never waits for a probe.

The probe maps only known legacy `five_hour` and `seven_day` windows into the
existing `5h` and `7d` claims, converting the endpoint's validated 0..100
percentage points into internal 0..1 fractions. A window with invalid or missing
utilization/reset is skipped rather than partially overwriting a prior claim.
Model-specific legacy buckets are not assigned invented semantics. A response-header
observation wins over any older probe that finishes later.

When a persisted known window has passed its reset, the balancer projects its
utilization to zero and advances its reset by the known 5-hour or 7-day cadence.
Crossing a persisted known-window reset makes a probe due even when the
observation timestamp itself is recent. The projected next reset still
participates in spendable-headroom pacing. Thus
a just-reset account is available again, but is not incorrectly treated as if
its entire new window should be spent immediately. This is a projection until
a probe or inference response supplies a fresh server observation.

## Usage metrics

Every proxied request is recorded to SQLite at
`~/.bravo/claude-auth-balancer/metrics.sqlite3`, attributed to the account that
actually served it. This is the piece Claude Code cannot give you: its
transcripts carry rich per-request usage but **no account identity at all**.

```bash
claude-auth-balancer metrics --days 7           # per account/model table
claude-auth-balancer metrics --daily --days 30  # JSON series for charting
claude-auth-balancer metrics --json             # machine-readable summary
claude-auth-balancer metrics --sql "SELECT ..." # arbitrary read-only query
```

Two tables:

- `requests` — one row per request: tokens (input/output/cache-read/cache-write),
  equivalent USD cost, latency, endpoint, decision, session hash, and the claim
  utilizations observed on that response. Pruned after 30 days.
- `usage_daily` — `(day, slot, model)` rollup. Small enough to keep forever, so
  long-range charts survive pruning.

Costs are **equivalent first-party API list prices**, not subscription billing.
They are the honest unit for comparing accounts, models, and sessions, and for
valuing the cache: each row carries both `cost_usd` and `uncached_usd`.

This deliberately avoids the failure mode of the Codex balancer's database,
which grew ~1 GB/year because nothing pruned it and its hot foreign key had no
index. Here there are no foreign keys, every filter column is indexed, and the
prune is a ranged `DELETE`.

## Credentials

Authswap slot files are the sole OAuth credential owners:

```
~/.authswap/providers/anthropic/credentials/.credentials-<n>-<email>.json
```

Slot ids are authswap account numbers, so `slot 2` here is `authswap` account 2.
The balancer never reads or writes `~/.claude/.credentials.json` or Claude's
settings. `claude-auth-balancer claude [args...]` launches the real `claude`
executable with this child-only environment block:

```
ANTHROPIC_BASE_URL=http://127.0.0.1:8789
ANTHROPIC_API_KEY=claude-auth-balancer-local-gateway
```

Override the URL for a non-default daemon port with
`CLAUDE_AUTH_BALANCER_URL=http://127.0.0.1:<port>`. If launcher resolution is
ambiguous, set `CLAUDE_BIN` to the absolute real Claude executable. All Claude
arguments, cwd, stdio, exit status, and signal termination are preserved.

The API-key value is a documented, non-secret mode selector. It makes Claude
Code send requests without requiring local OAuth state; the proxy strips it and
injects the selected canonical OAuth token. It never goes upstream.

### Token refresh

The balancer refreshes its own tokens, so idle slots stay usable. Without this
only the account Claude Code happens to have made active in authswap stays
fresh — the other slots expire within ~12h, and a balancer with one live
account is just one account.

The endpoint, client id, and scope set were read out of the shipped Claude Code
binary rather than guessed:

```
POST https://platform.claude.com/v1/oauth/token
Content-Type: application/json

{"grant_type":"refresh_token","refresh_token":"...",
 "client_id":"9d1c250a-e61b-44d9-88ed-5944d1962f5e",
 "scope":"user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"}
```

Two details are load-bearing. The body is **JSON**, not form-encoded. And the
response **may omit `refresh_token`**, which means unchanged rather than
revoked — Claude Code's own destructure is `{refresh_token: d = e}`. Observed
behaviour is that Anthropic does rotate it on every call, so the omission path
is a safety net rather than the norm.

Refresh happens 30 minutes ahead of expiry, never reactively on a 401: a 401
mid-generation is unrecoverable, because the client already has a 200 and part
of the body. A background sweep covers idle slots, which reactive refresh
never could — an expired account is not selected, so nothing would trigger it.

Failures are classified. `terminal` (400/401/403) means the grant is dead and
only re-auth fixes it; the slot backs off for an hour. Everything else,
including 429 and every 5xx, is `transient`: the credential file is left
byte-identical and the same refresh token is retried. Sanitized per-slot refresh
warnings persist in independently owned files under the balancer state root and appear in
`status`, `accounts`, and the width-bounded statusline; successful recovery
clears them. Tokens are never included. `needs-reauth` means no credential, or
an expired access token with no live refresh token behind it.

## Running it as a daemon

```bash
claude-auth-balancer install-service            # systemd user unit, then start
claude-auth-balancer install-service --port 9000 --allow-overage
sudo loginctl enable-linger "$USER"             # once, to survive logout
CLAUDE_AUTH_BALANCER_URL=http://127.0.0.1:9000 claude-auth-balancer claude
```

`--allow-overage` is baked into the unit rather than left to a runtime flag.
Overage spends real money past 100%, and a daemon is precisely the thing nobody
is watching.

One balancer per state root is enforced with a pid lock taken before the port
is bound. A port collision is not enough of a guard: two `serve` invocations on
different ports both bind happily and then share one state root, which is the
configuration that the in-process atomicity of selection and lease-pinning does
not cover. A lock whose pid is gone is taken over automatically.

## Commands

```
claude-auth-balancer serve    [--port N] [--allow-overage]
claude-auth-balancer status   [--model M]     # headroom, claims, live leases
claude-auth-balancer accounts                 # slots, health, token expiry
claude-auth-balancer refresh                  # refresh near-expiry slots now
claude-auth-balancer metrics  [--days N] [--daily] [--json] [--sql "..."]
claude-auth-balancer sweep                    # drop expired lease files
claude-auth-balancer prune    [--days N]      # drop old raw metric rows
claude-auth-balancer claude [args...]           # launch client through gateway
claude-auth-balancer install-service   [--port N] [--allow-overage]
claude-auth-balancer uninstall-service
```

## Transport timeouts

Connecting, TLS negotiation, and waiting for upstream response headers are
bounded to 90 seconds by default (`upstreamHeaderTimeoutMs` in the programmatic
API). Once headers arrive, streaming responses are not subject to that deadline,
so long generations remain safe. Pre-header failures log only safe diagnostics:
phase, error code/syscall, elapsed duration, and reused-socket state. Requests
are not blindly retried, especially `/v1/messages`, where replay could duplicate
work or spend quota twice.

## What the proxy does not do

It never rewrites a request body. Anthropic's prompt cache is a prefix match
over `tools` -> `system` -> `messages`, and the invalidation hierarchy means
touching `tools` or `system` invalidates everything after it. Only the
`Authorization` header changes.

## Security

The proxy attaches a live OAuth bearer token to whatever it connects to, so the
request target is validated before any account is selected:

- **Only origin-form targets are accepted.** Node passes `req.url` through
  verbatim, so an absolute-form request line (`POST http://evil/steal HTTP/1.1`)
  from any local process would otherwise redirect a token off-origin. This was
  reproduced against an earlier revision; it now returns 400 before the
  credential store is touched, with a second origin check at forward time.
- **`x-api-key` and `anthropic-auth-token` are stripped from requests.** This
  includes the non-secret gateway selector set by the `claude` launcher; it
  is consumed locally and can never displace the injected subscription bearer
  or reach Anthropic.
- Bind address defaults to `127.0.0.1`. There is no authentication on the proxy
  itself, so anything that can reach the port can spend your quota — do not bind
  it to a routable interface.

## Testing

`npm test --workspace @bravo/claude-auth-balancer`

The proxy tests run against a **real local HTTP upstream** — genuine sockets,
headers, gzip, and streaming relay — with injected faults (429 on one account,
all accounts 429, expired credential, dead upstream). Nothing is stubbed inside
the code under test. No network, no credentials.
