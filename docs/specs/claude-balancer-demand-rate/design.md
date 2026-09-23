# Claude balancer: demand-aware routing

Status: draft v3 (2026-09-23). Package: `packages/claude-auth-balancer`.
History: v1 → "rethink" (Opus 5.5, GPT-6 Sol); v2 → "revise" (both); v3
addresses the v2 closure reviews.

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
| `exhaustions` | responses with a gating claim `rejected` |
| `util_5h/7d/7d_oi_first`, `_last` | first and last non-null reading in the hour, by `ts` |
| `reset_in_hour` | a claim's reading dropped by more than 0.3 inside the hour |
| `censored` | at the hour's end, every slot was ≥ 95% on a claim this `model_class` is gated on (`fable`: `5h`, `7d`, `7d_oi`; `general`: `5h`, `7d`) |

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
demand?: DemandProfile;   // expected W20/hour for any future hour, per model class
k?: number;               // rolling 5h-window / weekly ratio (20x)
sessionRate?: number;     // W20/hour; measured burn of this session, if it has history
```

With no `demand` supplied (cold start, or an unreadable rollup), the terms
below use a flat profile. That is the same code path with a constant input,
not a fallback to today's clock-time rules, which are deleted.

**Units.** Everything below is in W20 of **weekly** quota, for the requested
model's class: `7d` remainder for general models, and the lesser of `7d` and
`7d_oi × fallback` for Fable. It is never the current `headroom`, which is
often set by the `5h` window.

| term | today | becomes |
|---|---|---|
| pacing | `remainingFraction` = clock time left in the week | `D(now→reset_i) / D(week)`, where `D` is expected demand in that model class |
| expiring | reset within 12h and ≥ 1% headroom | `weekly_i > absorbable_i` |
| terminal ceiling lift | reset within 8h | reset is the next deadline in the fleet and `weekly_i > absorbable_i` |

```
absorbable_i = min(
  D(now→reset_i) − Σ weekly_j over accounts j resetting before i,   # demand left for i
  5h_cap_i × k × demandHours(now→reset_i) / 5                        # what i's 5h window can burn
)
```

`demandHours` counts hours whose expected demand exceeds the smallest `5h` rate
in the fleet, not clock hours. Deadlines come from the fixed weekly cadence,
so they are known for every account.

The terminal lift keeps its purpose. Spending quota that dies at the reset
saves quota that does not, and the lift fires only when that quota cannot be
absorbed any other way. It never fires just because a forecast predicts
stranding.

**`5h` bucket, capacity-aware.** A fresh session's bucket is computed after
adding its expected burn: `projected_i + E[burn]/ (5h_cap_i × k)`, where
`E[burn]` is the median first-hour burn of fresh sessions of that model class,
from `usage_hourly`. On a 5x the same session is 4x more of the window, so
large-model sessions stop landing on an empty 5x just because it reads 0%.

**Heavy-session guard.** When `sessionRate` is known (a re-pick after
compaction, or a warm-pull candidate), placement on account `i` requires
`sessionRate × 1h ≤ remaining 5h_i` in W20, the cache TTL being 1h. Until the
5x slots have their own util-per-dollar fit, their 5h window in W20 comes from
the plan table and the 20x `k`.

**Warm pulls** stay rare: target `weekly_i > absorbable_i` by at least 0.1 W20,
the session's `sessionRate` passes the heavy-session guard on the target, and
at most one pull per session per 6h. Stranding alone never triggers a pull.

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

1. **Fable demand is not interchangeable.** Partly handled: the profile, the
   units and `absorbable` are per model class. Still open: whether a Fable
   session that falls back to Opus should count as Fable or general demand.
2. **Server-side anomalies.** How to detect a reset that lands off-cadence
   (the 09-01 case), so it is excluded from the profile, `k`, and the replay
   fidelity gate.
3. **Censored demand.** Whether censored hours are dropped, or imputed from the
   same hour in uncensored weeks.
