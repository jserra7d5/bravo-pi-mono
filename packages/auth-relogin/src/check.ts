import { CLUSTER_WINDOW_MS, RED_MS, WARN_MS } from '@bravo/auth-balancer-contract';

export type Level = 'ok' | 'warn' | 'fail';
export type SlotCheck = {
  slot: string; account: string | null; deadline_at: number | null; deadline_in_ms: number | null;
  last_login_at: number | null; level: Level; reason: string | null; command: string; access_expires_at?: number | null;
};
export type ProviderPayload = { accounts: SlotCheck[]; clusters?: Array<{ slots: [string, string]; apart_ms: number }> };
export type CombinedCheck = {
  schema_version: 1; generated_at: number; worst: Level;
  providers: { claude: SlotCheck[]; codex: SlotCheck[] };
  clusters: Array<{ provider: 'claude' | 'codex'; slots: [string, string]; apart_ms: number }>;
};

export function combineChecks(claude: ProviderPayload, codex: ProviderPayload, now = Date.now()): CombinedCheck {
  const clusters: CombinedCheck['clusters'] = [];
  const sorted = [...claude.accounts].filter(a => a.deadline_at !== null).sort((a, b) => Number(a.slot) - Number(b.slot));
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
    const apart = Math.abs(sorted[i]!.deadline_at! - sorted[j]!.deadline_at!);
    if (apart < CLUSTER_WINDOW_MS) clusters.push({ provider: 'claude', slots: [sorted[i]!.slot, sorted[j]!.slot], apart_ms: apart });
  }
  for (const cluster of codex.clusters ?? []) clusters.push({ provider: 'codex', ...cluster });
  const all = [...claude.accounts, ...codex.accounts];
  const fail = all.some(a => a.level === 'fail');
  const warn = all.some(a => a.level === 'warn');
  return { schema_version: 1, generated_at: now, worst: fail ? 'fail' : warn ? 'warn' : 'ok', providers: { claude: claude.accounts, codex: codex.accounts }, clusters };
}

const monthDay = (at: number | null, withTime = false, timezone?: string) => at === null ? '—' : new Intl.DateTimeFormat('en-US', {
  month: 'short', day: '2-digit', timeZone: timezone, ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
}).format(at).replace(',', '');
const duration = (ms: number) => `${(ms / 86_400_000).toFixed(1)}d`;
const paint = (text: string, level: Level, color: boolean) => !color || level === 'ok' ? text : `\u001b[${level === 'fail' ? 31 : 33}m${text}\u001b[0m`;

function row(slot: SlotCheck, provider: 'claude' | 'codex', color: boolean, timezone?: string): string {
  const account = slot.account ?? '(no credential)';
  const deadline = provider === 'claude' ? monthDay(slot.deadline_at, true, timezone).padEnd(13) : '—'.padEnd(13);
  const inside = provider === 'claude' && slot.deadline_in_ms !== null ? duration(slot.deadline_in_ms) : '—';
  const text = `         ${slot.slot.padEnd(5)} ${(account).padEnd(38).slice(0, 38)}${deadline}${inside.padEnd(7)}${monthDay(slot.last_login_at, false, timezone)}`;
  return paint(text, slot.level === 'warn' && (slot.deadline_in_ms ?? Infinity) < RED_MS ? 'fail' : slot.level, color);
}

export function renderHuman(check: CombinedCheck, options: { color?: boolean; timezone?: string } = {}): string {
  const color = options.color ?? false;
  const stampParts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    timeZoneName: 'shortOffset', timeZone: options.timezone,
  }).formatToParts(check.generated_at);
  const part = (type: Intl.DateTimeFormatPartTypes) => stampParts.find(p => p.type === type)?.value ?? '';
  const rawOffset = part('timeZoneName').replace('GMT', '') || '+0';
  const match = /^([+\-−])(\d{1,2})(?::?(\d{2}))?$/.exec(rawOffset);
  const offset = match ? `${match[1] === '−' ? '-' : match[1]}${match[2]!.padStart(2, '0')}${match[3] ? `:${match[3]}` : ''}` : '+00';
  const stamp = `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')} ${offset}`;
  const lines = [`relogin --check                                              ${stamp}`, '',
    'claude   slot  account                                deadline      in     last login',
    ...check.providers.claude.map(a => row(a, 'claude', color, options.timezone)), '',
    'codex    slot  account                                deadline      in     last login',
    ...check.providers.codex.map(a => row(a, 'codex', color, options.timezone)), ''
  ];
  for (const provider of ['claude', 'codex'] as const) for (const slot of check.providers[provider]) {
    if (slot.level === 'fail') lines.push(`fail  ${provider} slot ${slot.slot} ${slot.reason ?? 'needs login'}`.padEnd(49) + slot.command);
  }
  for (const provider of ['claude', 'codex'] as const) for (const slot of check.providers[provider]) {
    if (slot.level === 'warn') lines.push(`warn  ${provider} slot ${slot.slot} ${slot.reason}`.padEnd(49) + slot.command);
  }
  for (const cluster of check.clusters) {
    const [a, b] = cluster.slots;
    lines.push(cluster.provider === 'claude'
      ? `warn  claude slots ${a} and ${b} fall ${duration(cluster.apart_ms)} apart; stagger one of them`
      : `warn  codex slots ${a} and ${b} expire together (${duration(cluster.apart_ms)} apart); stagger one of them`);
  }
  const all = [...check.providers.claude, ...check.providers.codex];
  const dead = all.filter(a => a.level === 'fail').length;
  const attention = all.filter(a => a.level === 'warn').length;
  lines.push('', `${all.length - dead - attention} slots healthy, ${attention} need attention, ${dead} dead.`);
  return lines.join('\n');
}

export function exitCodeForCheck(check: CombinedCheck): 0 | 3 {
  const red = [...check.providers.claude, ...check.providers.codex]
    .some(slot => slot.deadline_in_ms !== null && slot.deadline_in_ms < RED_MS);
  return check.worst === 'fail' || red ? 3 : 0;
}
export { WARN_MS };
