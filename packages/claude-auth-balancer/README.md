# @bravo/claude-auth-balancer

A local proxy that balances Claude Code across multiple Claude subscription
accounts **without breaking prompt-cache continuity**.

Point Claude Code at it and nothing else changes:

```bash
claude-auth-balancer serve
export ANTHROPIC_BASE_URL=http://127.0.0.1:8789
```

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
   rebalancing point and the next request goes to the healthiest account.
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

Credentials come from the existing authswap layout — this package never becomes
a second owner of Claude OAuth material:

```
~/.authswap/providers/anthropic/credentials/.credentials-<n>-<email>.json
```

Slot ids are authswap account numbers, so `slot 2` here is `authswap` account 2.

### Known gap: token refresh

**Not implemented.** authswap has no refresh logic either — it relies on Claude
Code refreshing whichever account it made active, which is why idle slots go
stale within a day. Implementing refresh needs the Claude Code OAuth
`client_id`, which is not extractable from the shipped binary.

Until that is supplied, an account whose access token has expired is marked
`needs-reauth` and excluded from selection, rather than being sent to the wire
to 401. Refresh it by making it active in authswap and letting Claude Code do
the refresh.

## Commands

```
claude-auth-balancer serve    [--port N] [--allow-overage]
claude-auth-balancer status   [--model M]     # headroom, claims, live leases
claude-auth-balancer accounts                 # slots, health, token expiry
claude-auth-balancer metrics  [--days N] [--daily] [--json] [--sql "..."]
claude-auth-balancer sweep                    # drop expired lease files
claude-auth-balancer prune    [--days N]      # drop old raw metric rows
```

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
- **`x-api-key` and `anthropic-auth-token` are stripped from requests.** A box
  with `ANTHROPIC_API_KEY` exported would otherwise send a console API key
  alongside the substituted subscription bearer, and silently bill at list price.
- Bind address defaults to `127.0.0.1`. There is no authentication on the proxy
  itself, so anything that can reach the port can spend your quota — do not bind
  it to a routable interface.

## Testing

`npm test --workspace @bravo/claude-auth-balancer`

The proxy tests run against a **real local HTTP upstream** — genuine sockets,
headers, gzip, and streaming relay — with injected faults (429 on one account,
all accounts 429, expired credential, dead upstream). Nothing is stubbed inside
the code under test. No network, no credentials.
