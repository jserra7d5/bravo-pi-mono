# Claude balancer: demand-aware routing

Status: steps 2–4 built and live; step 5's harness built, its fidelity gate
**failing**, so step 4 shipped ahead of its own gate (v4, 2026-09-23).
Package: `packages/claude-auth-balancer`.
History: v1 → "rethink" (Opus 5.5, GPT-6 Sol); v2 → "revise" (both); v3
addresses the v2 closure reviews; v4 records what was built where it
differs from v3 (the "Built as" notes below).

## Problem

The fleet is now 4 × Max 20x and 2 × Max 5x (added 2026-09-22).

**Supply now exceeds demand.** Units are **W20**, one Max 20x weekly budget.

| | per week |
|---|---|
| supply: 4 × 1.0 + 2 × 0.59 | 5.18 W20 |
| demand, last two weeks ($15.2k–16.4k at ~$3.5–4.2k per W20) | ~3.6–4.7 W20 |

With demand fully served, unspent quota is at least supply minus demand
whatever the router does. **Stranded quota is not lost work.** Only two
things cost:

1. **Unserved demand:** exhaustion, 429 rotation, overage.
2. **Cache re-creates:** each forced move costs ~20x on its next request.

**Weekly windows run on a fixed schedule per account, not from first use.**
Each slot's `7d` reset recurs at the same weekday and hour whether or not the
account is used. Slot 3 reset Sat 09-12 01:00, sat idle from Wed 09-16 21:26 to
Sun 09-20 21:38, and its next reset is Sat 09-26 01:00, exactly two cadences
later. First-use anchoring would have put it near Sun 09-27 21:00. Slot 1 has
been idle since Mon 09-21 03:37, and its next reset is Mon 09-28 04:00. Weekly
resets land on the hour. So every account's weekly deadline is known in
advance, and nothing can gain or lose weekly window time. `5h` windows do
open on first use; their resets land on :30.

**Stranding under the current policy is small.** Resets since 09-08 left 1–4%
unspent, apart from 17% on slot 1 (Tue 09-15). Weekend resets (Sat 09-12, Sun
09-20) stranded 2–4%. v1's 20–60% figures came from 09-04..09-07. That week had
anomalous server resets about 2 days apart (slots 2 and 3 on 08-30, then
09-01) and three policy commits (`d08f1cb`, `f09ee83`, `28f7191`).

**What is new is rate, not size.** A 5x's `5h` window is a quarter of a 20x's.
Per-session burn runs p90 0.013 W20/h, p99 0.051 W20/h, max 0.113 W20/h. A 5x's
whole `5h` window is ~0.05 W20. One heavy session can exhaust it within an
hour, forcing a re-create. Demand is also uneven: mean cost per local day
2026-08-24..09-23 was Sun $1363, Mon $2116, Tue $2823, Wed $3118, Thu $2104,
Fri $730, Sat $414. The clock-time horizons (12h expiring, 8h terminal, pacing)
cannot see that 30 hours of Friday-into-Saturday hold less demand than 12
hours of a Tuesday.

## Objective

Minimize **unserved demand + priced re-creates**. Stranded quota is reported
but never optimized; driving it down with warm pulls would pay re-creates for
no work. Spending expiring quota first still matters, because it preserves
quota that outlives the reset, and that quota is what serves later peaks.

## Measured quantities

- **`k`, the 5h window in weekly units:** `k = ΣΔ7d / ΣΔ5h` over consecutive
  same-slot responses less than 5 minutes apart. Exclude negative deltas and
  any weekly jump over 0.02, which marks a reset or stale header. On the 20x
  slots `k` averaged ~0.19 over 30 days and is ~0.26 this week. It is
  **drifting**: the per-week ratio has fallen on every slot (slot 3: 6.89 →
  3.85 Δ5h per Δ7d), and it is the same in and out of peak hours. So `k` is
  measured on a rolling week, never fixed. On a 5x, the saturated windows
  needed to spend a week range from ~9 to ~12 depending on `k`.
