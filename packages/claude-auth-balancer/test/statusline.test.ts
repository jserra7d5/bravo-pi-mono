import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { AffinityStore } from '../src/affinity.js';
import { contextUsage, gather, parsePayload, shortLabel } from '../src/statusline.js';
import type { StatuslinePayload } from '../src/statusline.js';
import {
  ASCII_GLYPHS,
  bar,
  barWidth,
  contextColor,
  formatPercent,
  formatReset,
  formatTokens,
  quotaColor,
  render,
  visibleWidth,
} from '../src/statusline-render.js';

const roots: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cab-sl-'));
  roots.push(dir);
  return dir;
}
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const NOW = Date.UTC(2026, 7, 14, 0, 0, 0);

// Control characters and astral code points are built here rather than typed
// inline: a literal ESC or lone surrogate in source is invisible in a diff and
// survives a copy-paste as something else entirely.
const ESC = String.fromCharCode(27);
const EMOJI = String.fromCodePoint(0x1f600);
const ELLIPSIS = '\u2026';
const CONTROLS_RE = /[\u0000-\u001f\u007f-\u009f]/;
const LONE_HIGH = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
const LONE_LOW = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const NON_ASCII = /[^\x00-\x7f]/;

/** Build an authswap credential dir + a balancer state root. */
type WorldAccount = {
  slot: string;
  email: string;
  u5h?: number;
  u7d?: number;
  u7dOi?: number;
  overage?: string;
  /** Seconds from NOW until each window refills. Negative = already reset. */
  reset5h?: number;
  reset7d?: number;
  /** Milliseconds from NOW until the access token expires. */
  tokenExpiresIn?: number;
  /** Omit the refresh token entirely, so an expired access token is terminal. */
  noRefreshToken?: boolean;
  /** Milliseconds before NOW that the observation was recorded. */
  observedAgoMs?: number;
};

function world(accounts: WorldAccount[]): { stateRoot: string; authswapRoot: string } {
  const authswapRoot = tmp();
  const stateRoot = tmp();
  const credDir = path.join(authswapRoot, 'providers', 'anthropic', 'credentials');
  mkdirSync(credDir, { recursive: true });
  const slotDir = path.join(stateRoot, 'state', 'accounts');
  mkdirSync(slotDir, { recursive: true });

  for (const a of accounts) {
    const oauth: Record<string, unknown> = {
      accessToken: 'x',
      expiresAt: NOW + (a.tokenExpiresIn ?? 8 * 3600_000),
    };
    if (!a.noRefreshToken) oauth['refreshToken'] = 'r';
    writeFileSync(
      path.join(credDir, `.credentials-${a.slot}-${a.email}.json`),
      JSON.stringify({ claudeAiOauth: oauth }),
    );
    const byId: Record<string, unknown> = {};
    if (a.u5h !== undefined) {
      byId['5h'] = {
        id: '5h',
        status: 'allowed',
        utilization: a.u5h,
        reset: NOW / 1000 + (a.reset5h ?? 3600),
      };
    }
    if (a.u7d !== undefined) {
      byId['7d'] = {
        id: '7d',
        status: 'allowed',
        utilization: a.u7d,
        reset: NOW / 1000 + (a.reset7d ?? 86400),
      };
    }
    if (a.u7dOi !== undefined) {
      byId['7d_oi'] = { id: '7d_oi', status: 'allowed', utilization: a.u7dOi, reset: NOW / 1000 + 86400 };
    }
    if (a.overage) byId['overage'] = { id: 'overage', status: a.overage };
    writeFileSync(
      path.join(slotDir, `${a.slot}.json`),
      JSON.stringify({
        slot: a.slot,
        email: a.email,
        claims: { byId },
        observedAt: NOW - (a.observedAgoMs ?? 0),
      }),
    );
  }
  return { stateRoot, authswapRoot };
}

// ---------------------------------------------------------------------------
// Formatting primitives
// ---------------------------------------------------------------------------

test('a non-zero percentage never renders as an empty bar', () => {
  // 0.4% of a 10-wide bar rounds to zero cells. Showing nothing for real usage
  // is the one rounding error a glanceable bar must not make.
  const b = bar(0.4, 10, quotaColor, false);
  assert.equal(b.replace(/░/g, '').length, 1);
});

test('a bar is only full at exactly 100%', () => {
  assert.equal(bar(99.6, 10, quotaColor, false), '█'.repeat(9) + '░');
  assert.equal(bar(100, 10, quotaColor, false), '█'.repeat(10));
});

