// Pure rotation/back-off policy for the balanced Codex provider.
//
// Kept free of pi-ai / network / filesystem imports so it can be unit-tested in
// isolation. The stateful streaming wiring in index.ts injects real I/O via the
// RotationDeps interface.

export type SlotInfo = { slot: string; primaryRemaining?: number };

export type AttemptOutcome =
  | 'done'           // upstream succeeded; terminal event already forwarded to the user
  | 'rate-limited'   // 429 / usage limit BEFORE any content streamed; eligible to rotate
  | 'lease-failed'   // token lease could not be acquired; rotate to another slot but do NOT cooldown
  | 'other-error'    // non-rate error before content; surface as-is
  | 'streamed-error' // error after content already streamed; must not rotate (would duplicate)
  | 'aborted';       // caller aborted

export type Attempt = { outcome: AttemptOutcome; slot: string };

export type RotationConfig = {
  cooldownMs: number;    // how long a 429'd slot is deprioritized
  maxRounds: number;     // full passes over the account set before giving up
  backoffBaseMs: number; // base delay between rounds
  backoffCapMs: number;  // max delay between rounds
};

export const DEFAULT_ROTATION_CONFIG: RotationConfig = {
  cooldownMs: 60_000,
  maxRounds: 2,
  backoffBaseMs: 1_000,
  backoffCapMs: 8_000,
};

const RATE_LIMIT_TEXT = /rate.?limit|usage limit|too many requests|\b429\b|"detail"\s*:\s*"rate limit/i;

/** True when an outcome looks like a rate limit we should rotate accounts on. */
export function classifyRateLimit(input: { status?: number; errorText?: string }): boolean {
  if (input.status === 429) return true;
  return input.errorText ? RATE_LIMIT_TEXT.test(input.errorText) : false;
}

/**
 * Pick the best slot to try next: untried, preferring slots not in active
 * cooldown, then by most primary quota remaining, with a stable slot-id tie-break.
 * Falls back to a cooled slot only when every untried candidate is cooled.
 */
export function chooseNextSlot(
  accounts: SlotInfo[],
  triedSlots: Set<string>,
  cooldown: Map<string, number>,
  now: number,
): string | undefined {
  const available = accounts.filter(a => !triedSlots.has(a.slot));
  if (available.length === 0) return undefined;
  const notCooled = available.filter(a => (cooldown.get(a.slot) ?? 0) <= now);
  const pool = notCooled.length > 0 ? notCooled : available;
  const sorted = [...pool].sort((a, b) => {
    const ar = a.primaryRemaining ?? -1;
    const br = b.primaryRemaining ?? -1;
    if (br !== ar) return br - ar;
    return a.slot.localeCompare(b.slot);
  });
  return sorted[0]?.slot;
}

/** Exponential back-off (capped) with +/-25% jitter. `rand` in [0,1) is injected for determinism. */
export function backoffDelayMs(round: number, config: RotationConfig, rand: number): number {
  const base = Math.min(config.backoffCapMs, config.backoffBaseMs * 2 ** round);
  const jitter = base * 0.25 * (rand * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

export type RotationDeps = {
  /** Run one upstream attempt. `undefined` = library auto-selection; a slot string forces that slot. */
  runAttempt: (forcedSlot: string | undefined) => Promise<Attempt>;
  listSlots: () => Promise<SlotInfo[]>;
  cooldown: Map<string, number>;
  config: RotationConfig;
  sleep: (ms: number) => Promise<void>;
  rand: () => number;
  now: () => number;
  signalAborted: () => boolean;
  /** Called once when every account rate-limited across all rounds; forwards a terminal error. */
  onExhausted: () => void;
};

/**
 * Drive attempts across accounts. The first attempt of the first round uses
 * library auto-selection (preserving normal balancing). On a rate-limit, rotate
 * to another account; if a whole pass rate-limits, back off and try once more,
 * up to `config.maxRounds`, then call `onExhausted`.
 *
 * Always runs at least one attempt so the caller's stream gets a terminal event.
 */
export async function runWithRotation(deps: RotationDeps): Promise<void> {
  for (let round = 0; round < deps.config.maxRounds; round += 1) {
    if (round > 0) {
      // Additional rounds only make sense with >= 2 accounts to alternate between.
      // A single-account install should surface the original error, not hammer the
      // same account again after a back-off.
      if ((await deps.listSlots()).length < 2) break;
      if (deps.signalAborted()) return;
      await deps.sleep(backoffDelayMs(round - 1, deps.config, deps.rand()));
      if (deps.signalAborted()) return;
    }
    const triedThisRound = new Set<string>();
    let forced: string | undefined =
      round === 0 ? undefined : chooseNextSlot(await deps.listSlots(), triedThisRound, deps.cooldown, deps.now());

    while (true) {
      const attempt = await deps.runAttempt(forced);
      triedThisRound.add(attempt.slot);

      // Rotate on rate-limit (429) or lease-failed (could not acquire a token).
      // Anything else (done / other-error / streamed-error / aborted) is terminal.
      if (attempt.outcome !== 'rate-limited' && attempt.outcome !== 'lease-failed') return;

      // Only a genuine rate-limit cools the slot down; a lease failure does not
      // mean the account is over quota, so leave it eligible for later turns.
      if (attempt.outcome === 'rate-limited') deps.cooldown.set(attempt.slot, deps.now() + deps.config.cooldownMs);
      const next = chooseNextSlot(await deps.listSlots(), triedThisRound, deps.cooldown, deps.now());
      if (next === undefined) break; // every slot tried this round
      if (deps.signalAborted()) return;
      forced = next;
    }
  }
  deps.onExhausted();
}