- **Plan sizes:** the table (5x = 1/4 on `5h`, 1/1.7 weekly) stays the input.
  Once slots 5–6 have a week of data, their caps are measured directly: util
  per dollar, and `5h` exhaustion points. A large disagreement prints a warning
  in `status`.
- **Demand:** from `cost_usd`, not from utilization deltas. `util_7d` moves in
  1-point steps. A median hour of fleet demand is ~0.02 W20, which is below one
  quantization step on Fridays and Saturdays. Cost is continuous and complete.
  It converts to W20 through a per-slot, per-model-class fit of util per dollar
  (Fable burns 2x).

## Work, in order

### 1. (Dropped) weekly priming

v2 proposed priming unopened weekly windows. The fixed weekly cadence above
means there is nothing to prime: an idle account's week runs anyway. The
README's "window not opened, ranks last" state for `7d` was captured during
the 09-01..09-05 anomaly. It stays in the policy as a rare case (brand-new or
long-dormant accounts), and its README text is corrected to say so.

`5h` priming is still real, because `5h` windows do open on first use. Its
value depends entirely on timing relative to demand, so it belongs to step 6.

### 2. Hourly rollup, kept

`requests` keeps 30 days. Every day without a rollup loses history for trend,
anomaly detection and replay, permanently. Table `usage_hourly`, keyed
`(hour_utc, slot, model_class)`, where `model_class` is `fable` or `general`:

| column | meaning |
|---|---|
| `cost_usd`, `uncached_usd`, `requests` | sums; safe to add across hours |
| `sessions` | distinct session hashes **in this hour only**; not summable across hours |
| `exhaustions` | responses that were a 429 or carried a claim at ≥ 100% |
| `util_5h/7d/7d_oi_first`, `_last` | first and last non-null reading in the hour, by `ts` |
| `reset_5h`, `reset_7d` | that claim's reading fell by more than 0.3 from the slot's previous reading (`7d` covers `7d_oi`) |

**Built as:** `censored` lives in its own table, `fleet_hourly (hour,
censored)`, with a row for every closed hour. A
per-row flag could not mark an hour with no traffic, and an empty hour is
exactly what a fully-censored fleet produces. The flag reads each slot's last
known readings at the hour's end: every slot ≥ 95% on `5h` or `7d`. A Fable
column was dropped because nothing read it; the profile is total demand. A single
`reset_in_hour` also caught every `5h` rollover, so it was split.

Rows are written once, for closed hours only, by the sweep. At about 260k rows
a year the table is kept indefinitely, like `usage_daily`. It holds the same
local data `requests` already holds, at coarser grain. Backfill it from the
current 30 days. `requests` keeps its 30-day retention, which replay uses for
fidelity.

### 3. Demand profile

Expected fleet demand `d(t)` in W20/hour, rebuilt on each sweep from
`usage_hourly`:

- a **day-of-week shape** with light hourly smoothing, since four samples per
  (day, hour) bucket is too noisy to use raw
- **scaled by the most recent full week's total**, because weekly totals ran
  $9.1k, $9.2k, $15.2k, $16.4k and a flat mean understates current demand by ~25%
- **excluding** windows with anomalous resets, and **flagging** censored hours
  (fleet near-exhausted), whose low demand may be missing quota, not missing work
- **cold start:** a flat profile

**Built as:** one total-demand profile, both classes' cost converted at their
fitted rates and blended by cost share. Per-class demand terms are left for
step 6. Censored hours are dropped from the shape (open question 3's first
option). Anomalous resets are handled in the util-per-dollar fit, which
re-anchors on any fall in a reading, flagged or not. **Cold start** is no
profile at all, under a week of history. Routing then has no surplus term and
paces on the clock, as before. A flat profile would have invented demand the
router then acts on.
- **operator override** `~/.bravo/claude-auth-balancer/demand-profile.json`:
  date-bounded multipliers only (vacation, crunch). Each entry expires at its
  end date. Nothing about specific days is hard-coded.

