// The Claude Code statusline.
//
// Claude Code pipes a JSON payload to `statusLine.command` on every turn and
// renders whatever comes back on stdout. That payload carries this session's
// context-window usage and Claude Code's own view of rate limits — but its
// rate-limit numbers describe *whichever account happened to serve the last
// request*, with no account identity attached. Under the balancer that silently
// flips between accounts, so the number is correct and unattributable, and the
// other accounts are invisible.
//
// This replaces it: context from the payload, per-account quota from the
// balancer's own state files, and the session's actual account from its
// affinity lease. `session_id` in the payload is the same id the proxy keys
// leases on, which is what makes the attribution exact rather than a guess.
//
// Everything is read from local files. No network call, no CLI subprocess: this
// runs on every turn of every session, so the budget is a few milliseconds.

import { AffinityStore } from './affinity.js';
import {
  discoverAccounts,
  isRefreshable,
  readOAuth,
  readSlotObservation,
  resolveAuthswapRoot,
  resolveStateRoot,
} from './accounts.js';
import { claimHasReset } from './claims.js';
import type { Claim } from './claims.js';
import { DEFAULT_EVACUATE_UTILIZATION, DEFAULT_EVACUATION_HORIZON_MS } from './policy.js';

/**
 * The subset of Claude Code's statusline payload this uses.
 *
 * Field names verified against the payload builder in the 2.1.231 binary
 * (`session_id`/`transcript_path`/`cwd` come from `hg()`, the rest from
 * `MGE()`). Everything is optional: a payload that changes shape must degrade
 * to a thinner line, never to a crash — a throwing statusline shows the user a
 * broken HUD on every single turn.
 */
export type StatuslinePayload = {
  session_id?: string;
  cwd?: string;
  agent_type?: string;
  model?: { id?: string; display_name?: string };
  workspace?: { current_dir?: string; project_dir?: string };
  context_window?: {
    context_window_size?: number;
    used_percentage?: number | null;
    current_usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    } | null;
  };
  cost?: { total_cost_usd?: number };
  exceeds_200k_tokens?: boolean;
  output_style?: { name?: string };
};

export type AccountView = {
  slot: string;
  email?: string;
  label: string;
  fiveHour?: number;
  sevenDay?: number;
  fableWeekly?: number;
  fiveHourResetAt?: number;
  sevenDayResetAt?: number;
  /**
   * The server told us this account may exceed its included quota. This is a
   * permission, not the daemon's `--allow-overage` setting — the daemon may
   * still refuse to use it.
   */
  overageAllowed: boolean;
  /** No credential, or an expired token with no live refresh token behind it. */
  needsReauth: boolean;
  /** This is the account serving the session the statusline is rendering for. */
  active: boolean;
  /** Nothing has been observed for this slot yet — utilizations are unknown. */
  stale: boolean;
  /** The observation exists but predates the staleness horizon. */
  aged: boolean;
  /** The router would move sessions off this account. Mirrors `computeHeadroom`. */
  evacuating: boolean;
};

/**
 * Past this, an observation is old enough that the account may have burned
 * quota we cannot see. Two 5h windows: long enough not to flag an idle
 * balancer, short enough to catch one that stopped recording.
 */
export const OBSERVATION_STALE_MS = 10 * 60 * 60 * 1000;

export type StatuslineModel = {
  modelName?: string;
  project?: string;
  agentType?: string;
  contextPercent?: number;
  contextTokens?: number;
  contextWindow?: number;
  costUsd?: number;
  accounts: AccountView[];
  /** True when no balancer state exists at all — it is probably not running. */
  balancerUnknown: boolean;
  /**
   * False when no row is marked active.
   *
   * Distinguishes "this session has not been routed yet" from "the balancer is
   * not in the path at all". Without it, an unmarked line is ambiguous, and the
   * ambiguity resolves the wrong way: the user assumes the balancer is working.
   */
  sessionAttributed: boolean;
};

/**
 * A claim as a percentage.
 *
 * A claim whose reset has already passed describes a window that no longer
 * exists. Rendering its last-seen utilization shows a full bar on an account
 * that refilled hours ago — and, worse, disagrees with the router, which counts
 * that same claim as fully available (`claimHeadroom` returns 1 for it). The
 * statusline must not tell the user an account is exhausted while the balancer
 * is happily routing to it.
 */
