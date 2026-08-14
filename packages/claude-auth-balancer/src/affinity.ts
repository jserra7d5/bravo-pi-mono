// Session -> account leases.
//
// The affinity key is `X-Claude-Code-Session-Id`, which Claude Code stamps on
// every request it makes, including the `/v1/messages/count_tokens` preflight.
// Verified against a live CLI (2.1.231): the same UUID appears on all requests
// of one run, so no body hashing is required.
//
// Leases outlive the 1-hour prompt-cache TTL and slide forward on every request,
// so an active session never loses its account.
//
// Unlike the Codex balancer's affinity directory — which accumulated 9,980 files
// / 40 MB because nothing ever unlinked them — expired leases here are swept.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

export type AffinityLease = {
  schema_version: 1;
  session_id_hash: string;
  /**
   * Hash of the session id ALONE, without the model.
   *
   * `session_id_hash` mixes in the model, which is right for routing but makes
   * a lease unfindable by anyone who knows only the session id — the statusline,
   * which is handed `session_id` and cannot know which model string the proxy
   * saw in the request body. Additive: leases written before this field are
   * still valid, they simply cannot be found by session alone.
   */
  session_hash?: string;
  slot: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
};

/**
 * Exactly the prompt-cache TTL Claude Code writes with (1 hour — measured at
 * 100% of cache creation across 60 recent transcripts, zero 5-minute writes).
 *
 * The lease is deliberately NOT longer than the cache. A cache entry's TTL
 * refreshes on every read, so it survives until one hour after the session's
 * last request; past that the prefix is gone and staying on the same account
 * buys nothing. Letting the lease lapse at the same moment turns every idle
 * session into a free rebalancing point: it costs nothing to move, so the next
 * request lands on whichever account is healthiest.
 */
export const DEFAULT_LEASE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export type AffinityStoreOptions = {
  stateRoot: string;
  ttlMs?: number;
  sweepIntervalMs?: number;
  now?: () => number;
};

export class AffinityStore {
  private readonly dir: string;
  private readonly ttlMs: number;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private lastSweep = 0;

