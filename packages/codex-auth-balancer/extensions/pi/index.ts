import {
  createAssistantMessageEventStream,
  getModels,
  streamSimpleOpenAICodexResponses,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  finishTokenLease,
  ingestLiveUsage,
  loadAccounts,
  startTokenLease,
  type FinishTokenLeaseInput,
  type LiveUsageIngestInput,
  type StartTokenLeaseInput,
  type TokenLease,
  type TokenLeaseFinishStatus,
} from '../../src/index.js';
import {
  classifyRateLimit,
  DEFAULT_ROTATION_CONFIG,
  runWithRotation,
  type Attempt,
  type RotationConfig,
  type SlotInfo,
} from './rotation-policy.js';

const PROVIDER = 'bravo-codex-balanced';
const UPSTREAM_PROVIDER = 'openai-codex';
const API = 'openai-codex-responses' as const;
const DEFAULT_EXPECTED_RUNTIME_MS = 10 * 60_000;
const DEFAULT_TTL_SAFETY_BUFFER_MS = 60_000;

function publicModelId(model: Model<typeof API>): string {
  return model.id.startsWith(`${PROVIDER}/`) ? model.id : `${PROVIDER}/${model.id}`;
}

function upstreamModelId(model: Model<typeof API>): string {
  return model.id.startsWith(`${PROVIDER}/`) ? model.id.slice(PROVIDER.length + 1) : model.id;
}

function publicModel(model: Model<typeof API>): Model<typeof API> {
  return { ...model, id: publicModelId(model), provider: PROVIDER, api: API };
}

function restoreMessage(message: AssistantMessage, model: Model<typeof API>): AssistantMessage {
  return { ...message, api: API, provider: PROVIDER, model: publicModelId(model), errorMessage: message.errorMessage ? redactedErrorMessage(message.errorMessage) : message.errorMessage };
}

function restoreEvent(event: AssistantMessageEvent, model: Model<typeof API>): AssistantMessageEvent {
  switch (event.type) {
    case 'done': return { ...event, message: restoreMessage(event.message, model) };
    case 'error': return { ...event, error: restoreMessage(event.error, model) };
    default: return { ...event, partial: restoreMessage(event.partial, model) } as AssistantMessageEvent;
  }
}

function affinityFromOptions(options?: SimpleStreamOptions): string | undefined {
  return typeof options?.sessionId === 'string' && options.sessionId ? options.sessionId : undefined;
}

function redactedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]').replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
}

function errorTextOfEvent(event: AssistantMessageEvent | undefined): string | undefined {
  return event?.type === 'error' ? (event.error.errorMessage ?? undefined) : undefined;
}

// ── Dependency seam (real I/O injected here; tests pass fakes) ───────────────

export type BalancedRunnerDeps = {
  startLease: (input: StartTokenLeaseInput) => Promise<TokenLease>;
  finishLease: (input: FinishTokenLeaseInput) => Promise<unknown>;
  listSlots: (stateRoot?: string) => Promise<SlotInfo[]>;
  createUpstream: (model: Model<typeof API>, context: Context, options: SimpleStreamOptions) => AsyncIterable<AssistantMessageEvent>;
  ingestUsage: (input: LiveUsageIngestInput) => Promise<unknown>;
  cooldown: Map<string, number>;
  config: RotationConfig;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  rand: () => number;
  now: () => number;
  stateRoot?: string;
};

// Shared across the whole provider process so a slot that just 429'd stays
// deprioritized for later turns (not just the current call).
const sharedCooldown = new Map<string, number>();

function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function defaultRunnerDeps(): BalancedRunnerDeps {
  return {
    startLease: startTokenLease,
    finishLease: finishTokenLease,
    listSlots: async (stateRoot?: string) => (await loadAccounts(stateRoot)).map(a => ({ slot: a.slot, primaryRemaining: a.usage?.primary?.remainingPercent })),
    createUpstream: (model, context, options) => streamSimpleOpenAICodexResponses(model, context, options),
    ingestUsage: ingestLiveUsage,
    cooldown: sharedCooldown,
    config: DEFAULT_ROTATION_CONFIG,
    sleep: realSleep,
    rand: Math.random,
    now: Date.now,
  };
}

