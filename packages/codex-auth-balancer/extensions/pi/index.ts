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
import { finishTokenLease, ingestLiveUsage, startTokenLease, type TokenLeaseFinishStatus } from '../../src/index.js';

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

function statusFromEvent(event: AssistantMessageEvent | undefined, aborted: boolean): TokenLeaseFinishStatus {
  if (aborted) return 'aborted';
  if (event?.type === 'done') return 'completed';
  if (event?.type === 'error' && event.reason === 'aborted') return 'aborted';
  return 'failed';
}

function affinityFromOptions(options?: SimpleStreamOptions): string | undefined {
  return typeof options?.sessionId === 'string' && options.sessionId ? options.sessionId : undefined;
}

function redactedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]').replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
}

function streamBalanced(model: Model<typeof API>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  (async () => {
    let finishOnce: (() => Promise<void>) | undefined;
    let removeAbortListener: (() => void) | undefined;
    let lastEvent: AssistantMessageEvent | undefined;
    let terminalPushed = false;
    try {
      const lease = await startTokenLease({
        provider: PROVIDER,
        model: publicModelId(model),
        purpose: 'pi-provider-request',
        expected_runtime_ms: Number((options as Record<string, unknown> | undefined)?.expectedRuntimeMs ?? DEFAULT_EXPECTED_RUNTIME_MS),
        ttl_safety_buffer_ms: Number((options as Record<string, unknown> | undefined)?.ttlSafetyBufferMs ?? DEFAULT_TTL_SAFETY_BUFFER_MS),
        session_affinity_key: affinityFromOptions(options),
        abort_signal: options?.signal,
      });
      if (!lease.access_token || lease.access_token.trim().length < 8) throw new Error('Codex balanced provider refused empty access token');
      let finalized = false;
      finishOnce = async () => {
        if (finalized) return;
        finalized = true;
        await finishTokenLease({ lease_id: lease.lease_id, reservation_id: lease.reservation_id, launch_id: lease.launch_id, status: statusFromEvent(lastEvent, options?.signal?.aborted === true) });
      };
      if (options?.signal) {
        const onAbort = () => { void finishOnce?.().catch(() => undefined); };
        options.signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener('abort', onAbort);
      }
      const upstreamModel = { ...model, id: upstreamModelId(model), provider: UPSTREAM_PROVIDER, api: API };
      const upstreamOptions = {
        ...options,
        // The upstream openai-codex provider defaults to WebSocket/auto, but only
        // SSE exposes HTTP response headers to onResponse. Default this balanced
        // path to SSE so live usage ingestion cannot silently miss rate-limit
        // headers; preserve an explicit caller transport for debugging/opt-in use.
        transport: options?.transport ?? 'sse',
        apiKey: lease.access_token,
        onResponse: async (response: { status: number; headers: Record<string, string> }, responseModel: Model<typeof API>) => {
          await (options as any)?.onResponse?.(response, responseModel);
          void ingestLiveUsage({ slot: lease.slot, reservation_id: lease.reservation_id, launch_id: lease.launch_id, headers: response.headers }).catch(() => undefined);
        },
      } as SimpleStreamOptions;
      const upstream = streamSimpleOpenAICodexResponses(upstreamModel, context, upstreamOptions);
      try {
        for await (const event of upstream) {
          lastEvent = event;
          const restored = restoreEvent(event, model);
          stream.push(restored);
          if (event.type === 'done' || event.type === 'error') {
            terminalPushed = true;
            break;
          }
        }
      } finally {
        try { await finishOnce(); } catch (finishError) {
          if (!terminalPushed) throw finishError;
          process.stderr.write(`[codex-balanced-provider] lease finish failed after terminal event: ${redactedErrorMessage(finishError)}\n`);
        }
      }
      if (!terminalPushed) stream.end();
    } catch (error) {
      if (finishOnce) {
        try { await finishOnce(); } catch { /* keep original error */ }
      }
      if (terminalPushed) return;
      const message: AssistantMessage = {
        role: 'assistant',
        content: [],
        api: API,
        provider: PROVIDER,
        model: publicModelId(model),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: options?.signal?.aborted ? 'aborted' : 'error',
        errorMessage: redactedErrorMessage(error),
        timestamp: Date.now(),
      };
      stream.push({ type: 'error', reason: message.stopReason === 'aborted' ? 'aborted' : 'error', error: message });
      stream.end(message);
    } finally {
      removeAbortListener?.();
    }
  })();
  return stream;
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
    streamSimple: streamBalanced as any,
    models: getBalancedCodexModels(),
  });
}
