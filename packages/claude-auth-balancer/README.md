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
   stays there until compaction or lease expiry. The key is `X-Claude-Code-Session-Id` plus the request's model —
   caches are scoped per account *and* per model, so a decision about one
   model's budget must not move another model's warm prefix.
2. **The lease expires exactly when the cache does** (1 hour, sliding on each
   request). Past that the prefix is gone, so an idle session is a *free*
   rebalancing point. Completed compaction also ends every model lease for that
   session: its next request ranks fresh and establishes a new lease. Fresh picks for every model **pace the weekly**: they go
   to the healthy, non-overage account furthest ahead of pace, where "ahead of
   pace" is model-normalized weekly headroom minus the share of the window's
   expected demand still ahead (clock time without a demand model). On a 20x Max plan the `5h` window is 4x a 5x plan's but the
   weekly is only 1.7x, so the weekly is the scarce budget; pacing brings every
   account to its reset near-empty together instead of draining the earliest
   reset to the floor while a later one leaves half a week unspent. Non-Fable
   picks also **hold back the general weekly that Fable can still use**:
   remaining `7d_oi` times its share of the weekly is subtracted from their
   spendable headroom, so Opus and Sonnet prefer accounts whose Fable budget is
   already spent. Ties break on raw headroom, then earliest known reset, then
   stable slot order. The `5h` and `7d` claims remain hard gates. The ceiling
   in (3) filters this pool first and the terms in (4) and (5) rank ahead of
   pacing.
3. **95% blocks fresh picks for every model; only Fable evacuates a warm one.**
   An account at or above 95% raw utilization on a claim the requested model is
   gated on takes no new sessions. Existing non-Fable `(session, model)` leases
   hold straight through it — at 95%, at 99%, through every positive amount of
   model-relevant quota — and move only on exhaustion, rejection, or unusable
   auth/token state, because the cache is worth more than the sliver of quota
   left elsewhere. Fable additionally preserves spendable-headroom ranking and
   proactive evacuation of warm sessions at 95%, including its `7d_oi` gate.
   The ceiling is dropped entirely when every serviceable account is above it:
   at that point moving buys no quota, so ranking decides and the sticky slot
   keeps its cache. A window that refills within the cache TTL never triggers
   the ceiling either, and neither does a **weekly** window in its terminal
   stretch or with surplus. See (6).
4. **Fresh picks spread on a 25%-wide projected `5h` bucket, then drain the
   earliest weekly reset, then pace.** Warm sessions hold through the hard
   ceiling, so with many concurrent sessions one target would collect every
   fresh session until 95%. That caps throughput at one `5h` window, and the
   whole herd later exhausts it — and migrates — together, each arrival paying
   a ~20x cache write on the next account. A single threshold only moves that
   cliff. So fresh picks (all models) sort first on `floor(projected / 0.25)`, where
   `projected` is the utilization the window will reach at its reset if the
   average burn rate so far continues (`utilization / elapsed`, capped at
   100%): 60% with thirty minutes left is cooler than 30% with four hours left.
   Under 30 minutes into a window the raw level is used. Within a bucket the
   weekly reset, floored to whole days, decides: that quota has the nearest
   deadline. Within a reset day pacing decides. Weekly quota actually at risk
   of expiring is the surplus term's job (5), which outranks the bucket. The
   bucket ranked behind the reset day until 2026-09-23; that sent every fresh
   session to one account's `5h` window at full load. Several warm sessions can each pass the pull's
   fit check against one expiring account before its claims update. Neither term excludes: a later reset or a hotter bucket is
   still selected when it is the only one. A `5h` window that refills within
   the cache TTL buckets as cool. An unobserved account sorts first so it gets
   probed. Warm affinity and eligibility are unaffected.