test('0% is an empty bar, and an unknown value is a dim bar of the same width', () => {
  assert.equal(bar(0, 8, quotaColor, false), '░'.repeat(8));
  assert.equal(visibleWidth(bar(undefined, 8, quotaColor, true)), 8, 'columns stay aligned');
});

test('bars are the same visible width whatever the value, so columns never jitter', () => {
  const widths = [0, 1, 37.4, 74.9, 99.9, 100, undefined].map(p =>
    visibleWidth(bar(p as number | undefined, 10, quotaColor, true)),
  );
  assert.deepEqual(widths, [10, 10, 10, 10, 10, 10, 10]);
});

test('every coloured bar terminates its escapes', () => {
  for (const p of [0, 5, 50, 96, 100]) {
    const b = bar(p, 10, quotaColor, true);
    const opens = (b.match(/\[[0-9;]*m/g) ?? []).filter(s => s !== '[0m').length;
    const resets = (b.match(/\[0m/g) ?? []).length;
    assert.equal(opens, resets, `p=${p} leaves colour bleeding into the next field`);
  }
});

test('colour ramps warn before the balancer acts, not after', () => {
  // Evacuation is at 95%, so red has to start below it or the bar turns red at
  // the same instant routing changes and warns nobody.
  assert.notEqual(quotaColor(89), quotaColor(91));
  assert.equal(quotaColor(96), quotaColor(100));
  assert.notEqual(contextColor(50), contextColor(95));
});

test('percentages are fixed width so the columns after them line up', () => {
  const rendered = [undefined, 0, 7, 42.5, 100].map(formatPercent);
  assert.deepEqual(new Set(rendered.map(s => s.length)), new Set([4]));
  assert.equal(formatPercent(42.5), ' 43%');
  assert.equal(formatPercent(undefined), '  --');
});

test('token counts are abbreviated, not printed raw', () => {
  assert.equal(formatTokens(940), '940');
  assert.equal(formatTokens(426_000), '426k');
  assert.equal(formatTokens(1_000_000), '1.0M');
  assert.equal(formatTokens(undefined), '');
});

test('a reset in the past renders as nothing rather than a negative duration', () => {
  assert.equal(formatReset(NOW / 1000 - 500, NOW), '');
  assert.equal(formatReset(undefined, NOW), '');
  assert.equal(formatReset(NOW / 1000 + 1800, NOW), '30m');
  assert.equal(formatReset(NOW / 1000 + 3 * 3600 + 1200, NOW), '3h20m');
  assert.equal(formatReset(NOW / 1000 + 28 * 3600, NOW), '1d4h');
});

test('bars shrink with the terminal instead of wrapping the line', () => {
  assert.ok(barWidth(50) < barWidth(100));
  assert.ok(barWidth(100) < barWidth(200));
});

// ---------------------------------------------------------------------------
// Payload handling
// ---------------------------------------------------------------------------

test('context usage counts cache reads, which are ~99% of input', () => {
  // Omitting cache_read_input_tokens reports a nearly empty context window on a
  // nearly full one — the single most misleading number this line could show.
  const usage = contextUsage({
    context_window: {
      context_window_size: 1_000_000,
      current_usage: { input_tokens: 1_000, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 2_000 },
    },
  });
  assert.equal(usage.tokens, 403_000);
  assert.ok(Math.abs((usage.percent ?? 0) - 40.3) < 0.01);
});

test('a native used_percentage wins over the derived one', () => {
  const usage = contextUsage({
    context_window: { context_window_size: 1_000_000, used_percentage: 61, current_usage: { input_tokens: 5 } },
  });
  assert.equal(usage.percent, 61);
});

test('a malformed or empty payload still renders instead of crashing', () => {
  assert.deepEqual(parsePayload('not json'), {});
  assert.deepEqual(parsePayload(''), {});
  assert.deepEqual(parsePayload('null'), {});
  assert.deepEqual(parsePayload('[1,2]'), [1, 2] as unknown as StatuslinePayload);
  assert.doesNotThrow(() => render(gather(parsePayload('garbage'), { stateRoot: tmp(), authswapRoot: tmp() })));
});

test('account labels lead with the slot and drop the domain', () => {
  assert.equal(shortLabel('info@notanotherdashboard.com', '1'), '1 info');
  assert.equal(shortLabel('joseph.b.serra@gmail.com', '2'), '2 joseph.b.se…');
  assert.equal(shortLabel(undefined, '3'), '3');
});

// ---------------------------------------------------------------------------
// The thing this exists for
// ---------------------------------------------------------------------------

test('every balanced account appears, not just the one that served last', () => {
  const { stateRoot, authswapRoot } = world([
    { slot: '1', email: 'info@nad.com', u5h: 0.34, u7d: 0.07 },
    { slot: '2', email: 'joseph@gmail.com', u5h: 0, u7d: 0.96, overage: 'allowed' },
  ]);
  const model = gather({}, { stateRoot, authswapRoot, nowMs: NOW });
  assert.equal(model.accounts.length, 2);
  assert.deepEqual(model.accounts.map(a => a.slot), ['1', '2']);
  assert.equal(model.accounts[0]!.fiveHour, 34);
  assert.equal(model.accounts[1]!.sevenDay, 96);

  const plain = render(model, { width: 120, color: false }, NOW);
  assert.match(plain, /1 info/);
  assert.match(plain, /2 joseph/);
  assert.doesNotMatch(plain, /EVACUATING/, 'evacuation does not add a large text label');

  const coloured = render(model, { width: 120, color: true }, NOW);
  const hot = coloured.split('\n').find(line => line.includes('2 joseph'))!;
  assert.ok(
    hot.startsWith(`${ESC}[31m·${ESC}[0m`),
    `an evacuating account uses a red left marker: ${JSON.stringify(hot)}`,
  );
});

test('an active evacuating account keeps its active glyph but turns it red', () => {
  const { stateRoot, authswapRoot } = world([
    { slot: '1', email: 'hot@nad.com', u5h: 0.1, u7d: 0.96 },
  ]);
  new AffinityStore({ stateRoot, now: () => NOW }).touch('sess-hot', '1', 'claude-opus-5');
  const model = gather({ session_id: 'sess-hot' }, { stateRoot, authswapRoot, nowMs: NOW });
  const line = render(model, { width: 120, color: true }, NOW).split('\n')[0]!;

  assert.ok(
    line.startsWith(`${ESC}[1m${ESC}[31m▸${ESC}[0m`),
    `active evacuation uses a bold red active marker: ${JSON.stringify(line)}`,
  );
  assert.ok(!line.includes('EVACUATING'));
});

test('the session is attributed to the account holding its lease', () => {
  const { stateRoot, authswapRoot } = world([
    { slot: '1', email: 'info@nad.com', u5h: 0.34, u7d: 0.07 },
    { slot: '2', email: 'joseph@gmail.com', u5h: 0.02, u7d: 0.5 },
  ]);
  new AffinityStore({ stateRoot, now: () => NOW }).touch('sess-abc', '2', 'claude-opus-5');

  const model = gather({ session_id: 'sess-abc' }, { stateRoot, authswapRoot, nowMs: NOW });
  assert.equal(model.accounts.find(a => a.slot === '2')!.active, true);
  assert.equal(model.accounts.find(a => a.slot === '1')!.active, false);

  const out = render(model, { width: 120, color: false }, NOW);
  const lines = out.split('\n');
  const active = lines.find(l => l.includes('2 joseph'))!;
  const inactive = lines.find(l => l.includes('1 info'))!;
  assert.ok(active.startsWith('▸'), `active row is marked with a glyph, not only colour: ${active}`);
  // The Claude Code TUI trims leading whitespace, so a blank inactive marker
  // would be eaten and shift every inactive row one column left.
  assert.ok(!inactive.startsWith(' '), `inactive marker must not be whitespace: ${inactive}`);
  assert.equal(
    visibleWidth(active.slice(0, active.indexOf('2 joseph'))),
    visibleWidth(inactive.slice(0, inactive.indexOf('1 info'))),
    'account labels start in the same column whether active or not',
  );
});

test('attribution works even though the lease key includes a model the statusline cannot know', () => {
  // The proxy keys leases on (session, model-from-request-body). A statusline
  // is handed `session_id` and a display model name, which need not be the same
  // string — so lookup has to work from the session alone.
  const { stateRoot, authswapRoot } = world([{ slot: '7', email: 'a@b.com', u5h: 0.1, u7d: 0.1 }]);
  new AffinityStore({ stateRoot, now: () => NOW }).touch('sess-xyz', '7', 'some-internal-model-id');

  const model = gather(
    { session_id: 'sess-xyz', model: { id: 'claude-opus-5' } },
    { stateRoot, authswapRoot, nowMs: NOW },
  );
  assert.equal(model.accounts[0]!.active, true);
});

test('an expired lease attributes the session to nobody rather than to a stale account', () => {
  const { stateRoot, authswapRoot } = world([{ slot: '1', email: 'a@b.com', u5h: 0.1, u7d: 0.1 }]);
  new AffinityStore({ stateRoot, now: () => NOW - 2 * 3600_000 }).touch('sess', '1', 'm');
  const model = gather({ session_id: 'sess' }, { stateRoot, authswapRoot, nowMs: NOW });
  assert.equal(model.accounts[0]!.active, false);
});

test('a session with leases on two accounts shows the most recently used one', () => {
  const { stateRoot, authswapRoot } = world([
    { slot: '1', email: 'a@b.com', u5h: 0.1, u7d: 0.1 },
    { slot: '2', email: 'c@d.com', u5h: 0.1, u7d: 0.1 },
  ]);
  const older = new AffinityStore({ stateRoot, now: () => NOW - 60_000 });
  older.touch('sess', '1', 'model-a');
  const newer = new AffinityStore({ stateRoot, now: () => NOW });
  newer.touch('sess', '2', 'model-b');

  const model = gather({ session_id: 'sess' }, { stateRoot, authswapRoot, nowMs: NOW });
  assert.equal(model.accounts.find(a => a.slot === '2')!.active, true);
  assert.equal(model.accounts.find(a => a.slot === '1')!.active, false);
});

test('rendering never writes to the lease directory', () => {
  // A statusline runs on every turn of every session. If it swept, it would be
  // mutating the routing state it is supposed to be reporting.
  const { stateRoot, authswapRoot } = world([{ slot: '1', email: 'a@b.com', u5h: 0.1, u7d: 0.1 }]);
  const store = new AffinityStore({ stateRoot, now: () => NOW - 5 * 3600_000 });
  store.touch('old-session', '1', 'm'); // already expired at NOW
  const dir = path.join(stateRoot, 'leases', 'affinity');
  const before = readdirSync(dir);

  gather({ session_id: 'old-session' }, { stateRoot, authswapRoot, nowMs: NOW });
  assert.deepEqual(readdirSync(dir), before, 'the expired lease was swept by a render');
});

test('an account with no observation is shown as unknown, not as zero usage', () => {
  const authswapRoot = tmp();
  const stateRoot = tmp();
  const credDir = path.join(authswapRoot, 'providers', 'anthropic', 'credentials');
  mkdirSync(credDir, { recursive: true });
  writeFileSync(path.join(credDir, '.credentials-1-a@b.com.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x' } }));

  const model = gather({}, { stateRoot, authswapRoot, nowMs: NOW });
  assert.equal(model.accounts[0]!.fiveHour, undefined, 'unknown must not read as 0%');
  assert.equal(model.accounts[0]!.stale, true);
  assert.match(render(model, { width: 120, color: false }, NOW), /--/);
});