function pct(claim: Claim | undefined, nowMs: number): number | undefined {
  if (!claim || claim.utilization === undefined) return undefined;
  if (claimHasReset(claim, nowMs)) return 0;
  return claim.utilization * 100;
}

/** A reset timestamp is only worth rendering while it is still in the future. */
function futureReset(claim: Claim | undefined, nowMs: number): number | undefined {
  if (!claim || claim.reset === undefined) return undefined;
  return claim.reset * 1000 > nowMs ? claim.reset : undefined;
}

/**
 * Evacuation, computed the way `computeHeadroom` computes it.
 *
 * Two divergences would otherwise make the badge a liar in both directions: a
 * claim that refills within the cache horizon does NOT trigger a move (moving
 * costs 20x and saves nothing), and `7d_oi` — the Fable-only weekly — does
 * trigger one, despite not being one of the two bars on the line.
 */
function isEvacuating(claims: Record<string, Claim> | undefined, nowMs: number): boolean {
  if (!claims) return false;
  for (const id of ['5h', '7d', '7d_oi']) {
    const claim = claims[id];
    if (!claim || claim.utilization === undefined) continue;
    if (claimHasReset(claim, nowMs)) continue;
    const resetsSoon =
      claim.reset !== undefined && claim.reset * 1000 - nowMs <= DEFAULT_EVACUATION_HORIZON_MS;
    if (claim.utilization >= DEFAULT_EVACUATE_UTILIZATION && !resetsSoon) return true;
  }
  return false;
}

export const MAX_LABEL = 12;

/**
 * A short, stable account label.
 *
 * The slot number leads because it is what every other surface calls this
 * account — `status`, the routing logs, and authswap all say "slot 2" — so the
 * statusline should not invent a second vocabulary. The domain is dropped: it
 * is the same for nobody here and costs a third of the line, and the local part
 * is what a human actually recognises.
 */
export function shortLabel(
  email: string | undefined,
  slot: string,
  ellipsis = "…",
): string {
  if (!email) return slot;
  const at = email.indexOf('@');
  // The address comes from a credential FILENAME, whose capture group accepts
  // any byte a POSIX filename may hold. A newline there would inject an extra
  // status row and destroy the alignment the whole layout rests on; an ESC
  // would reach the terminal as a live control sequence, because the width and
  // truncation helpers only recognise SGR and would count the rest as text.
  const user = stripControls(at > 0 ? email.slice(0, at) : email);
  // Sliced by code point: `.slice` cuts UTF-16 units, and the local part is
  // arbitrary UTF-8 under RFC 6531, so a cut through an astral character leaves
  // a lone surrogate that every terminal draws as a replacement box.
  const cps = Array.from(user);
  const budget = MAX_LABEL - Array.from(ellipsis).length;
  const trimmed =
    cps.length > MAX_LABEL ? `${cps.slice(0, budget).join('')}${ellipsis}` : cps.join('');
  return `${slot} ${trimmed}`;
}

// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;

function stripControls(text: string): string {
  return text.replace(CONTROLS, '');
}

/**
 * Derive the context-window percentage.
 *
 * Claude Code supplies `used_percentage` directly on recent versions; older
 * ones only carry raw token counts. Summing those is not optional detail —
 * cache reads are ~99% of input, so a sum that omits
 * `cache_read_input_tokens` reports a near-empty context on a full one.
 */
export function contextUsage(payload: StatuslinePayload): {
  percent?: number;
  tokens?: number;
  window?: number;
} {
  const cw = payload.context_window;
  if (!cw) return {};
  const window = cw.context_window_size;
  const usage = cw.current_usage ?? undefined;
  // Sum only the fields actually present. `?? 0` on every field turns a payload
  // whose keys were renamed into a confident `0 tokens` — an empty context bar
  // on a full context — instead of the honest "unknown" that renders as `--`.
  // `output_tokens` is included because the turn's own output occupies context
  // on the next request; omitting it under-reports right when it matters.
  const present = usage
    ? [
        usage.input_tokens,
        usage.output_tokens,
        usage.cache_creation_input_tokens,
        usage.cache_read_input_tokens,
      ].filter((n): n is number => typeof n === 'number')
    : [];
  const tokens = present.length > 0 ? present.reduce((a, b) => a + b, 0) : undefined;

  let percent = typeof cw.used_percentage === 'number' ? cw.used_percentage : undefined;
  if (percent === undefined && tokens !== undefined && window) percent = (tokens / window) * 100;

  return { percent, tokens, window };
}