5. **Weekly quota the demand cannot reach outranks everything, affinity
   included.** Each account's *surplus* is the part of its general weekly
   remainder that the demand forecast (see [Demand model](#demand-model))
   cannot burn before its reset. Accounts are taken in reset order, earliest
   first; each absorbs the forecast demand left before its reset, capped per
   hour by what its own `5h` window can burn (`5h` size × `k` / 5h), so a 5x's
   quarter-size window limits it even when demand is plentiful. An account
   with at least 0.01 W20 of surplus, headroom left, and below the ceiling is
   `EXPIRING` in `status`. Fresh picks for every model go there first, ahead
   of the `5h` bucket; between two, the earlier reset wins.

   Moving a **warm** session there is the one planned break of a serviceable
   hold, so it needs more: 0.1 W20 of surplus, 0.1 of plan-scaled headroom (a
   5x needs 40% of its own `5h` left), a session that fits (its measured burn
   over the last hour must fit in the target's remaining `5h` window for the
   next hour), and a lease at least 6 hours on its current slot. The cooldown
   stops a session bouncing between accounts that take turns expiring. A
   session already on an expiring account holds.

   The pull lands sessions on an account just before its weekly reset, and
   the new week there has the latest deadline in the fleet. So when the held
   account's weekly window rolls over after the lease landed, the session's
   first request within one hour (the cache TTL) of the reset is ranked like a
   fresh pick. It moves when another account ranks first and otherwise holds;
   the pull cooldown does not apply. Without a demand model
   (under a week of history, or no metrics) nothing is expiring.
6. **In a weekly window's terminal stretch the ceiling is lifted.** The 95%
   ceiling keeps fresh sessions off an account that is nearly spent, because
   they would exhaust it and pay a cache re-create elsewhere. At the end of a
   weekly window that inverts: the remainder is destroyed at the reset, so one
   re-create per session is cheap against it. A `7d` or `7d_oi` claim at or
   above 95% does not raise the ceiling when the account has surplus, or when
   its reset is within **8 hours of demand** (`DEFAULT_WEEKLY_TERMINAL_DEMAND_HOURS`:
   expected demand to the reset over the average hourly demand, so a quiet
   night counts for little; clock hours without a demand model). The account
   takes fresh picks until its headroom reaches zero, then stops being
   serviceable and sessions move on by the ordinary rule. `status` marks it
   `BURNDOWN`. The `5h` claim is excluded: it refills on its own and keeps
   the 1-hour cache-TTL horizon. Warm sessions are not pulled into a burndown
   — the pull needs 10% headroom, a burndown has at most 5%.

   **Weekly reserve.** `CLAUDE_AUTH_BALANCER_WEEKLY_RESERVE` holds a fraction
   of a slot's weekly budgets (`7d`, `7d_oi`) out of the balancer entirely,
   for use outside it. The format is `slot=fraction` pairs, comma- or
   space-separated. With `2=0.10`, slot 2's weekly is measured against 90%:
   fresh picks stop at 85.5% (95% of 90%), warm sessions leave at 90%, and
   the burndown and surplus stop there too. The `5h` window keeps 70% as
   much (`FIVE_HOUR_RESERVE_SHARE`): with `2=0.10`, 7% of each `5h` window,
   so warm sessions leave slot 2 at 93% of `5h` instead of holding it to
   exhaustion and locking out personal use for hours. At the reserve the
   account is also out of the overage fallback: the server would still have
   quota to serve from, so it would spend the reserve rather than bill
   overage.

   ```ini
   # ~/.config/systemd/user/claude-auth-balancer.service.d/weekly-reserve.conf
   [Service]
   Environment=CLAUDE_AUTH_BALANCER_WEEKLY_RESERVE=2=0.10
   ```

   The statusline is a **different process** with a different environment, so
   set it there too or its badges will disagree with the router:

   ```jsonc
   // ~/.claude/settings.json
   { "env": { "CLAUDE_AUTH_BALANCER_WEEKLY_RESERVE": "2=0.10" } }
   ```
7. **Overage is never spent silently.** Accounts with `overage-status: allowed`
   can bill real money past 100%; that path requires `--allow-overage`.
8. **429 waits before it rotates.** With a short `Retry-After`, the proxy waits
   on the warm account rather than paying a cache re-create to dodge a few
   seconds. Only a long or absent `Retry-After` rotates. Either way the client
   never sees the 429.
9. **Generation retries are conservative.** No client-visible response is not
   proof that Anthropic did no work. A generation failure after application bytes
   may have been written is terminal by default, including header timeout and
   unknown socket phase. Only a proven pre-wire transport failure, or a
   bad_record_mac alert from upstream (its TLS refused one of our request
   records, so it never held the whole request), may be retried silently on the
   same slot.
10. **Opening sessions are fenced.** The first request for one `(session, model)`
   owns a keyed singleflight covering usage probes, selection, refresh, and lease
   publication. Concurrent openers wait and then re-read the published lease
   instead of selecting independently.

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

The 95% threshold reads **raw utilization**, not model-scaled headroom: "is
this account nearly spent?" is a question about the plan's meter, not about how
fast the requested model happens to burn it. It is evaluated only over the
claims the requested model is gated on, so `7d_oi` moves Fable and is ignored
for everything else. Non-Fable models never evacuate a warm session; the
threshold only keeps fresh ones off the account.

When a claim above the threshold stops mattering is `ceilingExempt` — one
function, used by the router and by the statusline badge so they cannot drift:

| claim | exempt when | why |
|---|---|---|
| any | reset within 1h (cache TTL) | a window that refills before the prefix expires is not worth a 20x move |
| `7d`, `7d_oi` | surplus > 0, or reset within 8 demand-hours | the remainder is destroyed at the reset, so spend it |

### Plan sizes

Accounts can be on different Max plans. Utilization is a fraction of the
account's own budget, and plans differ per claim:

| tier (`rate_limit_tier`) | `5h` | `7d` / `7d_oi` |
|---|---|---|
| `default_claude_max_20x` | 1 | 1 |
| `default_claude_max_5x` | 1/4 | 1/1.7 |

The tier comes from `GET /api/oauth/profile` (`organization.rate_limit_tier`),
read by the background sweep once a day per slot and stored in
`state/plans/<slot>.json`. The credential file's own `rateLimitTier` is not
used: files written outside Claude Code's login flow lack it. An unread or
unknown tier counts as 20x, and `status` prints `?` for it.

Only `headroom` is scaled, into a fraction of a 20x budget. It answers questions
about absolute work: which claim binds first, and whether an expiring remainder
is big enough to pull a warm session (a 5x needs 40% of its own `5h` left to
clear the 0.1 bar). Pacing and the 95% ceiling stay on each account's own
fractions. The `5h` bucket adds a typical fresh session's first-hour burn
(`freshBurn`) as a share of *this* window, so the same session counts four
times as much on a 5x. Surplus is in W20, so the fleet's supply adds up
across plans.

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
percentage points into internal 0..1 fractions. A window with an invalid
utilization or an invalid reset is skipped rather than partially overwriting a
prior claim. Model-specific legacy buckets are not assigned invented semantics.
A response-header observation wins over any older probe that finishes later.

A window that has rolled over and not been reopened is reported by the endpoint
as `{utilization: 0.0, resets_at: null}`. That is a real reading, not missing
data: the server opens a window on first use, so an account nobody routes to
never grows a reset. It is recorded as a zero-utilization claim with no reset,
which the policy treats as fully spendable and which the statusline renders as
0% with no reset clock. Only a *zero* utilization is admitted this way — a
nonzero utilization with no window is a shape the endpoint has never sent, and
accepting it would let a malformed response replace a real claim.

### Background usage sweep

Reactive probing runs only while an account is being selected, so it never
reads a slot that nothing is routing to — which is exactly the slot whose
reading goes stale. Every `usageSweepIntervalMs` (default
`USAGE_SWEEP_INTERVAL_MS`, 15 minutes), and once at startup, the daemon probes
every account whose reading is due. This bounds how long an idle account can
misreport after a window rollover, and it costs no model tokens. `0` disables
the sweep and its startup run, which is what a test asserting what the
*request* path probed needs.

Because `isDue` treats a reading older than two minutes as due, a 15-minute
sweep reads every account on every tick in practice; the filter's real work is
skipping accounts that live request traffic just refreshed.

### Warming the next 5h window

A 5h window opens on its first request and resets five hours later. The
usage and profile reads do not open one. So the account fresh picks spill to
next, once the current target leaves its 5h bucket, would start its clock only
when the spill arrives, and would come back that much later.

After each sweep settles, `slotToWarm` names that account: the fresh pick with
the current target excluded. If the current target's window is open (work is
running) and the next one's is not, `UsageProbe.warm` sends one
`claude-haiku-4-5` request with `max_tokens: 1` on it and records the claims
from its response headers. An open window reads from the persisted
observation, not projected claims, which would invent a reset for a window
that has not opened. One warm runs at a time; a failure is retried on the next
sweep. It opens at most one window per account per five hours and is not
recorded in metrics.

### Three weekly states, not two

An undefined weekly reset is ambiguous, and the two meanings rank in opposite
directions:

| state | `7d` claim | weekly rank | why |
|---|---|---|---|
| unobserved | absent | **first** | a request costs nothing and observes it |
| window not opened | present, `utilization` set, no `reset` | **last** | no deadline, so this quota cannot expire unspent. Rare for `7d`: observed weekly resets follow a fixed per-account cadence, landing on the hour, used or not |
| observed | present with a `reset` | by reset day | earliest real deadline drains first |

`HeadroomBreakdown.weeklyWindowUnopened` carries the distinction. Conflating
the middle row with the first sends every fresh session to the one account with
no deadline while another account's weekly remainder runs out its clock — the
inversion the reset-day ordering exists to prevent.

The same distinction applies to pacing. `spendableHeadroom` holds quota back in
proportion to the window still ahead; an unopened window has its *entire*
period ahead, not none of it, so it contributes a full window of hold-back
rather than looking maximally spendable.

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
- `usage_hourly` — `(hour, slot, model_class)` rollup, `model_class` being
  `fable` or `general`: requests, `sessions` (distinct in that hour only — not
  summable), `exhaustions` (a 429 or a claim at 100%), cost, first and last
  claim readings, and `reset_5h`/`reset_7d` (a reading fell by more than 0.3).
  Kept forever; the demand model learns from it.
- `fleet_hourly` — one row per closed hour, traffic or not: `censored` marks
  hours when every account was at 95% on `5h` or `7d`, so low spend there is
  missing quota, not missing work.

The hourly tables are written by `rollupHours`, for closed hours only, from a
watermark in `meta`; the first run backfills what `requests` still holds, and
the prune runs it first so no raw row is deleted unrolled.

### Demand model

The daemon rebuilds a forecast of fleet demand on each usage sweep and writes
it to `state/demand.json`, which the statusline reads too (dropped when over
2 hours old). Everything is in **W20**: one Max 20x weekly budget.

| field | what | learned from |
|---|---|---|
| `w20PerUsd` | weekly quota per list-price dollar, per model class | least squares of `7d` movement × plan size against cost, last 7 days (else 28) |
| `k` | a 20x's `5h` window as a fraction of its weekly | ΣΔ`7d` / ΣΔ`5h` over consecutive responses on 20x slots |
| `freshBurn` | median first-hour burn of a fresh session, W20 | `requests` |
| `hourly[168]` | expected W20/hour per local (weekday, hour) | 28 days of `usage_hourly`, censored hours skipped, 3-hour smoothing, scaled to the last week's spend |
| `overrides` | date-bounded multipliers | `~/.bravo/claude-auth-balancer/demand-profile.json` |

Nothing about any particular day is coded in. Under a week of history there is
no `hourly`, and routing runs without demand terms (clock-time pacing, no
surplus). For a known one-off — vacation, a crunch — add an override; each
entry is ignored once past its `to` date:

```json
{ "overrides": [{ "from": "2026-10-10", "to": "2026-10-12", "multiplier": 0.1 }] }
```

Pacing uses the share of the week's expected demand still ahead of the reset,
not the share of clock time, so quiet hours ahead leave more spendable now.

Nothing holds 20x headroom back for `5h` peaks. The demand terms avoid
stranding and spread load; reserving 20x quota for peak hours is the
conditional planner in the spec's step 6, built only if replay shows unserved
peak demand.
`status` prints the model's next-24h and weekly demand, `k`, and $/W20.

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
The balancer never reads or writes `~/.claude/.credentials.json`. Explicit
`install-statusline` and `install-compaction-hook` commands update Claude settings. On each daemon start it writes a random local gateway credential to:

```
~/.bravo/claude-auth-balancer/runtime/claude-gateway-credential.json
```

The file is mode `0600` and owner-checked. Its `nonce` is **persistent**: each
start reuses the stored one and refreshes only `instance_id`, `pid`, and
`created_at`. Nothing removes it — not clean shutdown, not a listen failure,
not `SIGINT`/`SIGTERM` — because unlinking it regenerates it on the next start,
and clients that read the old value via `apiKeyHelper` cannot re-read it on
demand. They would 401 until their helper TTL happened to refresh, which is a
guaranteed breakage traded for no security: the listener is loopback-only, and
anyone who can read this `0600` file is the uid that can read the authswap
OAuth files directly. `claude-auth-balancer claude [args...]` reads that file and
launches the real `claude` executable with this child-only environment block:

```
ANTHROPIC_BASE_URL=http://127.0.0.1:8789
ANTHROPIC_API_KEY=<daemon runtime nonce>
```

Override the URL for a non-default daemon port with
`CLAUDE_AUTH_BALANCER_URL=http://127.0.0.1:<port>`. If launcher resolution is
ambiguous, set `CLAUDE_BIN` to the absolute real Claude executable. All Claude
arguments, cwd, stdio, exit status, and signal termination are preserved.

The nonce makes Claude Code send requests without requiring local OAuth state.
The proxy validates it with a timing-safe comparison before request buffering,
account selection, or credential access, then strips it and injects the selected
canonical OAuth token. It never goes upstream or into logs/metrics. A missing or
unreadable runtime credential, or one whose daemon PID is no longer live, is a
launcher error; manual clients must read the same file or use the launcher.
The stale `pid` left behind by a stopped daemon is what makes the launcher
refuse — the nonce staying put does not make a dead daemon look alive.

### Per-client credentials: daemon restarts keep clients alive

A launched client can never re-read its key — the launcher injected it into the
child's environment once. The gateway nonce is now stable, so that alone no
longer orphans a session on restart, but a per-client nonce is still the tighter
grant: it dies with its own client instead of living as long as the file.

So the launcher does not hand out the instance nonce. It mints a **per-client
nonce**, records it in an owner-checked `0600` registry entry under:

```
~/.bravo/claude-auth-balancer/runtime/clients/
```

bound to the launcher's pid (the launcher stays alive wrapping the child), and
deletes it when the client exits. The daemon accepts its own instance nonce or
any live registry entry — nonces are compared timing-safely against every live
entry, with a rescan on miss so a fresh launch is never rejected by the cache.
The registry lives on disk, so a daemon restart is a non-event for client auth:
routing leases, quota observations, and metrics were already disk-backed, and
in-flight requests that die with the old daemon are retried by Claude Code onto
the same slot's still-warm cache.

This also tightens the leak story: a client's nonce dies with that client
instead of living until the next daemon restart. An entry whose pid is dead or
whose file is group/world-readable does not authenticate; `sweep` removes dead
entries. Entries without a pid are "adopted" nonces for migrating already-
running clients across the upgrade to this scheme — they must carry an expiry,
and an entry with neither pid nor expiry is rejected outright.

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

A displayed warning is filtered against the credential it describes: once the
slot's `expiresAt` is newer than the warning's timestamp, the warning is stale
and is not shown. Without that filter an out-of-band re-login left a "needs
login" warning standing for up to ~12h, because warnings are only cleared from
inside a refresh attempt and the sweep skips any slot outside the 30-minute
window.

### The session deadline, and `relogin`

Refreshing keeps the *access* token alive. It does not keep the *session* alive.
A Claude refresh token has a hard ~30-day life anchored to the interactive login
that created it, and the server counts it down from that login regardless of how
often the token is refreshed — `refresh_token_expires_in` comes back on every
refresh response and keeps shrinking. Only an interactive login resets it.

So the balancer cannot be fully unattended, and pretending otherwise means a
slot dies with no warning. `relogin claude <slot>` performs that login and
installs the result into the slot file; `relogin --check` shows every slot's
deadline for both providers and names the slots that need attention. Deadlines
inside 7 days are yellow, inside 2 days red, in `status`, `accounts`, and the
statusline.

`relogin claude <slot>` always logs in. `--if-needed` skips the login only when
the deadline is more than 7 days out *and* a forced refresh succeeds — a refresh
alone must never be treated as a substitute, because it leaves the original
clock untouched, which is the thing the command exists to reset.

Deadlines cluster: slots logged in together die together, and a three-slot pool
whose deadlines fall in the same week has no failover at all. `relogin --check`
reports pairs within 5 days of each other, and a successful relogin warns when
its new deadline lands next to another slot's.

## Running it as a daemon

```bash
claude-auth-balancer install-service            # systemd user unit, then start
claude-auth-balancer install-compaction-hook    # rebalance after every compaction
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
claude-auth-balancer serve    [--port N] [--allow-overage] [--enforce-body-limit]
                              [--max-request-body-mib N]
                              [--tls-policy fresh_tls_quarantine|keepalive_no_tls_cache|keepalive_with_tls_cache]
                              [--strict-generation-retry]
claude-auth-balancer status   [--model M]     # headroom, claims, live leases
claude-auth-balancer accounts                 # slots, health, token expiry
claude-auth-balancer refresh                  # refresh near-expiry slots now
claude-auth-balancer relogin <slot> [--if-needed]  # interactive login; resets the
                                              # ~30-day session deadline
claude-auth-balancer metrics  [--days N] [--daily] [--json] [--sql "..."]
claude-auth-balancer sweep                    # drop expired lease files
claude-auth-balancer prune    [--days N]      # drop old raw metric rows
claude-auth-balancer replay   --db SNAPSHOT [--old-policy compiled-policy.js]
                                              # offline trace replay; exits 1
                                              # while its meter fails fidelity
claude-auth-balancer claude [args...]           # launch client through gateway
claude-auth-balancer install-service   [--port N] [--allow-overage]
claude-auth-balancer uninstall-service
```

## Compaction boundaries

Run `claude-auth-balancer install-compaction-hook` once. It adds a synchronous
`PostCompact` command to `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`, preserving
other settings and hooks. Claude Code reloads settings changes in running sessions.
The command installed is the absolute path to this CLI followed by `post-compact`.

The hook reads Claude's JSON on stdin (`hook_event_name: "PostCompact"` and
`session_id`) and removes only that session's leases, across all models. It emits
no context text and ignores the summary. Manual, automatic, and
partial compactions all use this boundary. The summarization request retains its
warm account; after the hook completes, the next request ranks eligible accounts
normally. It may choose the same slot if that remains the best choice.