test('a missing balancer degrades to a line instead of an exception', () => {
  const model = gather({ session_id: 's' }, { stateRoot: '/nonexistent/state', authswapRoot: '/nonexistent/auth' });
  assert.deepEqual(model.accounts, []);
  const out = render(model, { width: 80, color: false }, NOW);
  assert.match(out, /balancer/);
});

test('refresh warnings use the existing width-bounded status note', () => {
  const model = {
    modelName: 'Claude', accounts: [], balancerUnknown: false, sessionAttributed: false,
    warnings: ['refresh slot 123 backing off with an intentionally very long safe diagnostic'],
  };
  for (const width of [20, 40, 80]) {
    for (const line of render(model, { width, color: false }, NOW).split('\n')) {
      assert.ok(visibleWidth(line) <= width, `warning overflowed ${width} columns: ${line}`);
    }
  }
});

test('the rendered line fits the terminal it was told about', () => {
  const { stateRoot, authswapRoot } = world([
    { slot: '1', email: 'info@nad.com', u5h: 0.34, u7d: 0.07 },
    { slot: '2', email: 'joseph.b.serra@gmail.com', u5h: 0.02, u7d: 0.96 },
  ]);
  const model = gather(
    { context_window: { context_window_size: 1_000_000, used_percentage: 42 }, cost: { total_cost_usd: 3.47 } },
    { stateRoot, authswapRoot, nowMs: NOW },
  );
  for (const width of [60, 80, 100, 140, 200]) {
    for (const line of render(model, { width, color: true }, NOW).split('\n')) {
      assert.ok(
        visibleWidth(line) <= width,
        `width=${width}: line is ${visibleWidth(line)} cols: ${line.replace(/\[[0-9;]*m/g, '')}`,
      );
    }
  }
});

