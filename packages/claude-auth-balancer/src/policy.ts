// Account-selection policy. Pure: no fs, no network, no clock of its own.
//
// The dominant cost in this system is prompt-cache continuity, not quota.
// Measured across 60 recent Claude Code transcripts (38,179 assistant requests):
// 99.0% of all input tokens were cache reads, averaging ~260k read tokens per
// request on long sessions, and 100% of cache creation used the 1-hour TTL.
//
// Cache read is 0.1x base input; a 1h cache write is 2.0x. So moving a live
// session to a different account costs 20x on its next request (on Opus 5,
// $2.60 vs $0.13 for a 260k prefix) plus a full prefill. Caches are per-account
// and per-model with no escape hatch.
//
// Therefore: affinity wins by default. Non-Fable sessions only leave an account
// when it genuinely cannot serve the request. Fable retains proactive evacuation
// because its separately gated, faster-burning budget needs the existing guard.
//
// The 95% ceiling applies to FRESH picks for every model: a session with no
// cache to lose should not be started on a near-exhausted account. It is
// ignored when every account is above the ceiling, because at that point the
// move buys nothing and the cheapest account is whichever ranking already
// prefers.
//
// Fresh picks pace the weekly. On a 20x Max plan the 5h window is 4x a 5x
// plan's but the weekly is only 1.7x, so the weekly is the scarce budget and
// the 5h window is a self-refilling burst limiter. Every model ranks fresh
// picks on spendable headroom: quota remaining beyond what staying on pace
// until the reset would keep. The account furthest ahead of pace takes new
// sessions, so all accounts reach their reset near-empty together instead of
// the earliest-reset account being drained to the floor while a later one
// leaves half a week unspent. Non-Fable picks also hold back the general
// weekly that Fable's `7d_oi` sub-budget can still use: Fable burns both
// claims, Opus and Sonnet burn only `7d`, so an Opus herd can exhaust `7d` and
// strand a full Fable sub-budget. See `reservedForFable`.
//
// Ahead of pacing, fresh picks rank on a coarse 5h-pressure bucket, so the
// population of warm sessions that can exhaust one 5h window — and then all
// migrate at once, each paying a cache re-create on the next account — is
// spread across accounts. The bucket is on PROJECTED utilization at the reset,
// not the current level: 60% with thirty minutes left is cooler than 30% with
// four hours left. See DEFAULT_FRESH_5H_BUCKET.
//
// Ahead of the 5h bucket, fresh picks drain the earliest weekly reset, floored
// to whole days. Observed 2026-09-02: slots 2 and 3 resetting in 2.3d and 2.5d
// with real headroom, and a fresh Opus session sent to slot 1 (4.6d out,
// behind pace) purely on a cooler 5h bucket. Quota on the earliest-resetting
// accounts is the quota with the nearest deadline; the 5h window refills by
// itself. Accounts resetting on the same day still spread on 5h pressure, so
// the herd guard survives among the cohort that matters. Warm sessions are
// untouched: only the 12h expiring pull moves them.
//
// One thing outranks all of that, affinity included: weekly quota that is
// about to expire unspent. A weekly window resetting within the horizon still
// holding meaningful headroom is value with a hard deadline; nothing routed
// elsewhere can ever recover it. A cache re-create is a one-time ~20x request;
// a week of unspent quota is thousands of requests. See
// DEFAULT_EXPIRING_WEEKLY_HORIZON_MS.
//
// Inside the last hours of a weekly window the 95% ceiling inverts: it was
// built to keep fresh sessions off an account that is nearly spent, but an
// account that is nearly spent AND about to reset is the one place whose
// remainder is otherwise thrown away. So a weekly claim resetting within
// DEFAULT_WEEKLY_TERMINAL_HORIZON_MS does not raise the ceiling at all, and
// the account keeps taking fresh sessions down to zero. The 5h claim is
// unaffected: it refills by itself and never expires unspent. An account named
// in CLAUDE_AUTH_BALANCER_CAPPED_SLOTS opts out and keeps the flat 95% cap.
//
// Accounts need not be the same plan. Utilization is a fraction of that
// account's OWN budget, and a Max 5x budget is a quarter of a 20x's on `5h` and
// 1/1.7 of it on `7d`. `headroom` is scaled by the account's `PlanCapacity`
// into one unit — a fraction of a Max 20x budget — because the questions it
// answers are about absolute work: is the expiring remainder worth a pull, and
// which claim binds first. Pacing, the 95% ceiling and the 5h bucket stay on
// the account's own fractions. A fresh session moves a 5x's fractions further
// than a 20x's, so greedy ranking on fractions already hands each account work
// in proportion to its size; scaling them would make a behind-pace 5x look less
// behind than a 20x at the same fraction.

import type { Claim, ClaimId, Claims } from './claims.js';
import { claimHasReset, projectExpiredClaims } from './claims.js';

/** General-quota claims every request burns, regardless of model. */
export const GENERAL_CLAIMS: ClaimId[] = ['5h', '7d'];

