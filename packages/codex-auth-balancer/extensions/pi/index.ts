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
  resolveStateRoot,
  startTokenLease,
  writeBrokenSnapshot,
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
import { redactSecretsInText } from '../../src/oauth-error.js';

const PROVIDER = 'bravo-codex-balanced';
const UPSTREAM_PROVIDER = 'openai-codex';
const API = 'openai-codex-responses' as const;
const DEFAULT_EXPECTED_RUNTIME_MS = 10 * 60_000;
const DEFAULT_TTL_SAFETY_BUFFER_MS = 60_000;

const GPT_5_6_CODEX_MODEL_IDS = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
]);
const GPT_5_6_CODEX_CONTEXT_WINDOW = 372000;

function publicModelId(model: Model<typeof API>): string {
  return model.id.startsWith(`${PROVIDER}/`) ? model.id : `${PROVIDER}/${model.id}`;
}

function upstreamModelId(model: Model<typeof API>): string {
  return model.id.startsWith(`${PROVIDER}/`) ? model.id.slice(PROVIDER.length + 1) : model.id;
}

function publicModel(model: Model<typeof API>): Model<typeof API> {
  return { ...model, id: publicModelId(model), provider: PROVIDER, api: API };
}

const EMPTY_REASONING_COMMENT = '<!-- -->';

function sanitizeVisibleReasoning(text: string, bufferIncompleteMarker: boolean): string {
  let visible = '';
  let lineStart = 0;

  while (lineStart < text.length) {
    const lf = text.indexOf('\n', lineStart);
    const cr = text.indexOf('\r', lineStart);
    const lineEnd = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
    if (lineEnd < 0) {
      const trailingLine = text.slice(lineStart);
      if (trailingLine !== EMPTY_REASONING_COMMENT && !(bufferIncompleteMarker && EMPTY_REASONING_COMMENT.startsWith(trailingLine))) {
        visible += trailingLine;
      }
      break;
    }

    const line = text.slice(lineStart, lineEnd);
    const newline = text[lineEnd] === '\r' && text[lineEnd + 1] === '\n' ? '\r\n' : text[lineEnd];
    if (line !== EMPTY_REASONING_COMMENT) visible += line + newline;
    lineStart = lineEnd + newline.length;
  }

  return visible;
}

function restoreMessage(message: AssistantMessage, model: Model<typeof API>, bufferedContentIndex?: number): AssistantMessage {
  return {
    ...message,
    api: API,
    provider: PROVIDER,
    model: publicModelId(model),
    errorMessage: message.errorMessage ? redactedErrorMessage(message.errorMessage) : message.errorMessage,
    content: message.content.map((block, index) => block.type === 'thinking'
      ? { ...block, thinking: sanitizeVisibleReasoning(block.thinking, index === bufferedContentIndex) }
      : block),
  };
}

function thinkingTextAt(message: AssistantMessage, contentIndex: number): string {
  const block = message.content[contentIndex];
  return block?.type === 'thinking' ? block.thinking : '';
}

function flushVisibleThinking(message: AssistantMessage, visibleThinking: Map<number, string>): AssistantMessageEvent[] {
  const events: AssistantMessageEvent[] = [];
  for (const [contentIndex, previous] of visibleThinking) {
    const current = thinkingTextAt(message, contentIndex);
    const delta = current.startsWith(previous) ? current.slice(previous.length) : '';
    if (delta) events.push({ type: 'thinking_delta', contentIndex, delta, partial: message });
  }
  visibleThinking.clear();
  return events;
}

function restoreEvents(
  event: AssistantMessageEvent,
  model: Model<typeof API>,
  visibleThinking: Map<number, string>,
): AssistantMessageEvent[] {
  switch (event.type) {
    case 'done': {
      const message = restoreMessage(event.message, model);
      return [...flushVisibleThinking(message, visibleThinking), { ...event, message }];
    }
    case 'error': {
      const error = restoreMessage(event.error, model);
      return [...flushVisibleThinking(error, visibleThinking), { ...event, error }];
    }
    case 'thinking_start': {
      const partial = restoreMessage(event.partial, model);
      visibleThinking.set(event.contentIndex, thinkingTextAt(partial, event.contentIndex));
      return [{ ...event, partial }];
    }
    case 'thinking_delta': {
      const partial = restoreMessage(event.partial, model, event.contentIndex);
      const current = thinkingTextAt(partial, event.contentIndex);
      const previous = visibleThinking.get(event.contentIndex) ?? '';
      visibleThinking.set(event.contentIndex, current);
      return [{ ...event, delta: current.startsWith(previous) ? current.slice(previous.length) : '', partial }];
    }
    case 'thinking_end': {
      const partial = restoreMessage(event.partial, model);
      const content = thinkingTextAt(partial, event.contentIndex);
      const previous = visibleThinking.get(event.contentIndex) ?? '';
      visibleThinking.set(event.contentIndex, content);
      const flush = content.startsWith(previous) ? content.slice(previous.length) : '';
      return [
        ...(flush ? [{ type: 'thinking_delta' as const, contentIndex: event.contentIndex, delta: flush, partial }] : []),
        { ...event, content, partial },
      ];
    }
    default: return [{ ...event, partial: restoreMessage(event.partial, model) } as AssistantMessageEvent];
  }
}