test('account rows keep slot order so the eye learns where to look', () => {
  const { stateRoot, authswapRoot } = world([
    { slot: '1', email: 'a@b.com', u5h: 0.99, u7d: 0.99 },
    { slot: '2', email: 'c@d.com', u5h: 0.01, u7d: 0.01 },
  ]);
  const rows = render(gather({}, { stateRoot, authswapRoot, nowMs: NOW }), { width: 120, color: false }, NOW)
    .split('\n')
    .filter(l => /\d [a-z]/.test(l));
  assert.ok(rows[0]!.includes('1 a'), 'the busiest account must not jump to the top');
  assert.ok(rows[1]!.includes('2 c'));
});

test('colour can be turned off entirely, for a terminal that cannot render it', () => {
  const { stateRoot, authswapRoot } = world([{ slot: '1', email: 'a@b.com', u5h: 0.5, u7d: 0.5 }]);
  const out = render(gather({}, { stateRoot, authswapRoot, nowMs: NOW }), { width: 100, color: false }, NOW);
  assert.ok(!out.includes('['), 'no escapes survive --no-color');
});

// ---------------------------------------------------------------------------
// Truth of the numbers
// ---------------------------------------------------------------------------

test('a window whose reset has passed reads as refilled, not as still exhausted', () => {
  // The router already counts this claim as fully available. A statusline that
  // shows 96% while the balancer happily routes to the account is worse than no
  // statusline: it argues with the thing it is reporting on.
  const { stateRoot, authswapRoot } = world([
    { slot: '1', email: 'a@b.com', u5h: 0.96, u7d: 0.4, reset5h: -60 },
  ]);
  const model = gather({}, { stateRoot, authswapRoot, nowMs: NOW });
  assert.equal(model.accounts[0]!.fiveHour, 0);
  assert.equal(model.accounts[0]!.sevenDay, 40);
});