export type ModelQuota = {
  /**
   * Burn rate against the general (5h / 7d) claims, relative to Opus = 1.
   *
   * Provenance: Fable = 2 is operator-supplied ("effectively double opus usage
   * in terms of the quota it racks up"). Every other model is 1 because no
   * measured figure exists — not because they are known to be equal.
   */
  costMultiplier: number;
  /**
   * Additional claim this model is separately gated on, on top of the general
   * claims. Fable carries `7d_oi`, a weekly sub-budget of its own.
   *
   * Its utilization is a fraction of THAT sub-budget, not of the general weekly
   * budget, so it must be rescaled before it can be compared with a general
   * claim — see `subBudgetFraction`.
   */
  extraClaim?: ClaimId;
  /**
   * Size of `extraClaim`'s budget as a fraction of the general weekly budget.
   *
   * Fable may consume up to ~50% of weekly, which matches the
   * `anthropic-ratelimit-unified-fallback-percentage: 0.5` observed on every
   * response from both accounts. A response's own `fallbackPercentage` wins
   * over this default when present.
   */
  subBudgetFraction?: number;
};

export const DEFAULT_QUOTA: ModelQuota = { costMultiplier: 1 };

/** Matched against the request's `model` field by substring, longest key first. */
export const MODEL_QUOTAS: Record<string, ModelQuota> = {
  fable: { costMultiplier: 2, extraClaim: '7d_oi', subBudgetFraction: 0.5 },
};

export function quotaForModel(model: string | undefined): ModelQuota {
  if (!model) return DEFAULT_QUOTA;
  const needle = model.toLowerCase();
  const key = Object.keys(MODEL_QUOTAS)
    .sort((a, b) => b.length - a.length)
    .find(k => needle.includes(k));
  return key ? MODEL_QUOTAS[key]! : DEFAULT_QUOTA;
}

/**
 * An account's budget per claim, relative to a Max 20x account = 1.
 *
 * Provenance: operator-supplied (2026-09-22). A 5x plan's `5h` window is a
 * quarter of a 20x's; its weekly is 1/1.7 of it. `7d_oi` is a fraction of the
 * weekly, so it scales with `weekly`.
 */
export type PlanCapacity = { fiveHour: number; weekly: number };

export const REFERENCE_CAPACITY: PlanCapacity = { fiveHour: 1, weekly: 1 };

/** Keyed by the profile endpoint's `organization.rate_limit_tier`. */
export const PLAN_CAPACITIES: Record<string, PlanCapacity> = {
  default_claude_max_20x: REFERENCE_CAPACITY,
  default_claude_max_5x: { fiveHour: 1 / 4, weekly: 1 / 1.7 },
};

/**
 * Capacity for a tier. An unread or unrecognized tier is treated as the
 * reference plan, which is what every account was before plans were read;
 * `status` prints the tier so an unknown one is visible.
 */
export function capacityForTier(tier: string | undefined): PlanCapacity {
  return (tier && PLAN_CAPACITIES[tier]) || REFERENCE_CAPACITY;
}

export type AccountHealth = 'ok' | 'needs-reauth' | 'unknown';

export type AccountState = {
  slot: string;
  email?: string;
  health: AccountHealth;
  /** Last observed claims for this account. Absent until its first response. */
  claims?: Claims;
  /** When `claims` was captured (ms). */
  observedAt?: number;
  /** Access-token expiry (ms). Expired accounts are not selectable. */
  tokenExpiresAt?: number;
  /** Hard interactive-login session deadline (ms), when supplied by Claude. */
  refreshTokenExpiresAt?: number;
  /**
   * Opt this account out of the terminal-weekly burndown: it keeps the flat
   * 95% ceiling even in the last hours before its weekly reset, so its final
   * 5% is held in reserve rather than spent. Set from
   * CLAUDE_AUTH_BALANCER_CAPPED_SLOTS; see `resolveCappedSlots`.
   */
  capAtCeiling?: boolean;
  /** Plan size. Absent means the reference (Max 20x) plan. */
  capacity?: PlanCapacity;
};

/**
 * Utilization at which an account stops taking fresh sessions, and at which a
 * warm Fable session is proactively evacuated. A warm non-Fable session holds
 * through it and drains to genuine exhaustion, because moving it costs a full
 * cache re-create.
 *
 * This is a raw-utilization threshold, deliberately not a headroom one.
 */
export const DEFAULT_EVACUATE_UTILIZATION = 0.95;

/**
 * Soft 5h ceiling for FRESH picks only. Drain-first ignores the 5h claim until
 * the 95% hard ceiling, so with many concurrent warm sessions the drain target
 * collects every new session from ~50% to 95% and they later exhaust — and
 * migrate — together, each paying a 20x cache re-create on arrival at the next
 * account.
 *
 * A single threshold only moves that cliff: below it every fresh session still
 * stacks on one account, and at it they all switch to the next one together.
 * Bucketing makes the 5h term a gradient instead. Fresh picks sort on
 * `floor(utilization / bucket)` FIRST and fall through to the model's own
 * ranking within a bucket, so drain-first still consolidates weekly burn among
 * accounts under equal 5h pressure while concurrent sessions spread from the
 * first quarter of the window.
 *
 * It never excludes: an account in a hotter bucket is still selected when it
 * is the only one, so this degrades to the previous ranking with one account.
 * A 5h window refilling within the cache horizon buckets as cool, same
 * exemption the hard ceiling makes — a bucket that refills before a new
 * session could meaningfully burn it is not pressure.
 */
export const DEFAULT_FRESH_5H_BUCKET = 0.25;

/**
 * Fraction of the 5h window that must have elapsed before its average burn
 * rate is trusted to project utilization at the reset. Under this (30 minutes)
 * the raw level is used: 5% at six minutes projects to 250%, which is noise,
 * not pressure.
 */
export const DEFAULT_5H_PROJECTION_MIN_ELAPSED = 0.1;