export type GatherOptions = {
  stateRoot?: string;
  authswapRoot?: string;
  nowMs?: number;
  /**
   * Truncation marker for over-long labels. Passed down because the label is
   * built here but drawn by the renderer: a Unicode ellipsis baked in at this
   * layer arrives as three garbage bytes on a non-UTF-8 terminal, and no glyph
   * choice downstream can undo it.
   */
  ellipsis?: string;
};

/** Assemble everything the renderer needs. Never throws. */
export function gather(payload: StatuslinePayload, options: GatherOptions = {}): StatuslineModel {
  const stateRoot = options.stateRoot ?? resolveStateRoot();
  const nowMs = options.nowMs ?? Date.now();
  const ctx = contextUsage(payload);

  let accounts: AccountView[] = [];
  let balancerUnknown = true;

  try {
    const discovered = discoverAccounts(options.authswapRoot ?? resolveAuthswapRoot());
    let activeSlot: string | undefined;
    if (payload.session_id) {
      try {
        // The model id is passed so the exact lease for THIS session's model is
        // read directly. Without it the fallback picks the most recently used
        // lease, which on a session with background traffic can be a haiku call
        // sitting on a different account than the turn being rendered.
        activeSlot = new AffinityStore({ stateRoot, now: () => nowMs }).peekSession(
          payload.session_id,
          payload.model?.id,
        )?.slot;
      } catch {
        /* an unreadable lease directory must not cost us the whole line */
      }
    }

    accounts = discovered.map(account => {
      const observed = readSlotObservation(stateRoot, account.slot);
      const byId = observed?.claims?.byId;
      if (observed) balancerUnknown = false;
      const oauth = readOAuth(account.credentialPath);
      const expired = oauth?.expiresAt !== undefined && oauth.expiresAt <= nowMs;
      return {
        slot: account.slot,
        email: account.email,
        label: shortLabel(account.email, account.slot, options.ellipsis),
        fiveHour: pct(byId?.['5h'], nowMs),
        sevenDay: pct(byId?.['7d'], nowMs),
        fableWeekly: pct(byId?.['7d_oi'], nowMs),
        fiveHourResetAt: futureReset(byId?.['5h'], nowMs),
        sevenDayResetAt: futureReset(byId?.['7d'], nowMs),
        overageAllowed: byId?.['overage']?.status === 'allowed',
        // Same test `loadAccountStates` uses for health: dead is no credential
        // at all, or an expired one with no live refresh token behind it. An
        // expired token that CAN refresh is not a problem the user must act on.
        needsReauth: !oauth || (expired && !isRefreshable(oauth, nowMs)),
        active: account.slot === activeSlot,
        stale: !observed,
        aged:
          observed !== undefined &&
          observed.observedAt !== undefined &&
          nowMs - observed.observedAt > OBSERVATION_STALE_MS,
        evacuating: isEvacuating(byId, nowMs),
      };
    });
  } catch {
    accounts = [];
  }

  return {
    modelName: payload.model?.display_name ?? payload.model?.id,
    project: projectName(payload),
    agentType: payload.agent_type,
    contextPercent: ctx.percent,
    contextTokens: ctx.tokens,
    contextWindow: ctx.window,
    costUsd: payload.cost?.total_cost_usd,
    accounts,
    balancerUnknown,
    sessionAttributed: accounts.some(a => a.active),
  };
}

function projectName(payload: StatuslinePayload): string | undefined {
  const dir = payload.workspace?.project_dir ?? payload.workspace?.current_dir ?? payload.cwd;
  if (!dir) return undefined;
  const parts = dir.split('/').filter(Boolean);
  return parts[parts.length - 1];
}

/** Parse the payload defensively; a malformed one still renders a usable line. */
export function parsePayload(raw: string): StatuslinePayload {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as StatuslinePayload;
  } catch {
    /* fall through */
  }
  return {};
}