test('a reset already in the past is not offered as a countdown', () => {
  const { stateRoot, authswapRoot } = world([
    { slot: '1', email: 'a@b.com', u5h: 0.1, u7d: 0.9, reset7d: -10 },
  ]);
  const model = gather({}, { stateRoot, authswapRoot, nowMs: NOW });
  assert.equal(model.accounts[0]!.sevenDayResetAt, undefined);
});

test('the evacuation marker follows the router and spares a window refilling within the cache horizon', () => {
  // computeHeadroom will not pay a 20x cache re-create to dodge a bucket that
  // refills in ten minutes. The badge must not claim otherwise.
  const soon = world([{ slot: '1', email: 'a@b.com', u5h: 0.97, u7d: 0.2, reset5h: 600 }]);
  const later = world([{ slot: '1', email: 'a@b.com', u5h: 0.97, u7d: 0.2, reset5h: 6 * 3600 }]);
  assert.equal(
    gather({}, { ...soon, nowMs: NOW }).accounts[0]!.evacuating,
    false,
    'a window that refills inside the cache horizon must not trigger a move',
  );
  assert.equal(gather({}, { ...later, nowMs: NOW }).accounts[0]!.evacuating, true);
});

test('the evacuation marker fires on the Fable-only weekly, which has no bar of its own', () => {
  // 7d_oi drives routing but is not one of the two bars, so without this the
  // user watches two calm bars while every session is being moved off.
  const { stateRoot, authswapRoot } = world([
    { slot: '1', email: 'a@b.com', u5h: 0.1, u7d: 0.1, u7dOi: 0.99 },
  ]);
  assert.equal(gather({}, { stateRoot, authswapRoot, nowMs: NOW }).accounts[0]!.evacuating, true);
});