/**
 * How close a general `7d` reset must be for an account's remaining weekly
 * quota to count as expiring. Inside this window the account outranks every
 * other term for fresh picks, and warm sessions held elsewhere are moved onto
 * it — the one case where routing deliberately pays a cache re-create for a
 * session that could have stayed put. Quota that reaches the reset unspent is
 * gone; a re-create is one expensive request.
 *
 * Twelve hours is long enough for moved sessions to burn a real share of the
 * remainder and short enough that an account spends most of its week under
 * the ordinary ranking.
 */
export const DEFAULT_EXPIRING_WEEKLY_HORIZON_MS = 12 * 60 * 60 * 1000;

/**
 * Minimum model-normalized headroom for an expiring account to lead FRESH
 * ranking. A fresh session has no cache to lose, so placing it on an expiring
 * account costs nothing and almost any remainder with a deadline is worth
 * taking. The floor exists only to keep a numerically-zero remainder — or the
 * rounding dust either side of it — from claiming the top of the ranking.
 */
export const DEFAULT_EXPIRING_MIN_HEADROOM = 0.01;

/**
 * Minimum model-normalized headroom for an expiring account to PULL a warm
 * session off another account. Higher than the fresh floor because this is the
 * one move that deliberately pays a ~20x cache re-create: below this the
 * unspent remainder is not clearly larger than the re-creates it would
 * trigger, and the 5h claim may be what is binding anyway.
 *
 * Like all headroom it is in Max 20x units, so a 5x account must hold 40% of
 * its own 5h window and 17% of its weekly to pull: a herd moved onto a quarter-
 * sized 5h window would exhaust it and pay a second re-create.
 */
export const DEFAULT_EXPIRING_PULL_MIN_HEADROOM = 0.1;

/**
 * Weekly claims. These are the budgets that can expire unspent, so they are
 * the ones the terminal-window rule applies to. `5h` is deliberately absent:
 * it refills on its own, so there is never anything to rescue from it.
 */
export const WEEKLY_CLAIMS: ClaimId[] = ['7d', '7d_oi'];

/**
 * How close a WEEKLY reset must be before the 95% ceiling stops applying to
 * that claim.
 *
 * The ceiling keeps fresh sessions off an account that is nearly spent, on the
 * theory that they would exhaust it and immediately pay a cache re-create
 * somewhere else. That theory holds all week and inverts at the end of it: the
 * remainder on a window that resets in a few hours is thrown away otherwise,
 * so one re-create per session is cheap against it. Eight hours is long enough
 * to actually burn a 5% remainder across the live session population and short
 * enough that the ceiling means what it says for the rest of the week.
 *
 * `capAtCeiling` on an account disables this, keeping the flat 95% cap.
 */
export const DEFAULT_WEEKLY_TERMINAL_HORIZON_MS = 8 * 60 * 60 * 1000;

export type HeadroomBreakdown = {
  slot: string;
  /**
   * Normalized request-units of this model that still fit, as a fraction of a
   * Max 20x budget (see `PlanCapacity`). 0 = exhausted.
   */
  headroom: number;
  /**
   * Headroom beyond what staying on pace until the weekly reset would keep, in
   * model-normalized units of THIS account's weekly — not plan-scaled like
   * `headroom`, see the file header. Negative means behind pace. Fresh
   * ranking for every model leads on this (after expiring quota and the 5h
   * bucket); raw headroom still governs eligibility and affinity because a
   * warm session can consume its reserve. Only the weekly claims pace: the 5h
   * window is handled by `fiveHourBucket`. For non-Fable models the general
   * weekly is first reduced by `reservedForFable`.
   */
  spendableHeadroom: number;
  /**
   * General-weekly fraction held back from a non-Fable request's spendable
   * headroom because Fable's `7d_oi` sub-budget can still use it: remaining
   * `7d_oi` times the sub-budget's share of the weekly. Zero for Fable
   * requests and when `7d_oi` has never been observed on the account. Ranking
   * only; it never affects eligibility.
   */
  reservedForFable: number;
  /** Which claim is binding. */
  bindingClaim?: ClaimId;
  /** Projected reset of the general 7d claim, in milliseconds. */
  projectedWeeklyResetAt?: number;
  /**
   * The server reported the general weekly window as present but not open:
   * observed, zero, and with no reset. Distinct from a MISSING observation,
   * which also leaves `projectedWeeklyResetAt` undefined but means the
   * opposite — we know nothing and should find out.
   *
   * The two must never be conflated in ranking. An unobserved account sorts
   * FIRST so a request observes it; an account whose window has not opened
   * sorts LAST, because its quota has no deadline. The server anchors the
   * 7-day window on first use, so an unopened week is the one budget that
   * cannot expire unspent — and is therefore the last one worth spending.
   */
  weeklyWindowUnopened: boolean;
  /** Highest raw utilization across the claims this model touches, unscaled. */
  peakUtilization?: number;
  /**
   * True when peakUtilization crossed the threshold on a claim this model
   * touches, and that claim does not refill within the cache horizon. Fresh
   * picks avoid such accounts for any model; warm Fable sessions leave them.
   */
  evacuating: boolean;
  /**
   * Utilization the 5h window is projected to reach at its reset, assuming the
   * average burn rate so far continues: `utilization / elapsed fraction`,
   * capped at 1. Falls back to the raw level when less than
   * DEFAULT_5H_PROJECTION_MIN_ELAPSED of the window has elapsed or the reset
   * is unknown.
   */
  fiveHourProjected?: number;
  /**
   * Coarse 5h-pressure bucket, `floor(fiveHourProjected / DEFAULT_FRESH_5H_BUCKET)`.
   * 0 is coolest. Leads fresh-pick ranking after expiring quota; affinity and
   * eligibility are never affected by it. A window refilling within the cache
   * horizon, or one with no observed utilization, buckets as 0.
   */
  fiveHourBucket: number;
  /**
   * True when the general 7d window resets within the expiring horizon while
   * the account still has at least DEFAULT_EXPIRING_MIN_HEADROOM and is not
   * evacuating. Leads fresh ranking ahead of the 5h bucket. A warm session is
   * moved onto it only above DEFAULT_EXPIRING_PULL_MIN_HEADROOM, which is the
   * only condition that moves a warm non-Fable session off a serviceable
   * account.
   */
  weeklyExpiring: boolean;
  /**
   * True when a weekly claim this model is gated on is at or above the
   * evacuation threshold but resets inside the terminal horizon, so the
   * ceiling was lifted and this account is burning its remainder down to zero.
   * Reporting only — `evacuating` already carries the routing consequence.
   */
  weeklyTerminal: boolean;
  /** True when serving this request would require spending overage. */
  requiresOverage: boolean;
  /** True when the account can spend overage at all. */
  overageAvailable: boolean;
  eligible: boolean;
  reason?: string;
};