function affinityFromOptions(options?: SimpleStreamOptions): string | undefined {
  return typeof options?.sessionId === 'string' && options.sessionId ? options.sessionId : undefined;
}

function redactedErrorMessage(error: unknown): string {
  return redactSecretsInText(error instanceof Error ? error.message : String(error));
}

function errorTextOfEvent(event: AssistantMessageEvent | undefined): string | undefined {
  return event?.type === 'error' ? (event.error.errorMessage ?? undefined) : undefined;
}

// Narrow matcher: ONLY the upstream accountId-extraction failure (a leased token
// the upstream couldn't extract a chatgpt_account_id from). Deliberately does NOT
// match generic errors. Rate-limits are already classified earlier via classifyRateLimit.
function isAuthRejection(text: string | undefined): boolean {
  return !!text && /failed to extract accountid/i.test(text);
}

// ── Dependency seam (real I/O injected here; tests pass fakes) ───────────────

export type BalancedRunnerDeps = {
  startLease: (input: StartTokenLeaseInput) => Promise<TokenLease>;
  finishLease: (input: FinishTokenLeaseInput) => Promise<unknown>;
  listSlots: (stateRoot?: string) => Promise<SlotInfo[]>;
  createUpstream: (model: Model<typeof API>, context: Context, options: SimpleStreamOptions) => AsyncIterable<AssistantMessageEvent>;
  ingestUsage: (input: LiveUsageIngestInput) => Promise<unknown>;
  markBroken: (slot: string, code: string, message: string) => void;
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
    markBroken: (slot, code, message) => { try { writeBrokenSnapshot(resolveStateRoot(), slot, code, message); } catch { /* ignore */ } },
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
  let lastLeaseError: unknown;
  let lastAuthError: AssistantMessageEvent | undefined;
  let activeFinish: (() => Promise<void>) | undefined;
  let lastUpstreamPartial: AssistantMessage | undefined;
  const visibleThinking = new Map<number, string>();

  // Keep the process-shared cooldown bounded: drop entries that have expired (and
  // thereby any slots that no longer exist once their cooldown lapses).
  for (const [slot, until] of deps.cooldown) if (until <= deps.now()) deps.cooldown.delete(slot);

  const buildErrorMessage = (error: unknown, aborted: boolean): AssistantMessage => ({
    role: 'assistant',
    content: lastUpstreamPartial?.content ?? [],
    api: API,
    provider: PROVIDER,
    model: publicModelId(model),
    usage: lastUpstreamPartial?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: aborted ? 'aborted' : 'error',
    errorMessage: redactedErrorMessage(error),
    timestamp: lastUpstreamPartial?.timestamp ?? deps.now(),
    responseId: lastUpstreamPartial?.responseId,
  });
  const forwardTerminal = (event: AssistantMessageEvent) => {
    pushedTerminal = true;
    for (const restored of restoreEvents(event, model, visibleThinking)) stream.push(restored);
  };
  const forwardError = (error: unknown, aborted = false) => {
    if (pushedTerminal) return;
    pushedTerminal = true;
    const message = buildErrorMessage(error, aborted);
    const terminal: AssistantMessageEvent = { type: 'error', reason: aborted ? 'aborted' : 'error', error: message };
    for (const restored of restoreEvents(terminal, model, visibleThinking)) stream.push(restored);
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
      // A lease failure (forced slot rejected, OR the round-0 auto-selected slot is
      // broken) should not abort the whole turn — record the real error and let
      // rotation move on to the remaining accounts. The error is surfaced by
      // onExhausted only if every slot fails to lease.
      lastLeaseError = leaseError;
      return { outcome: 'lease-failed', slot: forcedSlot ?? '(none)' };
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
        if ('partial' in event) lastUpstreamPartial = event.partial;
        if (event.type === 'done') {
          await finishLease('completed');
          forwardTerminal(event);
          return { outcome: 'done', slot: lease.slot };
        }
        if (event.type === 'error') { terminalError = event; break; }
        for (const restored of restoreEvents(event, model, visibleThinking)) stream.push(restored);
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
    // Upstream rejected the leased token (e.g. couldn't extract a chatgpt_account_id).
    // Quarantine the slot broken and rotate to another slot instead of surfacing it.
    // finishLease('failed') already ran above (idempotent), so do not re-call it.
    if (!contentPushed && !rateLimited && isAuthRejection(errorTextOfEvent(terminalError))) {
      deps.markBroken(lease.slot, 'upstream_no_accountid', redactedErrorMessage(errorTextOfEvent(terminalError) ?? 'upstream could not extract accountId'));
      lastAuthError = terminalError;
      return { outcome: 'auth-rejected', slot: lease.slot };
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
    // Surface the most informative terminal error:
    //  1. a real upstream rate-limit error (e.g. {"detail":"Rate limit exceeded"});
    //  2. else the genuine lease-acquisition error (e.g. 'selected slot access token
    //     refresh failed') so the user sees why, not a misleading rate-limit string;
    //  3. else an upstream auth-rejection error (e.g. 'Failed to extract accountId
    //     from token') when every slot was quarantined broken;
    //  4. else the synthesized rate-limit message as a last resort.
    if (lastSuppressedError) forwardTerminal(lastSuppressedError);
    else if (lastLeaseError !== undefined) forwardError(lastLeaseError);
    else if (lastAuthError) forwardTerminal(lastAuthError);
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

export function mapBalancedCodexModels(models: Model<typeof API>[]): Model<typeof API>[] {
  return models.map((upstream) => {
    const corrected = GPT_5_6_CODEX_MODEL_IDS.has(upstreamModelId(upstream))
      ? { ...upstream, contextWindow: GPT_5_6_CODEX_CONTEXT_WINDOW }
      : upstream;
    return publicModel(corrected);
  });
}

export function getBalancedCodexModels(): Model<typeof API>[] {
  return mapBalancedCodexModels(getModels('openai-codex').map((model) => model as Model<typeof API>));
}

export function registerBalancedProvider(pi: ExtensionAPI): void {
  const models = getBalancedCodexModels();
  pi.registerProvider(PROVIDER, {
    name: 'Bravo Codex Balanced',
    baseUrl: models[0]?.baseUrl || 'https://chatgpt.com/backend-api/codex',
    // Placeholder only: the real, claim-bearing access token is injected per
    // request by the lease inside createBalancedStreamRunner(). This value is
    // what reaches the upstream if our api-handler override is ever lost (see
    // below), which is why a lost override surfaces as the upstream
    // "Failed to extract accountId from token" — it is not a JWT.
    apiKey: 'bravo-codex-balanced-lease',
    api: API,
    streamSimple: createBalancedStreamRunner() as any,
    models,
  });
}

export default function codexBalancedProvider(pi: ExtensionAPI) {
  // registerProvider installs an override of the shared `openai-codex-responses`
  // api-handler (pi-ai's api-registry is one global, last-writer-wins map); that
  // override is what routes every request through the per-request balanced lease.
  registerBalancedProvider(pi);

  // pi's reload() — invoked by BOTH print-mode (`pi -p`) and the interactive TUI
  // — calls resetApiProviders(), which clears the api-registry and re-registers
  // ONLY the built-in handlers, silently dropping our override. (model-registry
  // refresh() resets too, but re-applies registered providers afterward;
  // reload() does not.) Once dropped, a bravo-codex-balanced request resolves to
  // the BUILT-IN codex handler and is handed our placeholder apiKey, so the
  // upstream extractAccountId() throws "Failed to extract accountId from token"
  // and the lease/rotation path is never reached (no reservation, no failover).
  // Re-assert before every turn and on (re)start so the override is always
  // present at dispatch time. registerProvider is documented safe to call from
  // event callbacks, takes effect immediately, and writes to the process-global
  // registry pi dispatches from — so this self-heals any reset, whenever it ran.
  pi.on('session_start', () => { registerBalancedProvider(pi); });
  pi.on('turn_start', () => { registerBalancedProvider(pi); });

  // turn_start does NOT cover the two non-turn model-stream paths. Both issue
  // their summarization LLM call through the SAME agent.streamFn → streamSimple →
  // getApiProvider() dispatch as a normal turn, so they equally need the override
  // present — but they run outside the turn lifecycle, so if a reset lands before
  // them they hit the built-in codex handler with our placeholder apiKey and
  // throw "Failed to extract accountId from token" (the lease path never runs).
  // pi emits a dedicated session_before_* event immediately before each stream,
  // so re-asserting on those closes both gaps:
  //   - session_before_compact: compaction (compact() + _runAutoCompaction()).
  //     Auto/threshold compaction fires AFTER agent_end and BEFORE the next
  //     turn's turn_start (agent-session checkAndCompact), exactly the gap a
  //     reset slips through while turns themselves recover on the next turn_start.
  //   - session_before_tree: branch summarization on tree navigation / fork
  //     (agent-session generateBranchSummary), which never runs inside a turn.
  // Both are "session_before_*" events: runner.emit ignores a falsy handler
  // result, so returning undefined never cancels the operation or clobbers
  // another extension's {cancel}/{summary}/{compaction} result.
  pi.on('session_before_compact', () => { registerBalancedProvider(pi); });
  pi.on('session_before_tree', () => { registerBalancedProvider(pi); });
}
