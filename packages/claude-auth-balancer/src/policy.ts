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
// Therefore: affinity wins by default. We only break a session's account when
// that account genuinely cannot serve the request. We never rebalance a live
// session for a marginal headroom gain.

import type { Claim, ClaimId, Claims } from './claims.js';
import { claimHasReset } from './claims.js';

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
 * Utilization at which an account is evacuated: any session on it moves to
 * another account, and no new session is routed to it — unless every account
 * is at or above this line, in which case there is nowhere better to go.
 *
 * This is a raw-utilization threshold, deliberately not a headroom one. The
 * question "is this account nearly spent?" is about the plan's own meter, not
 * about how fast the requested model happens to burn it.
 */
export const DEFAULT_EVACUATE_UTILIZATION = 0.95;

export type HeadroomBreakdown = {
  slot: string;
  /** Normalized request-units of this model that still fit. 0 = exhausted. */
  headroom: number;
  /** Which claim is binding. */
  bindingClaim?: ClaimId;
  /** Highest raw utilization across the claims this model touches, unscaled. */
  peakUtilization?: number;
  /** True when peakUtilization crossed the evacuation threshold. */
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
  let evacuationTriggered = false;
  const overage = account.claims?.byId['overage'];
  const overageAvailable = overage?.status === 'allowed';

  const base: HeadroomBreakdown = {
    slot: account.slot,
    headroom: 0,
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
    account.claims?.fallbackPercentage ?? quota.subBudgetFraction ?? 1;

  let min = Number.POSITIVE_INFINITY;
  let binding: ClaimId | undefined;
  let peak: number | undefined;
  let sawAny = false;

  for (const id of ids) {
    const claim = account.claims?.byId[id];
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
    const scaled =
      id === quota.extraClaim
        ? (raw * subBudget) / quota.costMultiplier
        : raw / quota.costMultiplier;
    if (scaled < min) {
      min = scaled;
      binding = id;
    }
  }

  const headroom = sawAny ? min : UNKNOWN_HEADROOM;
  const evacuating = evacuationTriggered;
  return {
    ...base,
    headroom,
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
   * Headroom below which a sticky session is moved anyway. Deliberately tiny —
   * breaking affinity costs 20x on the next request, so we hold on until the
   * account is effectively done.
   */
  affinityFloor?: number;
  /**
   * Raw utilization at or above which an account is evacuated. Overrides
   * affinity: a session on a 95%-spent account moves, because riding it to
   * exhaustion strands the session mid-conversation with nowhere to go.
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
 * Order:
 *  1. Hold the session's existing account while it has any real headroom.
 *  2. Otherwise take the eligible non-overage account with the most headroom.
 *  3. Otherwise, only if allowed, fall back to an overage-capable account.
 *  4. Otherwise report exhaustion so the caller can surface a 429 honestly.
 */
export function selectAccount(input: SelectInput): Selection {
  const floor = input.affinityFloor ?? DEFAULT_AFFINITY_FLOOR;
  const allowOverage = input.allowOverage ?? false;
  const threshold = input.evacuateThreshold ?? DEFAULT_EVACUATE_UTILIZATION;
  const breakdown = input.accounts.map(a =>
    computeHeadroom(a, input.model, input.nowMs, threshold),
  );
  const bySlot = new Map(breakdown.map(b => [b.slot, b]));

  const serviceable = breakdown.filter(b => b.headroom > floor && !b.requiresOverage);
  const healthy = serviceable.filter(b => !b.evacuating);
  const rank = (pool: HeadroomBreakdown[]) =>
    [...pool].sort((a, b) => b.headroom - a.headroom || a.slot.localeCompare(b.slot));

  // Affinity holds only on an account that is not evacuating. Once an account
  // crosses the threshold we move the session while a move is still cheap and
  // another account is still available to move to.
  if (input.affinitySlot) {
    const held = bySlot.get(input.affinitySlot);
    if (held && held.headroom > floor && !held.requiresOverage) {
      if (!held.evacuating) {
        return {
          slot: held.slot,
          decision: 'affinity-hold',
          reason: `holding session affinity (headroom ${held.headroom.toFixed(3)} on ${held.bindingClaim ?? 'unknown'})`,
          breakdown,
        };
      }
      // Evacuating — but if nothing better exists, staying put is strictly
      // better than paying a cache re-create for no quota gain.
      if (healthy.length === 0) {
        return {
          slot: held.slot,
          decision: 'evacuating-fallback',
          reason: `all accounts at or above ${(threshold * 100).toFixed(0)}%; staying on ${held.slot} to keep its cache`,
          breakdown,
        };
      }
    }
  }

  const pick = rank(healthy)[0];

  if (pick) {
    const broke = Boolean(input.affinitySlot && input.affinitySlot !== pick.slot);
    const evacuated = broke && bySlot.get(input.affinitySlot!)?.evacuating === true;
    return {
      slot: pick.slot,
      decision: broke ? 'affinity-broken' : 'fresh',
      reason: broke
        ? evacuated
          ? `sticky slot ${input.affinitySlot} at ${((bySlot.get(input.affinitySlot!)?.peakUtilization ?? 0) * 100).toFixed(1)}%; evacuated to ${pick.slot}`
          : `sticky slot ${input.affinitySlot} could not serve; moved to ${pick.slot} (one cache re-create)`
        : `most headroom (${pick.headroom.toFixed(3)} on ${pick.bindingClaim ?? 'unknown'})`,
      breakdown,
    };
  }

  // Everything left is evacuating. Prefer the sticky slot — its cache is the
  // only thing of value still on the table.
  const evacuatingPool = rank(serviceable);
  const stickyEvacuating = input.affinitySlot
    ? evacuatingPool.find(b => b.slot === input.affinitySlot)
    : undefined;
  const fallback = stickyEvacuating ?? evacuatingPool[0];
  if (fallback) {
    return {
      slot: fallback.slot,
      decision: 'evacuating-fallback',
      reason: `all accounts at or above ${(threshold * 100).toFixed(0)}%; using ${fallback.slot}`,
      breakdown,
    };
  }

  if (allowOverage) {
    // Filter on the structured predicate, never on the human-readable `reason`
    // string: a new disqualifying early-return would otherwise silently make an
    // unusable account an overage candidate and send an expired token upstream.
    const overage = breakdown
      .filter(b => b.eligible && b.overageAvailable)
      .sort((a, b) => a.slot.localeCompare(b.slot));
    // Prefer the sticky slot even here — it is the only one holding a warm cache.
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