/** A claim we have no data for must not be treated as exhausted. */
const UNKNOWN_HEADROOM = 1;

function claimHeadroom(claim: Claim | undefined, nowMs: number): number | undefined {
  if (!claim) return undefined;
  // Reset is checked FIRST. A rejected claim whose window has since rolled over
  // is stale, not exhausted — checking status first would strand the account
  // permanently, because an excluded account never gets a response that could
  // replace the stale observation.
  if (claimHasReset(claim, nowMs)) return 1;
  if (claim.status === 'rejected') return 0;
  if (claim.utilization === undefined) return undefined;
  return Math.max(0, 1 - claim.utilization);
}

/**
 * Headroom for `model` on one account, in normalized request-units.
 *
 * General claims are divided by the model's cost multiplier because a Fable
 * request eats the weekly budget twice as fast as an Opus one — so the same
 * 9% remaining weekly is worth half as many Fable requests.
 *
 * The model's extra claim (Fable's `7d_oi`) is NOT divided: that budget is
 * already denominated in this model's own units.
 */
/**
 * General-weekly fraction still claimable by models gated on a sub-budget of
 * it (Fable's `7d_oi`). Only an observed sub-budget claim reserves anything:
 * reservation reorders accounts on what is known, and a never-seen claim is
 * the same unknown on every account.
 */
function reservedSubBudgets(claims: Claims | undefined, nowMs: number): number {
  let reserved = 0;
  for (const quota of Object.values(MODEL_QUOTAS)) {
    if (!quota.extraClaim) continue;
    const remaining = claimHeadroom(claims?.byId[quota.extraClaim], nowMs);
    if (remaining === undefined) continue;
    reserved += remaining * (claims?.fallbackPercentage ?? quota.subBudgetFraction ?? 1);
  }
  return reserved;
}

/**
 * How far out a claim's reset must be before crossing the evacuation threshold
 * is worth paying a cache re-create for. Defaults to the prompt-cache TTL: if
 * the window refills before the cache would have expired anyway, moving buys
 * nothing and costs 20x.
 */
export const DEFAULT_EVACUATION_HORIZON_MS = 60 * 60 * 1000;

export type HeadroomOptions = {
  evacuateThreshold?: number;
  evacuationHorizonMs?: number;
  fresh5hBucket?: number;
  expiringHorizonMs?: number;
  expiringMinHeadroom?: number;
  weeklyTerminalHorizonMs?: number;
};

/**
 * How near a reset must be for a claim at or above the threshold to stop
 * raising the ceiling — the single place the two horizons are chosen between,
 * so the statusline badge and the router cannot disagree about what the
 * threshold means.
 *
 * A `5h` claim gets the cache TTL: the only question there is whether a move
 * would buy anything before the prefix expired anyway. A weekly claim gets the
 * much longer terminal horizon, because its remainder expires for good. An
 * account with `capAtCeiling` is held to the cache TTL on every claim.
 */
export function evacuationHorizonMsFor(
  claimId: string,
  capAtCeiling: boolean | undefined,
  options: Pick<HeadroomOptions, 'evacuationHorizonMs' | 'weeklyTerminalHorizonMs'> = {},
): number {
  const cacheHorizon = options.evacuationHorizonMs ?? DEFAULT_EVACUATION_HORIZON_MS;
  if (capAtCeiling) return cacheHorizon;
  if (!WEEKLY_CLAIMS.includes(claimId as ClaimId)) return cacheHorizon;
  return Math.max(cacheHorizon, options.weeklyTerminalHorizonMs ?? DEFAULT_WEEKLY_TERMINAL_HORIZON_MS);
}