  constructor(options: AffinityStoreOptions) {
    this.dir = path.join(options.stateRoot, 'leases', 'affinity');
    this.ttlMs = options.ttlMs ?? DEFAULT_LEASE_TTL_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Session ids are hashed so the lease directory holds no session identifiers.
   *
   * The model is part of the key because prompt caches are scoped per account
   * AND per model. One session id covers every model a Claude Code run touches,
   * so a single key would let a Fable decision — evacuating on the Fable-only
   * `7d_oi` budget, say — move the account holding that session's warm Opus
   * prefix, paying the 20x rebuild for a budget Opus never touches.
   */
  static hashSession(sessionId: string, model?: string): string {
    return createHash('sha256')
      .update(sessionId)
      .update('\0')
      .update(model ?? '')
      .digest('hex')
      .slice(0, 32);
  }

  /**
   * Hash of a session id with no model mixed in.
   *
   * Domain-separated from {@link hashSession} so it can never equal the routing
   * key of a model-less request — those are different questions and a shared
   * value would make one look like the other.
   */
  static hashSessionOnly(sessionId: string): string {
    return createHash('sha256')
      .update('session-only\0')
      .update(sessionId)
      .digest('hex')
      .slice(0, 32);
  }

  private pathFor(hash: string): string {
    return path.join(this.dir, `${hash}.json`);
  }

  private read(hash: string): AffinityLease | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.pathFor(hash), 'utf8')) as AffinityLease;
      if (parsed?.schema_version !== 1 || typeof parsed.slot !== 'string') return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  private write(lease: AffinityLease): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const target = this.pathFor(lease.session_id_hash);
    const tmp = `${target}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(lease), { mode: 0o600 });
    renameSync(tmp, target);
  }

  /** The slot this session is pinned to, or undefined if unpinned/expired. */
  lookup(sessionId: string, model?: string): string | undefined {
    this.maybeSweep();
    const hash = AffinityStore.hashSession(sessionId, model);
    const lease = this.read(hash);
    if (!lease) return undefined;
    if (lease.expires_at <= this.now()) return undefined;
    return lease.slot;
  }

  /**
   * Pin `sessionId` to `slot` and slide the lease forward. Called on every
   * request, so an active session's lease never lapses mid-conversation.
   */
  touch(sessionId: string, slot: string, model?: string): AffinityLease {
    const now = this.now();
    const hash = AffinityStore.hashSession(sessionId, model);
    const prior = this.read(hash);
    const lease: AffinityLease = {
      schema_version: 1,
      session_id_hash: hash,
      session_hash: AffinityStore.hashSessionOnly(sessionId),
      slot,
      created_at: prior?.slot === slot ? prior.created_at : now,
      last_seen_at: now,
      expires_at: now + this.ttlMs,
    };
    this.write(lease);
    return lease;
  }

  /**
   * The live lease for a session, whichever model it was created under.
   *
   * Strictly read-only — no sweep, no writes. The statusline runs on every turn
   * of every session, and a renderer that mutates routing state is a renderer
   * that can change what it is reporting.
   *
   * A session can hold one lease per model, and they can legitimately sit on
   * different accounts. `model` is therefore not a hint but the question being
   * asked: pass the model the caller cares about and its exact lease is read
   * directly, in one stat. Without it — or if that model has no live lease —
   * the directory is scanned and the most recently used lease wins, which is
   * only an approximation: a background haiku call can be the most recent lease
   * while the foreground turn runs on another account entirely.
   *
   * The exact-key path also matters for cost. The scan is O(number of leases)
   * with a file read each, on a path that runs on every turn of every session;
   * at a thousand leases it was measured at 383ms.
   */
  peekSession(sessionId: string, model?: string, maxScan = 2000): AffinityLease | undefined {
    if (!existsSync(this.dir)) return undefined;
    const now0 = this.now();
    if (model) {
      const exact = this.read(AffinityStore.hashSession(sessionId, model));
      if (exact && exact.expires_at > now0) return exact;
    }
    const wanted = AffinityStore.hashSessionOnly(sessionId);
    const now = this.now();
    let best: AffinityLease | undefined;
    let scanned = 0;
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      // Bounded so a leaked lease directory can never make the statusline hang.
      if (++scanned > maxScan) break;
      try {
        const lease = JSON.parse(readFileSync(path.join(this.dir, name), 'utf8')) as AffinityLease;
        if (lease?.session_hash !== wanted) continue;
        if (lease.expires_at <= now) continue;
        if (!best || lease.last_seen_at > best.last_seen_at) best = lease;
      } catch {
        /* skip */
      }
    }
    return best;
  }

  /** Remove expired lease files. Rate-limited so it never runs per request. */
  maybeSweep(force = false): number {
    const now = this.now();
    if (!force && now - this.lastSweep < this.sweepIntervalMs) return 0;
    this.lastSweep = now;
    if (!existsSync(this.dir)) return 0;
    let removed = 0;
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      const full = path.join(this.dir, name);
      try {
        const lease = JSON.parse(readFileSync(full, 'utf8')) as AffinityLease;
        if (lease?.expires_at > now) continue;
      } catch {
        /* unparseable -> remove */
      }
      try {
        rmSync(full, { force: true });
        removed += 1;
      } catch {
        /* ignore */
      }
    }
    return removed;
  }

  /** All live leases, for `status` output. */
  list(): AffinityLease[] {
    if (!existsSync(this.dir)) return [];
    const now = this.now();
    const out: AffinityLease[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const lease = JSON.parse(readFileSync(path.join(this.dir, name), 'utf8')) as AffinityLease;
        if (lease?.schema_version === 1 && lease.expires_at > now) out.push(lease);
      } catch {
        /* skip */
      }
    }
    return out.sort((a, b) => b.last_seen_at - a.last_seen_at);
  }
}