The daemon reads leases from disk on each request, so installing this hook takes
effect without a daemon restart. Before compaction, affinity still holds; weekly
rollover alone does not move a warm session. Hook support must be enabled in Claude
settings. With a custom balancer state root, the hook process must inherit the same
`CLAUDE_AUTH_BALANCER_HOME` as the launcher and daemon.

## Transport timeouts

Connecting, TLS negotiation, and waiting for upstream response headers are
bounded to 90 seconds by default (`upstreamHeaderTimeoutMs` in the programmatic
API). Once headers arrive, a stream's total length is unbounded, but silence is
not: a stream that sends no bytes for 120 seconds (`upstreamStreamIdleTimeoutMs`)
is cut and recorded as `upstream_stream_idle`. Claude Code's own watchdog would
otherwise cut it at 180 seconds. On either cut, Claude Code retries when only
thinking has streamed, and ends the turn on the partial response once text or a
tool call has streamed. The default inference policy is
`fresh_tls_quarantine`: one proxy-owned HTTPS agent with connection keep-alive
disabled and TLS session caching disabled, yielding a fresh TCP connection and
full TLS handshake for every inference attempt. Two opt-in experiment policies
exist behind `--tls-policy`: `keepalive_no_tls_cache` and
`keepalive_with_tls_cache`. Attempt rows record policy, socket reuse,
TLS-session reuse when visible, connection phase, error code, and request bytes
written, plus response bytes received and the silence before the attempt ended
(`response_bytes_received`, `response_idle_ms`). Usage probes and OAuth refresh keep their own provider-appropriate
transports; the inference quarantine is not a global network claim.