export function computeHeadroom(
  account: AccountState,
  model: string | undefined,
  nowMs: number,
  options: HeadroomOptions = {},
): HeadroomBreakdown {
  const evacuateThreshold = options.evacuateThreshold ?? DEFAULT_EVACUATE_UTILIZATION;
  const evacuationHorizonMs = options.evacuationHorizonMs ?? DEFAULT_EVACUATION_HORIZON_MS;
  const fresh5hBucket = options.fresh5hBucket ?? DEFAULT_FRESH_5H_BUCKET;
  const expiringHorizonMs = options.expiringHorizonMs ?? DEFAULT_EXPIRING_WEEKLY_HORIZON_MS;
  const expiringMinHeadroom = options.expiringMinHeadroom ?? DEFAULT_EXPIRING_MIN_HEADROOM;
  const quota = quotaForModel(model);
  const capacity = account.capacity ?? REFERENCE_CAPACITY;
  const claims = projectExpiredClaims(account.claims, nowMs);
  let evacuationTriggered = false;
  let weeklyTerminal = false;
  let fiveHourBucket = 0;
  let fiveHourProjected: number | undefined;
  const overage = claims?.byId['overage'];
  const overageAvailable = overage?.status === 'allowed';
  const weeklyReset = claims?.byId['7d']?.reset;
  const weeklyClaim = claims?.byId['7d'];
  const weeklyWindowUnopened =
    weeklyClaim !== undefined &&
    weeklyClaim.utilization !== undefined &&
    weeklyClaim.reset === undefined;

  const base: HeadroomBreakdown = {
    slot: account.slot,
    headroom: 0,
    spendableHeadroom: 0,
    projectedWeeklyResetAt: weeklyReset === undefined ? undefined : weeklyReset * 1000,
    weeklyWindowUnopened,
    reservedForFable: 0,
    fiveHourBucket: 0,
    weeklyExpiring: false,
    weeklyTerminal: false,
    evacuating: false,
    requiresOverage: false,
    overageAvailable,
    eligible: false,
  };

  if (account.health === 'needs-reauth') return { ...base, reason: 'needs-reauth' };
  if (account.tokenExpiresAt !== undefined && account.tokenExpiresAt <= nowMs) {
    return { ...base, reason: 'token-expired' };
  }

  const ids = [...GENERAL_CLAIMS, ...(quota.extraClaim ? [quota.extraClaim] : [])];
  // The response's own value wins; the model table supplies the fallback.
  const subBudget =
    claims?.fallbackPercentage ?? quota.subBudgetFraction ?? 1;
  const reservedForFable = quota.extraClaim ? 0 : reservedSubBudgets(claims, nowMs);

  let min = Number.POSITIVE_INFINITY;
  let minSpendable = Number.POSITIVE_INFINITY;
  let binding: ClaimId | undefined;
  let peak: number | undefined;
  let sawAny = false;

  for (const id of ids) {
    const claim = claims?.byId[id];
    const raw = claimHeadroom(claim, nowMs);
    if (raw === undefined) continue;
    sawAny = true;

    // Peak utilization drives evacuation, and only a genuinely observed number
    // belongs in it. A `rejected` claim yields headroom 0, but reporting that
    // as "100.0% utilized" asserts a figure the server never sent.
    if (claim?.utilization !== undefined && !claimHasReset(claim, nowMs)) {
      const observed = claim.utilization;
      if (peak === undefined || observed > peak) peak = observed;
      // A window that refills before the prompt cache expires is not worth a
      // paid move: evacuating a 260k-token session to conserve a 5h bucket
      // that resets in seven minutes costs 20x and saves nothing. A WEEKLY
      // window gets a much longer horizon, because what is left on it when it
      // rolls over is destroyed rather than carried — see
      // `evacuationHorizonMsFor`. Only claims whose reset is beyond the
      // applicable horizon can trigger an evacuation.
      const horizon = evacuationHorizonMsFor(id, account.capAtCeiling, {
        evacuationHorizonMs,
        weeklyTerminalHorizonMs: options.weeklyTerminalHorizonMs,
      });
      const resetsSoon = claim.reset !== undefined && claim.reset * 1000 - nowMs <= horizon;
      if (observed >= evacuateThreshold && !resetsSoon) evacuationTriggered = true;
      if (observed >= evacuateThreshold && resetsSoon && WEEKLY_CLAIMS.includes(id)) {
        weeklyTerminal = true;
      }
    }

    // Put every claim in the same unit: normalized requests-of-this-model as a
    // fraction of the general weekly budget.
    //   general claim : r  buys r*B/(mult*c)      -> r / mult
    //   extra claim   : r  buys r*subBudget*B/(mult*c) -> r * subBudget / mult
    // Without the subBudget factor a half-sized Fable budget reads as if it
    // were full-sized, and cross-account ranking compares incommensurate
    // numbers whenever one account binds on 7d_oi and another on 7d. The plan
    // factor does the same job across accounts of different sizes, for
    // `headroom` only — pacing below stays in this account's own fractions.
    const scale = id === quota.extraClaim
      ? subBudget / quota.costMultiplier
      : 1 / quota.costMultiplier;
    const scaled = raw * scale * (id === '5h' ? capacity.fiveHour : capacity.weekly);
    if (scaled < min) {
      min = scaled;
      binding = id;
    }

    const windowMs = id === '5h' ? 5 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
    const timeRemaining = claim?.reset === undefined
      ? undefined
      : Math.max(0, Math.min(1, (claim.reset * 1000 - nowMs) / windowMs));

    if (id === '5h') {
      // Pressure is what the window will reach, not where it is. The window
      // started at reset - 5h, so the average rate so far is util / elapsed.
      const elapsed = timeRemaining === undefined ? undefined : 1 - timeRemaining;
      const observed = claim?.utilization;
      if (observed !== undefined && !claimHasReset(claim!, nowMs)) {
        fiveHourProjected = elapsed !== undefined && elapsed >= DEFAULT_5H_PROJECTION_MIN_ELAPSED
          ? Math.min(1, observed / elapsed)
          : observed;
        const resetsSoon =
          claim!.reset !== undefined && claim!.reset * 1000 - nowMs <= evacuationHorizonMs;
        if (!resetsSoon && fresh5hBucket > 0) {
          fiveHourBucket = Math.floor(fiveHourProjected / fresh5hBucket);
        }
      }
      continue;
    }

    // Conserve weekly quota in proportion to time left in the server's own
    // window. Example: 68% remaining with 23% of the week left is 45% ahead of
    // pace; 98% remaining with 91% left is only 7% ahead. Ranking raw
    // remainder alone burns the account whose reset is furthest away. The
    // general claim also gives up what Fable can still spend of it.
    const held = id === '7d' ? reservedForFable : 0;
    // `timeRemaining` is the fraction of the window still ahead, and pacing
    // holds back quota in proportion to it. A window the server has not opened
    // has its ENTIRE period ahead, not none of it: treating the missing reset
    // as 0 inverts the term and makes the one account with no deadline look
    // like the most urgent place to spend.
    const remainingFraction =
      timeRemaining ?? (id === '7d' && weeklyWindowUnopened ? 1 : 0);
    minSpendable = Math.min(minSpendable, (raw - remainingFraction - held) * scale);
  }

  const headroom = sawAny ? min : UNKNOWN_HEADROOM * Math.min(capacity.fiveHour, capacity.weekly);
  const spendableHeadroom = sawAny && minSpendable !== Number.POSITIVE_INFINITY
    ? minSpendable
    : UNKNOWN_HEADROOM - reservedForFable;
  // Model-agnostic: `evacuationTriggered` already only saw the claims this
  // model is gated on. What differs by model is the CONSEQUENCE — see
  // `selectAccount`, where a warm non-Fable session holds through it.
  const evacuating = evacuationTriggered;
  // Only a genuinely observed weekly window can expire; a projected or unknown
  // reset is not a deadline. The headroom gate is model-normalized so a Fable
  // request does not chase an account whose 7d_oi is already spent.
  const weeklyResetMs = base.projectedWeeklyResetAt;
  const weeklyExpiring =
    weeklyResetMs !== undefined &&
    weeklyResetMs > nowMs &&
    weeklyResetMs - nowMs <= expiringHorizonMs &&
    headroom >= expiringMinHeadroom &&
    !evacuating;
  return {
    ...base,
    headroom,
    spendableHeadroom,
    bindingClaim: sawAny ? binding : undefined,
    peakUtilization: peak,
    reservedForFable,
    fiveHourProjected,
    fiveHourBucket,
    weeklyExpiring,
    weeklyTerminal,
    evacuating,
    requiresOverage: headroom <= 0,
    eligible: headroom > 0 || overageAvailable,
    reason: headroom > 0 ? (evacuating ? 'evacuating' : undefined) : overageAvailable ? 'exhausted-overage-available' : 'exhausted',
  };
}