### 4. Demand-aware terms

No separate planner, plan file, or daemon job. Everything else stays:
affinity, the 95% ceiling, the `5h` bucket, `reservedForFable`, the `7d_oi`
gate, and overage.

**Where the inputs live.** `computeHeadroom` sees one account, so it cannot
rank against the fleet. `selectAccount` computes the fleet terms once per call
and passes them down. New `SelectInput` fields:

```ts
demand?: DemandModel;     // src/demand.ts: w20PerUsd, k, freshBurn, hourly[168]?, overrides
sessionRate?: number;     // W20/hour; measured burn of this session over the last hour
affinitySince?: number;   // lease created_at: when the session landed on its slot
```

**Built as:** with no `demand` (cold start, no metrics, or a `demand.json`
over 2 hours old), there are no surplus terms, pacing is on the clock, and
the terminal window is 8 clock hours. The 12h/8h horizons and
`--expiring-horizon-hours` are deleted.

**Units.** Everything below is in W20 of **weekly** quota, for the requested
model's class: `7d` remainder for general models, and the lesser of `7d` and
`7d_oi × fallback` for Fable. It is never the current `headroom`, which is
often set by the `5h` window.

| term | today | becomes |
|---|---|---|
| pacing | `remainingFraction` = clock time left in the week | `D(now→reset_i) / D(week)`, where `D` is expected demand in that model class |
| expiring | reset within 12h and ≥ 1% headroom | `weekly_i > absorbable_i` |
| terminal ceiling lift | reset within 8h | `surplus_i > 0`, or reset within 8 **demand-hours** |

```
absorbable_i = min(
  max(0, D(now→reset_i) − Σ min(weekly_j, absorbable_j) over j resetting before i),
  Σ_h min(d(h), 5h_cap_i × k / 5)            # what i's 5h window can burn, hour by hour
)
surplus_i = weekly_i − absorbable_i
```

Deadlines come from the fixed weekly cadence, so they are known for every
account. **Built as:** the rate cap is integrated hour by hour
(`Σ min(d, cap)`), which replaced v3's `demandHours` count. A demand-hour for
the terminal lift is `D(now→reset) / mean hourly demand`, so eight quiet night
hours count for little. Surplus alone made the lift circular: an account over
the ceiling gets no fresh demand, so the surplus test had nothing to lift. The
8-demand-hour rule breaks that. Expiring needs `surplus ≥ 0.01` W20.

The terminal lift keeps its purpose. Spending quota that dies at the reset
saves quota that does not, and the lift fires only when that quota cannot be
absorbed any other way. It never fires just because a forecast predicts
stranding.

**`5h` bucket, capacity-aware.** A fresh session's bucket is computed after
adding its expected burn: `projected_i + E[burn]/ (5h_cap_i × k)`, where
`E[burn]` is the median first-hour burn of fresh sessions of that model class,
from `usage_hourly`. On a 5x the same session is 4x more of the window, so
large-model sessions stop landing on an empty 5x just because it reads 0%.
**Built as:** one blended `freshBurn` from `requests`, not per class. The
bucket still ranks after the reset day, so a 5x that resets first collects
fresh sessions until its ceiling. An escape for hot buckets (≥ 75%) was built
and reverted. Replay put it at 4092 fleet-wide `5h` refusals against 2106
without it. The plausible mechanism is that spreading opens every `5h` window
early and leaves none fresh for the peak. But that meter over-reads `5h`,
and its refusal count proved unstable (step 5), so the numbers only remove
the case for adding the term; they do not prove concentration better.

**Known limitations**, to revisit once the meter passes:

- A 5x that resets first takes every fresh session until its 95% ceiling.
  Live cadence makes this Mon 04:00–16:00 (slot 6 alone earliest), a peak
  day, not yet observed.
- Several warm sessions can each pass the heavy-session guard against the
  same expiring account before any response updates its claims. The 6h
  cooldown stops one session bouncing, not many landing at once.

