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

export type HeadroomBreakdown = {
  slot: string;
  /** Normalized request-units of this model that still fit. 0 = exhausted. */
  headroom: number;
  /**
   * Headroom that can be spent now while remaining on pace until each window
   * resets. Fresh-session ranking uses this; raw headroom still governs hard
   * eligibility and affinity because a warm session can consume its reserve.
   */
  spendableHeadroom: number;
  /** Which claim is binding. */
  bindingClaim?: ClaimId;
  /** Projected reset of the general 7d claim, in milliseconds. */
  projectedWeeklyResetAt?: number;
  /** Highest raw utilization across the claims this model touches, unscaled. */
  peakUtilization?: number;
  /**
   * True when peakUtilization crossed the threshold on a claim this model
   * touches, and that claim does not refill within the cache horizon. Fresh
   * picks avoid such accounts for any model; warm Fable sessions leave them.
   */
  evacuating: boolean;
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
 * How far out a claim's reset must be before crossing the evacuation threshold
 * is worth paying a cache re-create for. Defaults to the prompt-cache TTL: if
 * the window refills before the cache would have expired anyway, moving buys
 * nothing and costs 20x.
 */
export const DEFAULT_EVACUATION_HORIZON_MS = 60 * 60 * 1000;

export function computeHeadroom(
  account: AccountState,
  model: string | undefined,
  nowMs: number,
  evacuateThreshold: number = DEFAULT_EVACUATE_UTILIZATION,
  evacuationHorizonMs: number = DEFAULT_EVACUATION_HORIZON_MS,
): HeadroomBreakdown {
  const quota = quotaForModel(model);
  const claims = projectExpiredClaims(account.claims, nowMs);
  let evacuationTriggered = false;
  const overage = claims?.byId['overage'];
  const overageAvailable = overage?.status === 'allowed';
  const weeklyReset = claims?.byId['7d']?.reset;

  const base: HeadroomBreakdown = {
    slot: account.slot,
    headroom: 0,
    spendableHeadroom: 0,
    projectedWeeklyResetAt: weeklyReset === undefined ? undefined : weeklyReset * 1000,
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
      // that resets in seven minutes costs 20x and saves nothing. Only claims
      // whose reset is beyond the cache horizon can trigger an evacuation.
      const resetsSoon =
        claim.reset !== undefined && claim.reset * 1000 - nowMs <= evacuationHorizonMs;
      if (observed >= evacuateThreshold && !resetsSoon) evacuationTriggered = true;
    }

    // Put every claim in the same unit: normalized requests-of-this-model as a
    // fraction of the general weekly budget.
    //   general claim : r  buys r*B/(mult*c)      -> r / mult
    //   extra claim   : r  buys r*subBudget*B/(mult*c) -> r * subBudget / mult
    // Without the subBudget factor a half-sized Fable budget reads as if it
    // were full-sized, and cross-account ranking compares incommensurate
    // numbers whenever one account binds on 7d_oi and another on 7d.
    const scale = id === quota.extraClaim
      ? subBudget / quota.costMultiplier
      : 1 / quota.costMultiplier;
    const scaled = raw * scale;
    if (scaled < min) {
      min = scaled;
      binding = id;
    }

    // Conserve quota in proportion to time left in the server's own window.
    // Example: 68% weekly remaining with 23% of the week left has 45% available
    // to spend now; 98% remaining with 91% left has only 7% available. Ranking
    // raw remainder alone burns the account whose reset is furthest away.
    const windowMs = id === '5h' ? 5 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
    const timeRemaining = claim?.reset === undefined
      ? 0
      : Math.max(0, Math.min(1, (claim.reset * 1000 - nowMs) / windowMs));
    minSpendable = Math.min(minSpendable, Math.max(0, raw - timeRemaining) * scale);
  }

  const headroom = sawAny ? min : UNKNOWN_HEADROOM;
  const spendableHeadroom = sawAny ? minSpendable : UNKNOWN_HEADROOM;
  // Model-agnostic: `evacuationTriggered` already only saw the claims this
  // model is gated on. What differs by model is the CONSEQUENCE — see
  // `selectAccount`, where a warm non-Fable session holds through it.
  const evacuating = evacuationTriggered;
  return {
    ...base,
    headroom,
    spendableHeadroom,
    bindingClaim: sawAny ? binding : undefined,
    peakUtilization: peak,
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
  const fable = quotaForModel(input.model).extraClaim !== undefined;
  const breakdown = input.accounts.map(a =>
    computeHeadroom(a, input.model, input.nowMs, threshold),
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
  const rankFable = (pool: HeadroomBreakdown[]) =>
    [...pool].sort((a, b) =>
      b.spendableHeadroom - a.spendableHeadroom ||
      b.headroom - a.headroom ||
      a.slot.localeCompare(b.slot),
    );
  const rankDrainFirst = (pool: HeadroomBreakdown[]) =>
    [...pool].sort((a, b) => {
      const aReset = a.projectedWeeklyResetAt;
      const bReset = b.projectedWeeklyResetAt;
      if (aReset !== undefined && bReset !== undefined && aReset !== bReset) return aReset - bReset;
      if (aReset !== undefined && bReset === undefined) return -1;
      if (aReset === undefined && bReset !== undefined) return 1;
      return a.slot.localeCompare(b.slot, undefined, { numeric: true });
    });
  const rank = fable ? rankFable : rankDrainFirst;

  if (input.affinitySlot) {
    const held = bySlot.get(input.affinitySlot);
    if (held && held.headroom > (fable ? floor : 0) && !held.requiresOverage) {
      if (!fable || !held.evacuating) {
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
  const pick = rank(healthy)[0];
  if (pick) {
    const broke = Boolean(input.affinitySlot && input.affinitySlot !== pick.slot);
    const evacuated = fable && broke && bySlot.get(input.affinitySlot!)?.evacuating === true;
    return {
      slot: pick.slot,
      decision: broke ? 'affinity-broken' : 'fresh',
      reason: broke
        ? evacuated
          ? `sticky Fable slot ${input.affinitySlot} at ${((bySlot.get(input.affinitySlot!)?.peakUtilization ?? 0) * 100).toFixed(1)}%; evacuated to ${pick.slot}`
          : `sticky slot ${input.affinitySlot} could not serve; moved to ${pick.slot} (one cache re-create)`
        : fable
          ? `most spendable Fable headroom (${pick.spendableHeadroom.toFixed(3)} conserved, ${pick.headroom.toFixed(3)} raw on ${pick.bindingClaim ?? 'unknown'})`
          : allAboveCeiling
            ? `every account at or above ${(threshold * 100).toFixed(0)}%; draining ${pick.slot} anyway (moving buys nothing)`
            : pick.projectedWeeklyResetAt === undefined
              ? `draining ${pick.slot}; general 7d reset unknown (stable slot order)`
              : `draining ${pick.slot}; earliest projected general 7d reset ${new Date(pick.projectedWeeklyResetAt).toISOString()}`,
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