`bad_record_mac` failures ran at about 3% of generation requests from
2026-08-24 to 2026-09-27, while the hub reached the internet over Wi-Fi. The
rate rose with request size (0.4% under 100 KB, 7% over 2 MB). Plain `curl`
uploads reproduced it at the same rate over Wi-Fi from two different hosts,
and saw zero failures over wired Ethernet through the same gateway: the
gateway's Wi-Fi path corrupts bytes, and upstream's TLS rejects the damaged
record. Keep the hub on a wired link. The after-wire retry above covers the
residue.

## Request and attempt evidence

Every request receives durable redacted attempt rows in the
`auth_balancer_attempts` table inside
`~/.bravo/claude-auth-balancer/metrics.sqlite3`. These rows are separate from
final token usage rows: hidden 429s, waits, rotations, transport failures, local
413s, and security rejections are reconstructable without double-counting model
usage. The rows store scoped hashes for session/account correlation and never
store bearer tokens, the daemon nonce, authorization headers, or request bodies.

Request bodies are buffered because Claude Code speaks HTTP to the local
gateway. The body is never partially forwarded. The default configured cap is
64 MiB in report-only mode: over-limit requests below the hard memory ceiling
are forwarded and recorded as `request_body_limit_report_only`. The same 64 MiB
value is also a non-configurable report-only memory ceiling in this implementation;
crossing it returns a local 413 with `request_body_memory_ceiling` before any
upstream bytes are written. `--enforce-body-limit` turns configured over-limit
requests into a local 413. If configured through the CLI, the cap must be a
finite positive integer MiB value at or below 512 MiB; the programmatic byte
option accepts finite positive integer bytes at or below the same ceiling.
Invalid values fail closed instead of falling back to an unlimited comparison.
429 response-control bodies that are not sent to Claude Code are consumed or
abandoned with a byte cap and a deadline.