test('an account with no live refresh token behind an expired one is flagged for re-auth', () => {
  const { stateRoot, authswapRoot } = world([
    { slot: '1', email: 'ok@b.com', u5h: 0.1, u7d: 0.1 },
    { slot: '2', email: 'dead@b.com', u5h: 0.1, u7d: 0.1, tokenExpiresIn: -1000, noRefreshToken: true },
    { slot: '3', email: 'refreshable@b.com', u5h: 0.1, u7d: 0.1, tokenExpiresIn: -1000 },
  ]);
  const model = gather({}, { stateRoot, authswapRoot, nowMs: NOW });
  assert.equal(model.accounts[0]!.needsReauth, false);
  assert.equal(model.accounts[1]!.needsReauth, true);
  assert.equal(
    model.accounts[2]!.needsReauth,
    false,
    'an expired token the refresher can renew is not something the user must act on',
  );
  assert.ok(render(model, { width: 120, color: false }, NOW).includes('needs re-auth'));
});

test('an observation old enough to be untrustworthy says so', () => {
  const { stateRoot, authswapRoot } = world([
    { slot: '1', email: 'a@b.com', u5h: 0.1, u7d: 0.1, observedAgoMs: 30 * 3600_000 },
    { slot: '2', email: 'c@d.com', u5h: 0.1, u7d: 0.1 },
  ]);
  const model = gather({}, { stateRoot, authswapRoot, nowMs: NOW });
  assert.equal(model.accounts[0]!.aged, true);
  assert.equal(model.accounts[1]!.aged, false);
  const rows = render(model, { width: 160, color: false }, NOW).split('\n');
  assert.ok(rows.find(r => r.includes('1 a'))!.includes('stale'));
  assert.ok(!rows.find(r => r.includes('2 c'))!.includes('stale'));
});

test('context tokens are unknown, not zero, when every usage field is renamed away', () => {
  // `?? 0` on each field turns a payload shape change into a confident "empty
  // context" on a context that is actually full.
  const renamed = contextUsage({
    context_window: { context_window_size: 1_000_000, current_usage: { total_tokens: 900_000 } as never },
  });
  assert.equal(renamed.tokens, undefined);
  const known = contextUsage({
    context_window: { context_window_size: 1_000_000, current_usage: { input_tokens: 10, output_tokens: 5 } },
  });
  assert.equal(known.tokens, 15, 'the turn output occupies context on the next request');
});

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

test("the session's own model wins over a more recent lease on another account", () => {
  // A background haiku call can be the most recently used lease while the
  // foreground turn runs elsewhere. The exact key must be consulted first.
  const { stateRoot, authswapRoot } = world([
    { slot: '1', email: 'a@b.com', u5h: 0.1, u7d: 0.1 },
    { slot: '2', email: 'c@d.com', u5h: 0.1, u7d: 0.1 },
  ]);
  // The haiku lease is strictly the more recent one, so a scan that picks "most
  // recently used" answers slot 2 — which is the wrong account for this turn.
  new AffinityStore({ stateRoot, now: () => NOW - 60_000 }).touch('sess-1', '1', 'claude-opus-5');
  new AffinityStore({ stateRoot, now: () => NOW }).touch('sess-1', '2', 'claude-haiku-4-5');

  const model = gather(
    { session_id: 'sess-1', model: { id: 'claude-opus-5' } },
    { stateRoot, authswapRoot, nowMs: NOW },
  );
  assert.equal(model.accounts.find(a => a.active)!.slot, '1');
  assert.equal(model.sessionAttributed, true);
});

test('an unrouted session says so instead of looking like a routed one', () => {
  const { stateRoot, authswapRoot } = world([{ slot: '1', email: 'a@b.com', u5h: 0.1, u7d: 0.1 }]);
  const model = gather({ session_id: 'never-seen' }, { stateRoot, authswapRoot, nowMs: NOW });
  assert.equal(model.sessionAttributed, false);
  assert.ok(render(model, { width: 160, color: false }, NOW).includes('not routed yet'));
});

// ---------------------------------------------------------------------------
// Terminal robustness
// ---------------------------------------------------------------------------

test('a zero-width bar returns nothing rather than throwing RangeError', () => {
  // barWidth floors at 5 today, but a thrown statusline is a broken HUD on
  // every turn, so the primitive guards its own floor.
  assert.equal(bar(50, 0, quotaColor, false), '');
  assert.equal(bar(undefined, 0, quotaColor, true), '');
  assert.equal(bar(50, -3, quotaColor, true), '');
});

test('a label is cut on code-point boundaries, never mid-surrogate', () => {
  const label = shortLabel('AAA'.repeat(20) + '@b.com', '1');
  assert.ok(!LONE_HIGH.test(label), 'no lone high surrogate');
  assert.ok(!LONE_LOW.test(label), 'no lone low surrogate');
  const emoji = shortLabel(EMOJI.repeat(20) + '@b.com', '1');
  assert.ok(!LONE_HIGH.test(emoji), 'no lone high surrogate');
  assert.ok(!LONE_LOW.test(emoji), 'no lone low surrogate');
});