export type SelectInput = {
  accounts: AccountState[];
  model?: string;
  /** Slot this session is already pinned to, if any. */
  affinitySlot?: string;
  nowMs: number;
  /**
   * Whether the balancer may route to an account that has to spend overage
   * (real money) to serve the request. Default false: exhaustion should be
   * visible, not silently billed.
   */
  allowOverage?: boolean;
  /**
   * Headroom below which a sticky Fable session is moved anyway. Non-Fable
   * affinity holds through every positive amount of model-relevant quota.
   */
  affinityFloor?: number;
  /**
   * Raw utilization at or above which an account stops taking fresh sessions
   * (all models) and a warm Fable session is evacuated.
   */
  evacuateThreshold?: number;
  /**
   * Width of the 5h-pressure buckets that lead fresh-pick ranking. A larger
   * value spreads less; a value at or above 1 disables spreading entirely by
   * putting every account in bucket 0. See DEFAULT_FRESH_5H_BUCKET.
   */
  fresh5hBucket?: number;
  /**
   * Window before a general 7d reset inside which unspent weekly quota is
   * treated as expiring. See DEFAULT_EXPIRING_WEEKLY_HORIZON_MS. A value of 0
   * disables the term.
   */
  expiringHorizonMs?: number;
  /**
   * How close a weekly reset must be before the evacuation ceiling stops
   * applying to that claim, so the account burns its remainder to zero. `0`
   * restores the flat ceiling for every account. See
   * DEFAULT_WEEKLY_TERMINAL_HORIZON_MS.
   */
  weeklyTerminalHorizonMs?: number;
};

export type Selection = {
  slot?: string;
  /** Why this slot: kept an existing lease, or picked fresh. */
  decision:
    | 'affinity-hold'
    | 'affinity-broken'
    | 'fresh'
    | 'evacuating-fallback'
    | 'overage-fallback'
    | 'exhausted';
  reason: string;
  breakdown: HeadroomBreakdown[];
};

const DEFAULT_AFFINITY_FLOOR = 0.001;

/**
 * Choose the account to serve one request.
 *
 * Non-Fable fresh sessions drain the account with the earliest known projected
 * general-weekly reset, and affinity holds until hard exhaustion. Fable keeps
 * spendable-headroom ranking and proactive evacuation. Overage remains last.
 */