## What the proxy does not do

It never rewrites a request body. Anthropic's prompt cache is a prefix match
over `tools` -> `system` -> `messages`, and the invalidation hierarchy means
touching `tools` or `system` invalidates everything after it. Only the
`Authorization` header changes. Headers are semantically forwarded with an
explicit strip-and-replace policy; this package does not claim raw header or full
HTTP-message byte fidelity.

## Security

The proxy attaches a live OAuth bearer token to whatever it connects to, so the
request target is validated before any account is selected:

- **Only origin-form targets are accepted.** Node passes `req.url` through
  verbatim, so an absolute-form request line (`POST http://evil/steal HTTP/1.1`)
  from any local process would otherwise redirect a token off-origin. This was
  reproduced against an earlier revision; it now returns 400 before the
  credential store is touched, with a second origin check at forward time.
- **`x-api-key` and `anthropic-auth-token` are stripped from requests.** The
  daemon runtime nonce is consumed locally and can never displace the injected
  subscription bearer or reach Anthropic.
- Bind address defaults to `127.0.0.1`. The runtime nonce gates local callers,
  but this is still single-user loopback tooling; do not bind it to a routable
  interface.

## Testing

`npm test --workspace @bravo/claude-auth-balancer`

The proxy tests run against a **real local HTTP upstream** — genuine sockets,
headers, gzip, and streaming relay — with injected faults (429 on one account,
all accounts 429, expired credential, dead upstream). Nothing is stubbed inside
the code under test. No network, no credentials.
