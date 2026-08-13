// Parsing of Anthropic's `anthropic-ratelimit-unified-*` response headers.
//
// Pure: no fs, no network. Everything here is driven by header maps captured
// from real responses, so it is unit-testable without credentials.
//
// Observed header shape (Max 20x subscription, 2026-08-13):
//
//   anthropic-ratelimit-unified-status: allowed_warning
//   anthropic-ratelimit-unified-5h-status: allowed
//   anthropic-ratelimit-unified-5h-reset: 1786665000
//   anthropic-ratelimit-unified-5h-utilization: 0.46
//   anthropic-ratelimit-unified-7d-status: allowed_warning
//   anthropic-ratelimit-unified-7d-utilization: 0.91
//   anthropic-ratelimit-unified-7d-surpassed-threshold: 0.75
//   anthropic-ratelimit-unified-7d_oi-status: allowed        <- Fable only
//   anthropic-ratelimit-unified-7d_oi-utilization: 0.22
//   anthropic-ratelimit-unified-overage-status: allowed | rejected
//   anthropic-ratelimit-unified-overage-disabled-reason: org_level_disabled
//   anthropic-ratelimit-unified-representative-claim: seven_day | five_hour
//   anthropic-ratelimit-unified-fallback-percentage: 0.5
//   anthropic-ratelimit-unified-upgrade-paths: overage

export const HEADER_PREFIX = 'anthropic-ratelimit-unified-';

/** Claim ids as they appear in the header namespace. */
export type ClaimId = '5h' | '7d' | '7d_oi' | 'overage' | (string & {});

export type ClaimStatus = 'allowed' | 'allowed_warning' | 'rejected' | (string & {});

export type Claim = {
  id: ClaimId;
  status?: ClaimStatus;
  /** Fraction of this claim's own budget consumed, 0..1 (can exceed 1 under overage). */
  utilization?: number;
  /** Unix epoch SECONDS at which this window resets. */
  reset?: number;
  /** Warning threshold the server applied, 0..1. */
  surpassedThreshold?: number;
  /** Present on `overage` when the org has it turned off. */
  disabledReason?: string;
};

export type Claims = {
  /** Top-level rollup status across all claims. */
  status?: ClaimStatus;
  /** Top-level reset, mirrors the representative claim's reset. Epoch seconds. */
  reset?: number;
  /**
   * Which claim is actually binding right now, normalized to a ClaimId.
   * The server sends `seven_day` / `five_hour`; we map to `7d` / `5h`.
   */
  representativeClaim?: ClaimId;
  /** Plan constant, 0..1. Observed 0.5 on both Max 20x accounts, on every model. */
  fallbackPercentage?: number;
  /** e.g. ['overage'] */
  upgradePaths?: string[];
  byId: Record<string, Claim>;
};

/** Longest-first so `surpassed-threshold` is not shadowed by `-threshold`-less matches. */
const FIELD_SUFFIXES = [
  'surpassed-threshold',
  'disabled-reason',
  'utilization',
  'status',
  'reset',
] as const;

const TOP_LEVEL = new Set([
  'status',
  'reset',
  'representative-claim',
  'fallback-percentage',
  'upgrade-paths',
]);

const REPRESENTATIVE_ALIASES: Record<string, ClaimId> = {
  five_hour: '5h',
  seven_day: '7d',
  seven_day_oi: '7d_oi',
};

function num(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Normalize a claim name coming from the `representative-claim` header into the
 * same id space the per-claim headers use. Unknown values pass through so a new
 * server-side claim does not silently become `undefined`.
 */
export function normalizeClaimId(raw: string): ClaimId {
  const key = raw.trim();
  return REPRESENTATIVE_ALIASES[key] ?? key;
}

/**
 * Parse a response header map into a Claims structure.
 *
 * Accepts any case for header names and tolerates unknown claims and fields —
 * the server has already added one claim (`7d_oi`) that did not exist in the
 * original unified set, and will add more.
 */
export function parseClaims(headers: Record<string, string | string[] | undefined>): Claims {
  const flat = new Map<string, string>();
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined) continue;
    const key = rawKey.toLowerCase();
    if (!key.startsWith(HEADER_PREFIX)) continue;
    flat.set(key.slice(HEADER_PREFIX.length), Array.isArray(rawValue) ? rawValue.join(',') : rawValue);
  }

  const claims: Claims = { byId: {} };
  if (flat.size === 0) return claims;

  const claimFor = (id: string): Claim => (claims.byId[id] ??= { id });

  for (const [suffix, value] of flat) {
    if (TOP_LEVEL.has(suffix)) {
      switch (suffix) {
        case 'status':
          claims.status = value;
          break;
        case 'reset':
          claims.reset = num(value);
          break;
        case 'representative-claim':
          claims.representativeClaim = normalizeClaimId(value);
          break;
        case 'fallback-percentage':
          claims.fallbackPercentage = num(value);
          break;
        case 'upgrade-paths':
          claims.upgradePaths = value.split(',').map(s => s.trim()).filter(Boolean);
          break;
      }
      continue;
    }

    const field = FIELD_SUFFIXES.find(f => suffix.endsWith(`-${f}`));
    if (!field) continue;
    const id = suffix.slice(0, suffix.length - field.length - 1);
    if (!id) continue;
    const claim = claimFor(id);
    switch (field) {
      case 'status':
        claim.status = value;
        break;
      case 'utilization':
        claim.utilization = num(value);
        break;
      case 'reset':
        claim.reset = num(value);
        break;
      case 'surpassed-threshold':
        claim.surpassedThreshold = num(value);
        break;
      case 'disabled-reason':
        claim.disabledReason = value;
        break;
    }
  }

  return claims;
}

/** True when the response carried any unified rate-limit header at all. */
export function hasClaims(claims: Claims): boolean {
  return (
    claims.status !== undefined ||
    claims.representativeClaim !== undefined ||
    Object.keys(claims.byId).length > 0
  );
}

/**
 * A claim whose window has already reset is stale, not full. Callers treat a
 * reset claim as 0% utilized rather than trusting the last observed number.
 */
export function claimHasReset(claim: Claim, nowMs: number): boolean {
  return claim.reset !== undefined && claim.reset * 1000 <= nowMs;
}