test('control characters in a credential filename never reach the terminal', () => {
  // The filename capture group accepts any byte. A newline would inject a row;
  // an ESC would be counted as text by the width helpers and executed by the
  // terminal.
  const label = shortLabel('a\nb' + ESC + '[2Jc@d.com', '1');
  assert.ok(!CONTROLS_RE.test(label), 'label still holds controls: ' + JSON.stringify(label));
});

test('a hard cut is marked, so a truncated row is never read as a complete one', () => {
  // A 96% account whose 7d bar falls off the end otherwise renders as idle.
  const { stateRoot, authswapRoot } = world([{ slot: '1', email: 'joseph.b.serra@b.com', u5h: 0, u7d: 0.96 }]);
  const line = render(gather({}, { stateRoot, authswapRoot, nowMs: NOW }), { width: 34, color: false }, NOW)
    .split('\n')
    .find(l => l.includes('1 joseph'))!;
  assert.ok(visibleWidth(line) <= 34, 'line is ' + visibleWidth(line) + ' cols');
  assert.ok(line.endsWith(ELLIPSIS), 'a cut row must show it was cut: ' + JSON.stringify(line));
});

test('truncation emits no escape at all when colour is off', () => {
  const { stateRoot, authswapRoot } = world([{ slot: '1', email: 'joseph.b.serra@b.com', u5h: 0, u7d: 0.96 }]);
  const out = render(gather({}, { stateRoot, authswapRoot, nowMs: NOW }), { width: 30, color: false }, NOW);
  assert.ok(!out.includes(ESC), 'NO_COLOR output still carries an escape: ' + JSON.stringify(out));
});

test('an ASCII terminal gets a bar made of characters it can draw', () => {
  const { stateRoot, authswapRoot } = world([{ slot: '1', email: 'a@b.com', u5h: 0.5, u7d: 0.5 }]);
  const out = render(
    gather({}, { stateRoot, authswapRoot, nowMs: NOW }),
    { width: 160, color: false, glyphs: ASCII_GLYPHS },
    NOW,
  );
  assert.ok(!NON_ASCII.test(out), 'non-ASCII glyph survived: ' + JSON.stringify(out));
  assert.ok(out.includes('#'), 'the bar still has a fill');
});

test('active and inactive rows start at the same column', () => {
  // The TUI trims leading whitespace, so a blank inactive marker is eaten and
  // every inactive row shifts one column left. Observed in a real terminal.
  const { stateRoot, authswapRoot } = world([
    { slot: '1', email: 'a@b.com', u5h: 0.1, u7d: 0.1 },
    { slot: '2', email: 'c@d.com', u5h: 0.1, u7d: 0.1 },
  ]);
  const store = new AffinityStore({ stateRoot, now: () => NOW });
  store.touch('s', '1', 'claude-opus-5');
  const rows = render(
    gather({ session_id: 's', model: { id: 'claude-opus-5' } }, { stateRoot, authswapRoot, nowMs: NOW }),
    { width: 160, color: false },
    NOW,
  )
    .split('\n')
    .filter(l => /\d [a-z]/.test(l));
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.indexOf('5h'), rows[1]!.indexOf('5h'), 'quota columns must align across rows');
});

test('every line fits, including the status note that only appears when something is wrong', () => {
  // The note renders exactly when the balancer is unhealthy. A note that wraps
  // pushes the account rows out of the status region, hiding the data at the
  // moment it matters most.
  const { stateRoot, authswapRoot } = world([
    { slot: '1', email: 'info@notanotherdashboard.com', u5h: 0.43, u7d: 0.08 },
    { slot: '2', email: 'joseph.b.serra@gmail.com', u5h: 0, u7d: 0.96 },
  ]);
  const model = gather({ session_id: 'unrouted' }, { stateRoot, authswapRoot, nowMs: NOW });
  for (const width of [200, 120, 100, 80, 60, 45, 40, 30, 20, 12]) {
    for (const line of render(model, { width, color: false }, NOW).split('\n')) {
      assert.ok(visibleWidth(line) <= width, `width=${width}: ${visibleWidth(line)} cols: ${line}`);
    }
  }
});