export function createBalancedStreamRunner(overrides: Partial<BalancedRunnerDeps> = {}): (model: Model<typeof API>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
  const deps: BalancedRunnerDeps = { ...defaultRunnerDeps(), ...overrides };
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    void runBalanced(deps, stream, model, context, options);
    return stream;
  };
}

async function runBalanced(
  deps: BalancedRunnerDeps,
  stream: AssistantMessageEventStream,
  model: Model<typeof API>,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<void> {
  const signal = options?.signal;
  let pushedTerminal = false;
  let lastSuppressedError: AssistantMessageEvent | undefined;
  let activeFinish: (() => Promise<void>) | undefined;

  // Keep the process-shared cooldown bounded: drop entries that have expired (and
  // thereby any slots that no longer exist once their cooldown lapses).
  for (const [slot, until] of deps.cooldown) if (until <= deps.now()) deps.cooldown.delete(slot);

  const buildErrorMessage = (error: unknown, aborted: boolean): AssistantMessage => ({
    role: 'assistant',
    content: [],
    api: API,
    provider: PROVIDER,
    model: publicModelId(model),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: aborted ? 'aborted' : 'error',
    errorMessage: redactedErrorMessage(error),
    timestamp: deps.now(),
  });
  const forwardTerminal = (event: AssistantMessageEvent) => { pushedTerminal = true; stream.push(restoreEvent(event, model)); };
  const forwardError = (error: unknown, aborted = false) => {
    if (pushedTerminal) return;
    pushedTerminal = true;
    const message = buildErrorMessage(error, aborted);
    stream.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: message });
  };

  const onAbort = () => { void activeFinish?.().catch(() => undefined); };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  const runAttempt = async (forcedSlot: string | undefined): Promise<Attempt> => {
    let lease: TokenLease;
    try {
      lease = await deps.startLease({
        provider: PROVIDER,
        model: publicModelId(model),
        purpose: 'pi-provider-request',
        expected_runtime_ms: Number((options as Record<string, unknown> | undefined)?.expectedRuntimeMs ?? DEFAULT_EXPECTED_RUNTIME_MS),
        ttl_safety_buffer_ms: Number((options as Record<string, unknown> | undefined)?.ttlSafetyBufferMs ?? DEFAULT_TTL_SAFETY_BUFFER_MS),
        session_affinity_key: affinityFromOptions(options),
        preferred_slot: forcedSlot,
        abort_signal: signal,
      });
    } catch (leaseError) {
      if (signal?.aborted) { forwardError(new Error('Request was aborted'), true); return { outcome: 'aborted', slot: forcedSlot ?? '(none)' }; }
      // A forced slot that policy rejects (hard floor / broken) should not abort the
      // whole turn — let rotation move on to the remaining accounts.
      if (forcedSlot) return { outcome: 'rate-limited', slot: forcedSlot };
      forwardError(leaseError);
      return { outcome: 'other-error', slot: '(none)' };
    }

    let finished = false;
    const finishLease = async (status: TokenLeaseFinishStatus) => {
      if (finished) return;
      finished = true;
      if (activeFinish === abortFinish) activeFinish = undefined;
      try {
        await deps.finishLease({ lease_id: lease.lease_id, reservation_id: lease.reservation_id, launch_id: lease.launch_id, status });
      } catch (finishError) {
        process.stderr.write(`[codex-balanced-provider] lease finish failed: ${redactedErrorMessage(finishError)}\n`);
      }
    };
    const abortFinish = () => finishLease('aborted');
    activeFinish = abortFinish;

    if (signal?.aborted) { await finishLease('aborted'); forwardError(new Error('Request was aborted'), true); return { outcome: 'aborted', slot: lease.slot }; }
    if (!lease.access_token || lease.access_token.trim().length < 8) {
      await finishLease('failed');
      forwardError(new Error('Codex balanced provider refused empty access token'));
      return { outcome: 'other-error', slot: lease.slot };
    }

    let sawRateLimitStatus = false;
    const upstreamModel = { ...model, id: upstreamModelId(model), provider: UPSTREAM_PROVIDER, api: API };
    const upstreamOptions = {
      ...options,
      // Only SSE exposes HTTP response headers to onResponse; default the balanced
      // path to SSE so live usage ingestion and 429 detection cannot silently miss
      // rate-limit headers. Preserve an explicit caller transport for opt-in use.
      transport: options?.transport ?? 'sse',
      apiKey: lease.access_token,
      onResponse: async (response: { status: number; headers: Record<string, string> }, responseModel: Model<typeof API>) => {
        if (response.status === 429) sawRateLimitStatus = true;
        await (options as any)?.onResponse?.(response, responseModel);
        void deps.ingestUsage({ slot: lease.slot, reservation_id: lease.reservation_id, launch_id: lease.launch_id, headers: response.headers }).catch(() => undefined);
      },
    } as SimpleStreamOptions;

    let contentPushed = false;
    let terminalError: AssistantMessageEvent | undefined;
    try {
      for await (const event of deps.createUpstream(upstreamModel, context, upstreamOptions)) {
        if (signal?.aborted) break; // stop forwarding content/done once the caller aborted
        if (event.type === 'done') {
          await finishLease('completed');
          forwardTerminal(event);
          return { outcome: 'done', slot: lease.slot };
        }
        if (event.type === 'error') { terminalError = event; break; }
        stream.push(restoreEvent(event, model));
        contentPushed = true;
      }
    } catch (iterError) {
      terminalError = { type: 'error', reason: 'error', error: buildErrorMessage(iterError, signal?.aborted === true) };
    }

    const aborted = signal?.aborted === true || (terminalError?.type === 'error' && terminalError.reason === 'aborted');
    if (aborted) {
      await finishLease('aborted');
      forwardTerminal(terminalError ?? { type: 'error', reason: 'aborted', error: buildErrorMessage(new Error('Request was aborted'), true) });
      return { outcome: 'aborted', slot: lease.slot };
    }

    const rateLimited = classifyRateLimit({ status: sawRateLimitStatus ? 429 : undefined, errorText: errorTextOfEvent(terminalError) });
    await finishLease('failed');

    if (rateLimited && !contentPushed) {
      lastSuppressedError = terminalError;
      return { outcome: 'rate-limited', slot: lease.slot };
    }
    if (contentPushed) {
      if (terminalError) forwardTerminal(terminalError);
      return { outcome: 'streamed-error', slot: lease.slot };
    }
    forwardTerminal(terminalError ?? { type: 'error', reason: 'error', error: buildErrorMessage(new Error('Codex balanced provider produced no response'), false) });
    return { outcome: 'other-error', slot: lease.slot };
  };

  const onExhausted = () => {
    if (pushedTerminal) return;
    // Surface the real upstream rate-limit error (e.g. {"detail":"Rate limit exceeded"})
    // rather than masking it with a synthesized message.
    if (lastSuppressedError) forwardTerminal(lastSuppressedError);
    else forwardError(new Error('All Codex accounts are rate limited — try again shortly.'));
  };

  try {
    await runWithRotation({
      runAttempt,
      listSlots: () => deps.listSlots(deps.stateRoot),
      cooldown: deps.cooldown,
      config: deps.config,
      sleep: (ms: number) => deps.sleep(ms, signal),
      rand: deps.rand,
      now: deps.now,
      signalAborted: () => signal?.aborted === true,
      onExhausted,
    });
  } catch (error) {
    forwardError(error, signal?.aborted === true);
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    if (!pushedTerminal) {
      if (signal?.aborted) forwardError(new Error('Request was aborted'), true);
      else forwardError(new Error('Codex balanced provider produced no terminal event'));
    }
  }
}

export function getBalancedCodexModels(): Model<typeof API>[] {
  return getModels('openai-codex').map((model) => publicModel(model as Model<typeof API>));
}

export default function codexBalancedProvider(pi: ExtensionAPI) {
  pi.registerProvider(PROVIDER, {
    name: 'Bravo Codex Balanced',
    baseUrl: getBalancedCodexModels()[0]?.baseUrl || 'https://chatgpt.com/backend-api/codex',
    apiKey: 'bravo-codex-balanced-lease',
    api: API,
    streamSimple: createBalancedStreamRunner() as any,
    models: getBalancedCodexModels(),
  });
}