Fable's fleet term uses the lesser of `7d` and
`7d_oi × fallback`, as the Units paragraph says; the demand it is set against
is total demand.

**Heavy-session guard.** When `sessionRate` is known (a re-pick after
compaction, or a warm-pull candidate), placement on account `i` requires
`sessionRate × 1h ≤ remaining 5h_i` in W20, the cache TTL being 1h. Until the
5x slots have their own util-per-dollar fit, their 5h window in W20 comes from
the plan table and the 20x `k`.

**Warm pulls** stay rare: target `weekly_i > absorbable_i` by at least 0.1 W20,
the session's `sessionRate` passes the heavy-session guard on the target, and
at most one pull per session per 6h. Stranding alone never triggers a pull.
**Built as:** the target also needs 0.1 plan-scaled headroom (a 5x: 40% of
its own `5h`), which covers a session with no measured rate. The 6h cooldown
reads the lease's `created_at`, which `touch` resets on a slot change. A
re-pick with a measured rate prefers accounts it fits on, and takes the whole
pool when it fits nowhere.

**Weekly reserve** (operator, 2026-09-23). `CLAUDE_AUTH_BALANCER_WEEKLY_RESERVE`
(`slot=fraction`) replaces `CLAUDE_AUTH_BALANCER_CAPPED_SLOTS`. A reserved
slot's weekly claims are measured against `1 − fraction` and its `5h` claim
against `1 − 0.7 × fraction`, and its capacities shrink to match, before any
other term runs. The ceiling, burndown, surplus and pacing then cannot reach
the reserve. The old cap kept 5% of the weekly, and only from fresh picks:
warm sessions still ran it to 100%.

### 5. Replay harness

This is the gate for step 4 and for any step 6.

- **Input:** the `requests` trace (sessions, timestamps, cost, uncached cost,
  model).
- **Meter:** per-slot, per-model-class util-per-dollar fits. `7d` resets on
  each account's fixed cadence; `5h` opens on first use and resets 5h later,
  rounded to :30. A moved session pays `uncached_usd`.
- **Router:** the real `selectAccount` and the lease lifecycle, not a copy.
- **Fidelity gate first.** Meter fidelity does not depend on the policy, so it
  is tested on recorded decisions across the whole retained trace, excluding
  the 09-01..09-07 anomaly. Fit on data up to 09-13, validate on 09-14
  onward. Pass requires, at every recorded response:
  - `|simulated − recorded| ≤ 2` points on `7d`, `≤ 5` points on `5h`
  - every observed reset time reproduced
  - at least 3 historical `5h` exhaustions reproduced (there are 137–594
    responses at ≥ 0.99 per slot)

  Until it passes, replay results are not evidence.
- **Scoring:** unserved demand, `5h` exhaustions, re-creates, and stranded
  quota (reported only).
- **Done for step 4:** no increase in unserved demand, exhaustions or
  re-creates, and an improvement larger than the week-to-week spread. Tested on
  held-out weeks and whole reset cycles. That verdict waits for at least two
  complete post-change weeks with observed 5x windows. Before then, replay
  only says whether step 4 is safe to run, not whether it is better.
- **Injected fault:** a Saturday replayed with Tuesday's demand. The router
  must degrade to spreading, not to a herd migration.
- **5x slots have no history.** Results for them are sensitivity estimates,
  labelled as such. So are hypothetical-fleet runs (one more 5x vs one more
  20x).
- **Tuning:** at most one parameter (the absorbability margin) until
  `usage_hourly` holds months of data. `tune` prints; it never writes config.

**Built as:** `claude-auth-balancer replay --db SNAPSHOT [--old-policy
compiled-policy.js]` (`src/replay.ts`), exiting 1 while the gate fails. The
meter fits util per dollar cumulatively per slot, claim and class (adjacent
response pairs under-read it by about half), takes weekly resets from the
observed ones, and starts each slot from its recorded reading. Result on the
2026-09-23 snapshot:

| claim | p95 error, points | gate |
|---|---|---|
| `7d` | 12–30 | ≤ 2 |
| `5h` | 50–85, reads high | ≤ 5 |

`5h` is the open problem: only 11 of 34 observed `5h` resets are reproduced,
so the window model itself is wrong, not just the rate. Scoring against HEAD
on that meter, for the record and not as evidence:

| policy | refused | 5h exhaustions | re-creates | pulls | stranded W20 |
|---|---|---|---|---|---|
| HEAD, slot 2 reserve 10% | 0 | 38 | 201 | 13 | 2.31 |
| step 4, slot 2 reserve 10% | 2247 | 41 | 194 | 35 | 2.24 |
| HEAD, no reserve | 2187 | 43 | 235 | 14 | 2.15 |
| step 4, no reserve | 2106 | 40 | 206 | 38 | 2.20 |
| step 4 + hot-bucket escape, no reserve | 4092 | 32 | 160 | 37 | 2.24 |

(HEAD predates the reserve; the harness hands it reserve-applied claims.)
Every refusal was `5h`-bound, and refusals are **not a stable metric** on
this meter: HEAD swings from 2187 to 0 on the reserve alone. With a `5h`
meter that reads 50–85 points high, refusals measure whether all six `5h`
windows happen to run dry together, which small routing changes flip. The
other columns move little between policies. So the escape's revert rests on
there being no evidence for adding a ranking term, not on its refusal count
(see the `5h` bucket note). The injected Saturday fault, with warm leases
carried in, produced no pulls and no re-creates; fresh picks put 71% of its
requests on slot 6, the earliest reset. `tune` is not built.

### 6. Conditional: a fleet planner

Build only if replay shows unserved peak demand that step 4 leaves behind.

The operator's case for it is reserve: 20x weekly held back is peak capacity,
because only a 20x's `5h` window can absorb a burst. Per-account terms cannot
express "keep slot 1 for Tuesday's peak and run the 5x through Monday
off-peak". A min-cost flow over (hour × account) with explicit `5h` windows
opened on first use can. `5h` priming, timed to the demand ramp, lives here
too.

The trigger is measured: replay unserved demand at peaks, with the 20x slots'
weekly exhausted before reset while 5x weekly remains. At current supply
(5.18 W20 against ~4 of demand) this may never fire.

## Decisions

1. **Demand is learned from history** (operator). The config file covers only
   date-bounded exceptions.
2. **No preference between plans by price.** Subscriptions are paid either
   way. Price per W20 ($170 on 5x, $200 on 20x) is an input to fleet-purchase
   replay only. Preference by *rate*, reserving 20x for peaks, is step 6's
   question, decided by replay.
3. **No weekly priming.** The operator wanted it unconditional. It was
   dropped because weekly resets follow a fixed per-account cadence (Problem),
   so there is no unopened window to prime. `5h` priming stays in step 6.
4. **Build the hourly rollup now.** Opus: history is lost every day, and
   trend and anomaly detection need more than 30 days. Sol: defer, adds
   permanent history. The data is local, at a coarser grain than `requests`,
   and losing it cannot be undone. Opus's view wins.
5. **No planner until replay says so.** Both reviewers recommended starting
   with the smaller change.
6. **Fleet terms live in `selectAccount`.** `computeHeadroom` stays
   per-account; absorbability is fleet-wide and computed once per selection.

## Open questions

1. **Fable demand is not interchangeable.** Partly handled: the units are per
   model class (a Fable remainder is `min(7d, 7d_oi × fallback)`), but the
   profile and `absorbable` use total demand. Still open: a per-class profile,
   and whether a Fable session that falls back to Opus counts as Fable or
   general demand.
2. **Server-side anomalies.** How to detect a reset that lands off-cadence
   (the 09-01 case), so it is excluded from the profile, `k`, and the replay
   fidelity gate.
3. **Censored demand.** Whether censored hours are dropped, or imputed from the
   same hour in uncensored weeks.
