// Verbatim response headers captured from api.anthropic.com on 2026-08-13 via a
// pass-through proxy, using Claude Code 2.1.231 with Max 20x OAuth tokens.
// Kept out of any *.test.ts file so importing them does not re-run a suite.

/** Account with an almost-spent weekly and overage turned on. */
export const JOSEPH_HAIKU = {
  'anthropic-ratelimit-unified-status': 'allowed_warning',
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-5h-reset': '1786665000',
  'anthropic-ratelimit-unified-5h-utilization': '0.46',
  'anthropic-ratelimit-unified-7d-status': 'allowed_warning',
  'anthropic-ratelimit-unified-7d-reset': '1786770000',
  'anthropic-ratelimit-unified-7d-utilization': '0.91',
  'anthropic-ratelimit-unified-7d-surpassed-threshold': '0.75',
  'anthropic-ratelimit-unified-overage-status': 'allowed',
  'anthropic-ratelimit-unified-overage-reset': '1788220800',
  'anthropic-ratelimit-unified-overage-utilization': '0.0',
  'anthropic-ratelimit-unified-representative-claim': 'seven_day',
  'anthropic-ratelimit-unified-fallback-percentage': '0.5',
  'anthropic-ratelimit-unified-reset': '1786770000',
  'anthropic-ratelimit-unified-upgrade-paths': 'overage',
};

/** Same account on Fable: the extra `7d_oi` claim appears. */
export const JOSEPH_FABLE = {
  ...JOSEPH_HAIKU,
  'anthropic-ratelimit-unified-7d_oi-status': 'allowed',
  'anthropic-ratelimit-unified-7d_oi-reset': '1786770000',
  'anthropic-ratelimit-unified-7d_oi-utilization': '0.22',
};

/** Fresh account, overage disabled at the org level. */
export const NAD_FABLE = {
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-5h-reset': '1786678800',
  'anthropic-ratelimit-unified-5h-utilization': '0.01',
  'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-7d-reset': '1786964400',
  'anthropic-ratelimit-unified-7d-utilization': '0.0',
  'anthropic-ratelimit-unified-7d_oi-status': 'allowed',
  'anthropic-ratelimit-unified-7d_oi-reset': '1786964400',
  'anthropic-ratelimit-unified-7d_oi-utilization': '0.0',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-fallback-percentage': '0.5',
  'anthropic-ratelimit-unified-reset': '1786678800',
  'anthropic-ratelimit-unified-overage-disabled-reason': 'org_level_disabled',
  'anthropic-ratelimit-unified-overage-status': 'rejected',
};