export function selectAccount(input: SelectInput): Selection {
  const floor = input.affinityFloor ?? DEFAULT_AFFINITY_FLOOR;
  const allowOverage = input.allowOverage ?? false;
  const threshold = input.evacuateThreshold ?? DEFAULT_EVACUATE_UTILIZATION;
  const bucketWidth = input.fresh5hBucket ?? DEFAULT_FRESH_5H_BUCKET;
  const expiringHorizon = input.expiringHorizonMs ?? DEFAULT_EXPIRING_WEEKLY_HORIZON_MS;
  const fable = quotaForModel(input.model).extraClaim !== undefined;
  const breakdown = input.accounts.map(a =>
    computeHeadroom(a, input.model, input.nowMs, {
      evacuateThreshold: threshold,
      fresh5hBucket: bucketWidth,
      expiringHorizonMs: expiringHorizon,
      weeklyTerminalHorizonMs: input.weeklyTerminalHorizonMs,
    }),
  );
  const bySlot = new Map(breakdown.map(b => [b.slot, b]));

  const serviceable = breakdown.filter(b => b.headroom > (fable ? floor : 0) && !b.requiresOverage);
  // The ceiling applies to fresh picks for every model, but only while it
  // leaves somewhere to go. When every serviceable account is above it, the
  // move is pure cost, so the ceiling is dropped and ranking decides.
  const belowCeiling = serviceable.filter(b => !b.evacuating);
  // Fable keeps its dedicated all-evacuating path below, which prefers the
  // sticky slot's cache. Non-Fable has no such path, so it falls back here.
  const healthy = fable || belowCeiling.length > 0 ? belowCeiling : serviceable;
  // Every model paces the weekly: furthest ahead of pace first, then the most
  // raw headroom, then the earliest known reset, then stable slot order.
  const cmpBase = (a: HeadroomBreakdown, b: HeadroomBreakdown) => {
    if (a.spendableHeadroom !== b.spendableHeadroom) return b.spendableHeadroom - a.spendableHeadroom;
    if (a.headroom !== b.headroom) return b.headroom - a.headroom;
    const aReset = a.projectedWeeklyResetAt;
    const bReset = b.projectedWeeklyResetAt;
    if (aReset !== undefined && bReset !== undefined && aReset !== bReset) return aReset - bReset;
    if (aReset !== undefined && bReset === undefined) return -1;
    if (aReset === undefined && bReset !== undefined) return 1;
    return a.slot.localeCompare(b.slot, undefined, { numeric: true });
  };
  // Expiring weekly quota leads everything, including the 5h spread: quota
  // that vanishes at the reset is worth more than a cooler 5h bucket. Between
  // two expiring accounts the earlier deadline wins for every model.
  const cmpExpiring = (a: HeadroomBreakdown, b: HeadroomBreakdown) =>
    Number(b.weeklyExpiring) - Number(a.weeklyExpiring) ||
    (a.weeklyExpiring && b.weeklyExpiring
      ? (a.projectedWeeklyResetAt ?? 0) - (b.projectedWeeklyResetAt ?? 0)
      : 0);
  // Earliest weekly reset, in whole days. Three states, not two:
  //   unobserved        -> -1, sorts first so a request observes it (cmpBase)
  //   window not opened -> last, its quota has no deadline to beat
  //   observed reset    -> the day it falls on
  const UNOBSERVED_FIRST = -1;
  const NO_DEADLINE_LAST = Number.MAX_SAFE_INTEGER;
  const resetDay = (b: HeadroomBreakdown) => {
    if (b.projectedWeeklyResetAt !== undefined) {
      return Math.floor((b.projectedWeeklyResetAt - input.nowMs) / 86_400_000);
    }
    return b.weeklyWindowUnopened ? NO_DEADLINE_LAST : UNOBSERVED_FIRST;
  };
  const cmpResetDay = (a: HeadroomBreakdown, b: HeadroomBreakdown) => {
    const da = resetDay(a);
    const db = resetDay(b);
    return da === db ? 0 : da < db ? -1 : 1;
  };
  const days = (b: HeadroomBreakdown) => {
    if (b.projectedWeeklyResetAt !== undefined) {
      return `${((b.projectedWeeklyResetAt - input.nowMs) / 86_400_000).toFixed(1)}d`;
    }
    // A freshly-swept idle account IS observed; saying otherwise makes the
    // routing reason lie to whoever is reading the log.
    return b.weeklyWindowUnopened ? 'no window open' : 'unobserved';
  };
  const cmpBucket = (a: HeadroomBreakdown, b: HeadroomBreakdown) => a.fiveHourBucket - b.fiveHourBucket;
  const cmpFresh = (a: HeadroomBreakdown, b: HeadroomBreakdown) =>
    cmpExpiring(a, b) || cmpResetDay(a, b) || cmpBucket(a, b) || cmpBase(a, b);
  const rankBase = (pool: HeadroomBreakdown[]) => [...pool].sort(cmpBase);
  const rankNoResetDay = (pool: HeadroomBreakdown[]) =>
    [...pool].sort((a, b) => cmpExpiring(a, b) || cmpBucket(a, b) || cmpBase(a, b));
  const rank = (pool: HeadroomBreakdown[]) => [...pool].sort(cmpFresh);
  // Only accounts that can take a fresh session count: an expiring account
  // above the ceiling is not somewhere a session should be moved. A warm move
  // also clears a higher headroom bar than a fresh placement does, because it
  // is the one that pays a cache re-create for the privilege.
  const expiring = healthy.filter(
    b => b.weeklyExpiring && b.headroom >= DEFAULT_EXPIRING_PULL_MIN_HEADROOM,
  );

  if (input.affinitySlot) {
    const held = bySlot.get(input.affinitySlot);
    if (held && held.headroom > (fable ? floor : 0) && !held.requiresOverage) {
      // The one planned break of a serviceable hold: another account's weekly
      // quota is about to expire unspent. A session already on an expiring
      // account stays — moving it to an even earlier deadline gains nothing.
      const pulled = !held.weeklyExpiring && expiring.length > 0;
      if (!pulled && (!fable || !held.evacuating)) {
        return {
          slot: held.slot,
          decision: 'affinity-hold',
          reason: fable
            ? `holding Fable session affinity (headroom ${held.headroom.toFixed(3)} on ${held.bindingClaim ?? 'unknown'})`
            : `holding non-Fable session affinity until quota exhaustion (headroom ${held.headroom.toFixed(3)} on ${held.bindingClaim ?? 'unknown'})`,
          breakdown,
        };
      }
      // Fable evacuation remains proactive, but never pays a cache re-create
      // when every alternative is also evacuating.
      if (belowCeiling.length === 0) {
        return {
          slot: held.slot,
          decision: 'evacuating-fallback',
          reason: `all Fable accounts at or above ${(threshold * 100).toFixed(0)}%; staying on ${held.slot} to keep its cache`,
          breakdown,
        };
      }
    }
  }

  const allAboveCeiling = belowCeiling.length === 0 && serviceable.length > 0;
  // The 5h bucket shrinks the herd that can exhaust one 5h bucket together:
  // fresh sessions have no cache to lose, so steering them onto a cooler
  // account is free. `rankBase` is the same pool without the bucket term, so
  // the reason can say when the bucket actually changed the outcome.
  const pick = rank(healthy)[0];
  const unbucketed = rankBase(healthy)[0];
  const noResetDay = rankNoResetDay(healthy)[0];
  // The reset-day term is reported when it changed the outcome; the bucket
  // note otherwise, so a reason names the one term that decided. An expiring
  // pick is neither: it outranks both, and `unbucketed` — which drops the
  // expiring term along with the bucket — would otherwise credit the bucket
  // for an outcome the deadline decided.
  const bucketNote = pick?.weeklyExpiring
    ? ''
    : pick && noResetDay && pick.slot !== noResetDay.slot
      ? `; weekly on ${pick.slot} resets in ${days(pick)}, earliest, beat ${noResetDay.slot} (${days(noResetDay)})`
      : pick && unbucketed && pick.slot !== unbucketed.slot
        ? `; projected 5h bucket ${pick.fiveHourBucket} on ${pick.slot} beat bucket ${unbucketed.fiveHourBucket} on ${unbucketed.slot}`
        : '';
  if (pick) {
    const broke = Boolean(input.affinitySlot && input.affinitySlot !== pick.slot);
    const evacuated = fable && broke && bySlot.get(input.affinitySlot!)?.evacuating === true;
    const expiringNote = pick.weeklyExpiring
      ? `weekly quota on ${pick.slot} expires in ${((pick.projectedWeeklyResetAt! - input.nowMs) / 3_600_000).toFixed(1)}h with ${(pick.headroom * 100).toFixed(0)}% headroom unspent${pick.weeklyTerminal ? `, burning past the ${(threshold * 100).toFixed(0)}% ceiling` : ''}`
      : undefined;
    return {
      slot: pick.slot,
      decision: broke ? 'affinity-broken' : 'fresh',
      reason: (broke
        ? expiringNote
          ? `${expiringNote}; moved sticky slot ${input.affinitySlot} there (one cache re-create)`
          : evacuated
            ? `sticky Fable slot ${input.affinitySlot} at ${((bySlot.get(input.affinitySlot!)?.peakUtilization ?? 0) * 100).toFixed(1)}%; evacuated to ${pick.slot}`
            : `sticky slot ${input.affinitySlot} could not serve; moved to ${pick.slot} (one cache re-create)`
        : expiringNote
          ? `${expiringNote}; draining it first`
          : allAboveCeiling
            ? `every account at or above ${(threshold * 100).toFixed(0)}%; using ${pick.slot} anyway (moving buys nothing)`
            : `most spendable ${fable ? 'Fable ' : ''}headroom on ${pick.slot} (${pick.spendableHeadroom.toFixed(3)} ahead of pace, ${pick.headroom.toFixed(3)} raw on ${pick.bindingClaim ?? 'unknown'}${pick.reservedForFable > 0 ? `, ${pick.reservedForFable.toFixed(3)} held for Fable` : ''})`) + bucketNote,
      breakdown,
    };
  }

  // Only Fable has an evacuating pool. Prefer its sticky slot because its cache
  // is the only thing of value still on the table.
  const evacuatingPool = fable ? rank(serviceable) : [];
  const stickyEvacuating = input.affinitySlot
    ? evacuatingPool.find(b => b.slot === input.affinitySlot)
    : undefined;
  const fallback = stickyEvacuating ?? evacuatingPool[0];
  if (fallback) {
    return {
      slot: fallback.slot,
      decision: 'evacuating-fallback',
      reason: `all Fable accounts at or above ${(threshold * 100).toFixed(0)}%; using ${fallback.slot}`,
      breakdown,
    };
  }

  if (allowOverage) {
    const overage = breakdown
      .filter(b => b.eligible && b.overageAvailable)
      .sort((a, b) => a.slot.localeCompare(b.slot));
    const held = input.affinitySlot ? overage.find(b => b.slot === input.affinitySlot) : undefined;
    const chosen = held ?? overage[0];
    if (chosen) {
      return {
        slot: chosen.slot,
        decision: 'overage-fallback',
        reason: `all accounts exhausted; spending overage on ${chosen.slot}`,
        breakdown,
      };
    }
  }

  return {
    decision: 'exhausted',
    reason: 'no account can serve this request',
    breakdown,
  };
}
