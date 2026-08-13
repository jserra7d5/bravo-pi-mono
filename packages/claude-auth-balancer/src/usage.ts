// Usage extraction and cost attribution. Pure: no fs, no network, no clock.
//
// The proxy sees every response, so it is the only place in the stack that can
// attribute token usage to an account. Claude Code's own transcripts record
// rich per-request usage but carry no account identity at all, and the Codex
// balancer never captured tokens or cost because no column for them exists.
// Capturing here fixes both at once.

export type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** 5-minute-TTL slice of cache creation, when the server breaks it out. */
  cacheCreation5mTokens?: number;
  /** 1-hour-TTL slice. Claude Code writes ~100% of its cache at this TTL. */
  cacheCreation1hTokens?: number;
};

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function mergeUsage(into: Usage, from: Usage): Usage {
  for (const key of Object.keys(from) as (keyof Usage)[]) {
    const v = from[key];
    if (v === undefined) continue;
    // output_tokens arrives cumulatively on message_delta; last write wins.
    into[key] = v;
  }
  return into;
}

/** Pull a Usage out of an API `usage` object, tolerating unknown extra fields. */
export function usageFromObject(raw: unknown): Usage {
  if (!raw || typeof raw !== 'object') return {};
  const u = raw as Record<string, unknown>;
  const creation = u['cache_creation'];
  const c = creation && typeof creation === 'object' ? (creation as Record<string, unknown>) : undefined;
  return {
    inputTokens: num(u['input_tokens']),
    outputTokens: num(u['output_tokens']),
    cacheReadInputTokens: num(u['cache_read_input_tokens']),
    cacheCreationInputTokens: num(u['cache_creation_input_tokens']),
    cacheCreation5mTokens: num(c?.['ephemeral_5m_input_tokens']),
    cacheCreation1hTokens: num(c?.['ephemeral_1h_input_tokens']),
  };
}

/**
 * Incremental SSE reader that accumulates usage without buffering the response.
 *
 * `message_start` carries the input-side usage (including the cache read and
 * cache creation split); `message_delta` carries the running output count.
 */
/**
 * Cap on the unterminated frame we will hold. A response body with no blank
 * line — a large non-SSE JSON payload, or a malformed stream — would otherwise
 * accumulate in full, so a multi-hundred-megabyte response could exhaust memory
 * on a process whose only job is to observe it.
 */
export const MAX_PENDING_FRAME_BYTES = 256 * 1024;

export class UsageCollector {
  private buffer = '';
  /** Set once a frame exceeded the cap, so we stop growing without lying. */
  overflowed = false;
  readonly usage: Usage = {};
  model: string | undefined;

  /** Feed decoded (already decompressed) response text. */
  push(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    // SSE frames are separated by a blank line; keep the trailing partial.
    while ((index = this.buffer.indexOf('\n\n')) !== -1) {
      const frame = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      this.consumeFrame(frame);
    }
    if (this.buffer.length > MAX_PENDING_FRAME_BYTES) {
      // No frame delimiter in sight. Keep the tail, in case the delimiter is
      // straddling, and drop the rest rather than growing without bound.
      this.overflowed = true;
      this.buffer = this.buffer.slice(-MAX_PENDING_FRAME_BYTES);
    }
  }

  /** Call once the stream ends, to drain any frame without a trailing blank line. */
  end(): Usage {
    if (this.buffer.trim().length > 0) {
      this.consumeFrame(this.buffer);
      this.buffer = '';
    }
    return this.usage;
  }

  private consumeFrame(frame: string): void {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      this.consumeEvent(parsed);
    }
  }

  private consumeEvent(event: unknown): void {
    if (!event || typeof event !== 'object') return;
    const e = event as Record<string, unknown>;
    const message = e['message'];
    if (message && typeof message === 'object') {
      const m = message as Record<string, unknown>;
      if (typeof m['model'] === 'string') this.model = m['model'];
      if (m['usage']) mergeUsage(this.usage, usageFromObject(m['usage']));
    }
    if (e['usage']) mergeUsage(this.usage, usageFromObject(e['usage']));
  }
}

/** Parse a complete non-streaming JSON response body for usage. */
export function usageFromJsonBody(body: string): Usage {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return usageFromObject(parsed['usage']);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Cost attribution
// ---------------------------------------------------------------------------

export type ModelPricing = {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
};

/**
 * First-party API list prices, USD per 1M tokens (as of 2026-06-24).
 * Matched by substring against the request's model id, longest key first.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  'fable-5': { input: 10, output: 50 },
  'mythos-5': { input: 10, output: 50 },
  'opus-5': { input: 5, output: 25 },
  'opus-4': { input: 5, output: 25 },
  'sonnet-5': { input: 3, output: 15 },
  'sonnet-4': { input: 3, output: 15 },
  'haiku-4': { input: 1, output: 5 },
};

/** Cache multipliers against the model's base input price. */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2.0;

export function pricingForModel(model: string | undefined): ModelPricing | undefined {
  if (!model) return undefined;
  const needle = model.toLowerCase();
  const key = Object.keys(MODEL_PRICING)
    .sort((a, b) => b.length - a.length)
    .find(k => needle.includes(k));
  return key ? MODEL_PRICING[key] : undefined;
}

export type CostBreakdown = {
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
  totalUsd: number;
  /** What the same request would have cost with no cache at all. */
  uncachedEquivalentUsd: number;
  /** uncachedEquivalentUsd - totalUsd. Negative means the cache lost money. */
  savedUsd: number;
};

/**
 * Equivalent first-party API cost for one request.
 *
 * On a subscription these dollars are not billed. They are the honest unit for
 * comparing accounts, models, and sessions, and for valuing cache affinity: a
 * cache read is 0.1x base input, a 1h cache write is 2.0x, so re-creating a
 * 260k-token prefix costs 20x what reading it would have.
 */
export function computeCost(model: string | undefined, usage: Usage): CostBreakdown | undefined {
  const price = pricingForModel(model);
  if (!price) return undefined;
  const perInput = price.input / 1_000_000;
  const perOutput = price.output / 1_000_000;

  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const created = usage.cacheCreationInputTokens ?? 0;

  // Prefer the explicit TTL split when present; otherwise assume 1h, which is
  // what Claude Code actually writes (measured: 100% 1h, zero 5m).
  const write5m = usage.cacheCreation5mTokens ?? 0;
  const write1h = usage.cacheCreation1hTokens ?? (write5m > 0 ? Math.max(0, created - write5m) : created);

  const inputUsd = input * perInput;
  const outputUsd = output * perOutput;
  const cacheReadUsd = cacheRead * perInput * CACHE_READ_MULTIPLIER;
  const cacheWriteUsd =
    write5m * perInput * CACHE_WRITE_5M_MULTIPLIER + write1h * perInput * CACHE_WRITE_1H_MULTIPLIER;

  const totalUsd = inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd;
  const uncachedEquivalentUsd = (input + cacheRead + created) * perInput + outputUsd;

  return {
    inputUsd,
    outputUsd,
    cacheReadUsd,
    cacheWriteUsd,
    totalUsd,
    uncachedEquivalentUsd,
    savedUsd: uncachedEquivalentUsd - totalUsd,
  };
}
