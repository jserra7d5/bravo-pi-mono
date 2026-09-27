import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { estimateContextTokens, estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ensureFreshTokens,
  finishTokenLease,
  ingestLiveUsage,
  listRateLimitCooldowns,
  publishRateLimitCooldown,
  recordCodexAttempt,
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
import { leaseServiceCall } from '../../src/lease-service.js';

const PROVIDER = 'bravo-codex-balanced';
const UPSTREAM_PROVIDER = 'openai-codex';
const API = 'openai-codex-responses' as const;
const DEFAULT_EXPECTED_RUNTIME_MS = 10 * 60_000;
const DEFAULT_TTL_SAFETY_BUFFER_MS = 60_000;

function safeJsonStringify(value: unknown): string {
  try { return JSON.stringify(value) ?? 'undefined'; }
  catch { return '[unserializable]'; }
}

/** Use the installed Pi runtime's message estimate. */
export function estimateBalancedMessageTokens(message: Context['messages'][number]): number {
  return estimateMessageTokens(message);
}

/** Estimate outgoing Context using the installed Pi runtime's accounting. */
export function estimateBalancedContextTokens(context: Context): number {
  const estimate = estimateContextTokens(context.messages);
  if (estimate.lastUsageIndex !== null) return estimate.tokens;
  const systemTokens = context.systemPrompt ? Math.ceil(context.systemPrompt.length / 4) : 0;
  const toolTokens = context.tools?.length ? Math.ceil(safeJsonStringify(context.tools).length / 4) : 0;
  return estimate.tokens + systemTokens + toolTokens;
}

function balancedHardContextLimit(model: Model<typeof API>): number | undefined {
  const contextWindow = model.contextWindow;
  if (model.api !== API || !/^(?:gpt-|codex-)/i.test(upstreamModelId(model))) return undefined;
  return Number.isSafeInteger(contextWindow) && contextWindow > 0 ? contextWindow : undefined;
}

const PI_CODING_AGENT_PACKAGE = '@earendil-works/pi-coding-agent';
const PI_AI_PACKAGE = '@earendil-works/pi-ai';

type PiAiRuntimeModule = {
  createAssistantMessageEventStream?: () => AssistantMessageEventStream;
  getModels?: (provider: string) => Model<typeof API>[];
  streamSimpleOpenAICodexResponses?: (model: Model<typeof API>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
};

function makeId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}
export type HostingPiAiRuntime = {
  packageRoot: string;
  modulePath: string;
  models: Model<typeof API>[];
  createEventStream: () => AssistantMessageEventStream;
  streamSimpleOpenAICodexResponses: NonNullable<PiAiRuntimeModule['streamSimpleOpenAICodexResponses']>;
};
type RuntimeImporter = (specifier: string) => Promise<PiAiRuntimeModule>;
type ModuleResolver = (specifier: string, entrypoint: string) => string;

function packageMetadataAt(directory: string): { name?: string; version?: string } | undefined {
  try {
    const value = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
    return {
      name: typeof value.name === 'string' ? value.name : undefined,
      version: typeof value.version === 'string' ? value.version : undefined,
    };
  } catch {
    return undefined;
  }
}

function packageRootOwning(path: string, expectedName: string): string | undefined {
  if (!existsSync(path)) return undefined;
  let current = dirname(realpathSync(path));
  const root = parse(current).root;
  while (true) {
    if (packageMetadataAt(current)?.name === expectedName) return current;
    if (current === root) return undefined;
    current = dirname(current);
  }
}

/** Find the package owning the real running entrypoint without assuming an npm prefix. */
export function resolveHostingPiPackageRoot(entrypoint = process.argv[1]): string | undefined {
  return entrypoint ? packageRootOwning(entrypoint, PI_CODING_AGENT_PACKAGE) : undefined;
}

function packageExportPath(packageRoot: string, subpath: '.' | './compat'): string | undefined {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    main?: unknown;
    exports?: unknown;
  };
  const selectImport = (value: unknown): string | undefined => {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const conditions = value as Record<string, unknown>;
    return selectImport(conditions.import) ?? selectImport(conditions.default);
  };
  const exports = packageJson.exports;
  const exported = exports && typeof exports === 'object' && !Array.isArray(exports)
    ? selectImport((exports as Record<string, unknown>)[subpath])
    : subpath === '.' ? selectImport(exports) : undefined;
  const relativePath = exported ?? (subpath === '.' && typeof packageJson.main === 'string' ? packageJson.main : undefined);
  if (!relativePath) return undefined;
  const resolved = join(packageRoot, relativePath);
  return existsSync(resolved) ? realpathSync(resolved) : undefined;
}

function dependencyPackageRootFromHost(hostRoot: string): string | undefined {
  let current = hostRoot;
  const root = parse(current).root;
  while (true) {
    const candidate = join(current, 'node_modules', '@earendil-works', 'pi-ai');
    if (packageMetadataAt(candidate)?.name === PI_AI_PACKAGE) return realpathSync(candidate);
    if (current === root) return undefined;
    current = dirname(current);
  }
}

function defaultModuleResolver(specifier: string, entrypoint: string): string {
  const hostRoot = resolveHostingPiPackageRoot(entrypoint);
  const packageRoot = hostRoot ? dependencyPackageRootFromHost(hostRoot) : undefined;
  if (!packageRoot) throw new Error(`${PI_AI_PACKAGE} is absent from the hosting Pi package graph`);
  const subpath = specifier === `${PI_AI_PACKAGE}/compat` ? './compat' : '.';
  const resolved = packageExportPath(packageRoot, subpath);
  if (!resolved) throw new Error(`${specifier} has no loadable public import export`);
  return resolved;
}

function isPiAiCompatVersion(version: string | undefined): boolean {
  const match = /^(\d+)\.(\d+)/.exec(version ?? '');
  return !!match && (Number(match[1]) > 0 || Number(match[2]) >= 80);
}

/**
 * Resolve and load pi-ai from the package graph of the Pi CLI that is actually
 * hosting this extension. This handles nested and npm-hoisted dependencies as
 * well as local/global bin symlinks and npx installs because resolution starts
 * at the real CLI entrypoint rather than this extension's package.
 *
 * Pi 0.80+ moved the legacy catalog/stream API to the public `compat` export;
 * older Pi exposes the same API from the package root. Both the catalog and
 * streamer are intentionally read from that one selected module. A recognized
 * Pi host fails closed if either half is unavailable.
 */
export async function loadHostingPiAiRuntime(options: {
  entrypoint?: string;
  importModule?: RuntimeImporter;
  resolveModule?: ModuleResolver;
  localModule?: PiAiRuntimeModule;
  localModulePath?: string;
} = {}): Promise<HostingPiAiRuntime> {
  const entrypoint = options.entrypoint ?? process.argv[1];
  const hostRoot = resolveHostingPiPackageRoot(entrypoint);
  const importer = options.importModule ?? ((specifier) => import(specifier));

  let packageRoot: string;
  let modulePath: string;
  let runtime: PiAiRuntimeModule;
  if (!hostRoot) {
    // The compat gate applies here too. Without a hosting Pi (tests, direct
    // library use) the package root is resolved locally, and on pi-ai 0.80+ the
    // root export no longer carries the catalog/streamer — so resolving '.' the
    // way pre-0.80 did fails closed on an otherwise healthy install.
    let localSpecifier = options.localModulePath ?? import.meta.resolve(PI_AI_PACKAGE);
    if (!options.localModulePath) {
      const rootPath = localSpecifier.startsWith('file:') ? fileURLToPath(localSpecifier) : localSpecifier;
      const localRoot = packageRootOwning(rootPath, PI_AI_PACKAGE);
      if (localRoot && isPiAiCompatVersion(packageMetadataAt(localRoot)?.version)) {
        localSpecifier = import.meta.resolve(`${PI_AI_PACKAGE}/compat`);
      }
    }
    modulePath = localSpecifier;
    runtime = options.localModule ?? await importer(modulePath);
    const localPath = modulePath.startsWith('file:') ? fileURLToPath(modulePath) : modulePath;
    packageRoot = packageRootOwning(localPath, PI_AI_PACKAGE) ?? dirname(localPath);
  } else {
    if (!entrypoint) throw new Error('hosting Pi entrypoint is unavailable');
    const resolver = options.resolveModule ?? defaultModuleResolver;
    let rootEntry: string;
    try {
      rootEntry = resolver(PI_AI_PACKAGE, entrypoint);
    } catch (error) {
      throw new Error(`hosting Pi installation cannot resolve ${PI_AI_PACKAGE} from ${realpathSync(entrypoint)}: ${String(error)}`);
    }
    packageRoot = packageRootOwning(rootEntry, PI_AI_PACKAGE) ?? '';
    if (!packageRoot) throw new Error(`resolved hosting Pi module is not owned by ${PI_AI_PACKAGE}: ${rootEntry}`);
    const metadata = packageMetadataAt(packageRoot);
    try {
      modulePath = isPiAiCompatVersion(metadata?.version) ? resolver(`${PI_AI_PACKAGE}/compat`, entrypoint) : rootEntry;
    } catch (error) {
      throw new Error(`hosting Pi ${metadata?.version ?? 'unknown'} runtime export cannot be resolved: ${String(error)}`);
    }
    if (packageRootOwning(modulePath, PI_AI_PACKAGE) !== packageRoot) {
      throw new Error(`hosting Pi catalog and streamer did not resolve from one ${PI_AI_PACKAGE} package: ${modulePath}`);
    }
    runtime = await importer(pathToFileURL(modulePath).href);
  }

  if (typeof runtime.getModels !== 'function' || typeof runtime.streamSimpleOpenAICodexResponses !== 'function') {
    throw new Error(`selected ${PI_AI_PACKAGE} runtime does not provide both the Codex catalog and streamer: ${modulePath}`);
  }
  if (typeof runtime.createAssistantMessageEventStream !== 'function') {
    throw new Error(`selected ${PI_AI_PACKAGE} runtime has no assistant event stream implementation: ${modulePath}`);
  }
  const models = runtime.getModels(UPSTREAM_PROVIDER);
  if (!Array.isArray(models)) throw new Error(`selected ${PI_AI_PACKAGE} runtime returned an invalid Codex catalog: ${modulePath}`);
  return {
    packageRoot,
    modulePath,
    models,
    createEventStream: runtime.createAssistantMessageEventStream,
    streamSimpleOpenAICodexResponses: runtime.streamSimpleOpenAICodexResponses,
  };
}

/** Backward-compatible test seam for callers that only need the selected catalog. */
export async function loadOpenAICodexCatalog(options: Parameters<typeof loadHostingPiAiRuntime>[0] = {}): Promise<Model<typeof API>[]> {
  return (await loadHostingPiAiRuntime(options)).models;
}

const hostingPiAiRuntime = await loadHostingPiAiRuntime();
const hostingOpenAICodexCatalog = hostingPiAiRuntime.models;

function publicModelId(model: Model<typeof API>): string {
  return model.id.startsWith(`${PROVIDER}/`) ? model.id : `${PROVIDER}/${model.id}`;
}

function upstreamModelId(model: Model<typeof API>): string {
  return model.id.startsWith(`${PROVIDER}/`) ? model.id.slice(PROVIDER.length + 1) : model.id;
}

function publicModel(model: Model<typeof API>): Model<typeof API> {
  const balanced = { ...model, id: publicModelId(model), provider: PROVIDER, api: API };
  if (upstreamModelId(model) !== 'gpt-6-luna') return balanced;
  return {
    ...balanced,
    thinkingLevelMap: { ...model.thinkingLevelMap, max: 'max' },
  };
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

function normalizedOutboundContext(model: Model<typeof API>, context: Context): Context {
  const publicId = publicModelId(model);
  const nativeId = upstreamModelId(model);
  return {
    ...context,
    messages: context.messages.map(message => {
      if (message.role !== 'assistant') return message;
      if (message.api !== API || message.provider !== PROVIDER || message.model !== publicId) return message;
      return { ...message, provider: UPSTREAM_PROVIDER, model: nativeId };
    }),
  };
}

function redactedErrorMessage(error: unknown): string {
  return redactSecretsInText(error instanceof Error ? error.message : String(error));
}

function errorTextOfEvent(event: AssistantMessageEvent | undefined): string | undefined {
  return event?.type === 'error' ? (event.error.errorMessage ?? undefined) : undefined;
}

// Narrow matcher: the leased token was rejected as unusable by the upstream
// account itself — not a rate limit, not a caller-side bug. Two known shapes:
//   1. "Failed to extract accountId from token" — our own extension lost its
//      provider-api override and a placeholder/foreign token reached upstream.
//   2. "Incorrect API key provided: sk-...` — chatgpt.com's backend rejected a
//      genuine ChatGPT OAuth Bearer token by citing an unrelated, revoked
//      classic-API service-account key it has on file for that account. This
//      is an OpenAI-side account fault, but it is the SAME "this slot's
//      credential is broken" condition: quarantine the slot and rotate rather
//      than surfacing it as a generic, non-rotatable error.
// Deliberately does NOT match generic errors. Rate-limits are already
// classified earlier via classifyRateLimit.
function isAuthRejection(text: string | undefined): boolean {
  return !!text && (/failed to extract accountid/i.test(text) || /incorrect api key provided/i.test(text));
}

// ── Dependency seam (real I/O injected here; tests pass fakes) ───────────────

export type BalancedRunnerDeps = {
  startLease: (input: StartTokenLeaseInput) => Promise<TokenLease>;
  finishLease: (input: FinishTokenLeaseInput) => Promise<unknown>;
  listSlots: (stateRoot?: string) => Promise<SlotInfo[]>;
  createUpstream: (model: Model<typeof API>, context: Context, options: SimpleStreamOptions) => AsyncIterable<AssistantMessageEvent>;
  ingestUsage: (input: LiveUsageIngestInput) => Promise<unknown>;
  markBroken: (slot: string, code: string, message: string) => void;
  publishCooldown: (input: { slot: string; sourceAttemptId?: string; reason?: string; expiresAt: number }) => unknown;
  recordAttempt: typeof recordCodexAttempt;
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
  if (process.env.CODEX_AUTH_BALANCER_URL) return {
    // The AbortSignal cannot cross the wire (JSON makes it {}); it aborts the HTTP call instead.
    startLease: ({ abort_signal, ...input }) => leaseServiceCall('startLease', input, abort_signal),
    finishLease: input => leaseServiceCall('finishLease', input),
    listSlots: () => leaseServiceCall('listSlots'),
    createUpstream: (model, context, options) => hostingPiAiRuntime.streamSimpleOpenAICodexResponses(model, context, options),
    ingestUsage: input => leaseServiceCall('ingestUsage', input),
    markBroken: (slot, code, message) => { void leaseServiceCall('markBroken', { slot, code, message }).catch(error => process.stderr.write(`[codex-balanced-provider] broken snapshot failed: ${redactedErrorMessage(error)}\n`)); },
    publishCooldown: input => leaseServiceCall('publishCooldown', input),
    recordAttempt: (input => { void leaseServiceCall('recordAttempt', input).catch(error => process.stderr.write(`[codex-balanced-provider] attempt telemetry failed: ${redactedErrorMessage(error)}\n`)); return undefined as never; }) as typeof recordCodexAttempt,
    cooldown: sharedCooldown, config: DEFAULT_ROTATION_CONFIG, sleep: realSleep, rand: Math.random, now: Date.now,
  };
  return {
    startLease: startTokenLease,
    finishLease: finishTokenLease,
    listSlots: async (stateRoot?: string) => {
      const root = stateRoot || resolveStateRoot();
      const cooldowns = new Map(listRateLimitCooldowns({ stateRoot: root }).map(c => [c.slot, c.expiresAt]));
      return (await loadAccounts(root)).map(a => ({ slot: a.slot, primaryRemaining: a.usage?.primary?.remainingPercent, cooldownUntil: cooldowns.get(a.slot) }));
    },
    createUpstream: (model, context, options) => hostingPiAiRuntime.streamSimpleOpenAICodexResponses(model, context, options),
    ingestUsage: ingestLiveUsage,
    markBroken: (slot, code, message) => { try { writeBrokenSnapshot(resolveStateRoot(), slot, code, message); } catch { /* ignore */ } },
    publishCooldown: (input) => publishRateLimitCooldown({ stateRoot: resolveStateRoot(), ...input }),
    recordAttempt: recordCodexAttempt,
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
    const stream = hostingPiAiRuntime.createEventStream();
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
  const requestId = makeId('codex_req');
  const recordAttempt = (input: Parameters<typeof recordCodexAttempt>[0]) => {
    try {
      deps.recordAttempt(input);
    } catch (error) {
      process.stderr.write(`[codex-balanced-provider] attempt telemetry failed: ${redactedErrorMessage(error)}\n`);
    }
  };
  const publishCooldown = async (input: { slot: string; sourceAttemptId?: string; reason?: string; expiresAt: number }) => {
    try {
      await deps.publishCooldown(input);
    } catch (error) {
      process.stderr.write(`[codex-balanced-provider] cooldown publication failed: ${redactedErrorMessage(error)}\n`);
    }
  };
  const requestedTransport = options?.transport;
  const degradedToSse = requestedTransport === 'auto' || requestedTransport === 'websocket' || requestedTransport === 'websocket-cached';
  if (degradedToSse) {
    recordAttempt({
      stateRoot: deps.stateRoot,
      attempt_id: makeId('codex_attempt'),
      request_id: requestId,
      session_hash: undefined,
      public_model_id: publicModelId(model),
      phase: 'admission',
      outcome: 'degraded_transport_selected',
      reason_code: 'balanced_websocket_requires_account_aware_pi_cache_seam',
      transport_mode: 'sse',
      transport_policy_version: 'codex-balanced-sse-until-account-aware-websocket',
      evidence_codes: ['degraded_transport_recorded', 'transport_policy_recorded', 'global_auth_fallback_blocked'],
      duration_ms: 0,
    });
  }

  const hardLimit = balancedHardContextLimit(model);
  const estimatedContextTokens = hardLimit === undefined ? 0 : estimateBalancedContextTokens(context);
  if (hardLimit !== undefined && estimatedContextTokens > hardLimit) {
    pushedTerminal = true;
    stream.push({
      type: 'error',
      reason: 'error',
      error: {
        role: 'assistant',
        content: [],
        api: API,
        provider: PROVIDER,
        model: publicModelId(model),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'error',
        errorMessage: `context_length_exceeded: estimated context ${estimatedContextTokens} tokens exceeds the configured ${hardLimit}-token context window`,
        timestamp: deps.now(),
      },
    });
    return;
  }

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
    const attemptId = makeId('codex_attempt');
    const startedAt = deps.now();
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
        run_id: process.env.ASYNC_SUBAGENTS_RUN_ID ?? process.env.ASYNC_SUBAGENT_RUN_ID,
        root_run_id: process.env.ASYNC_SUBAGENTS_PARENT_RUN_ID ?? process.env.ASYNC_SUBAGENTS_ROOT_SESSION_ID,
        abort_signal: signal,
      });
    } catch (leaseError) {
      recordAttempt({
        stateRoot: deps.stateRoot,
        attempt_id: attemptId,
        request_id: requestId,
        session_hash: undefined,
        public_model_id: publicModelId(model),
        phase: 'credential',
        outcome: 'credential_unavailable',
        reason_code: 'token_lease_failed',
        error_code: redactedErrorMessage(leaseError),
        evidence_codes: ['credential_unusable_before_wire', 'no_application_bytes_written', 'global_auth_fallback_blocked'],
        duration_ms: Math.max(0, deps.now() - startedAt),
      });
      if (signal?.aborted) { forwardError(new Error('Request was aborted'), true); return { outcome: 'aborted', slot: forcedSlot ?? '(none)' }; }
      // A lease failure (forced slot rejected, OR the round-0 auto-selected slot is
      // broken) should not abort the whole turn — record the real error and let
      // rotation move on to the remaining accounts. The error is surfaced by
      // onExhausted only if every slot fails to lease.
      lastLeaseError = leaseError;
      return { outcome: 'lease-failed', slot: forcedSlot ?? '(none)' };
    }

    if (lease.affinity_outcome) {
      recordAttempt({
        stateRoot: deps.stateRoot,
        attempt_id: makeId('codex_attempt'),
        request_id: requestId,
        parent_attempt_id: attemptId,
        reservation_id: lease.reservation_id,
        launch_id: lease.launch_id,
        session_hash: lease.session_hash,
        public_model_id: publicModelId(model),
        slot_id: lease.slot,
        account_hash: lease.account_id_hash,
        affinity_generation: lease.affinity_generation,
        phase: 'selection',
        outcome: lease.affinity_outcome,
        reason_code: lease.affinity_outcome,
        transport_policy_version: 'codex-balanced-sse-until-account-aware-websocket',
        evidence_codes: [
          lease.affinity_outcome === 'fresh_placed' ? 'affinity_published_before_async_work' : 'affinity_read_before_selection',
          ...(lease.affinity_generation !== undefined ? ['affinity_generation_matched' as const] : []),
          'selected_slot_credential_used',
        ],
        duration_ms: 0,
      });
    }

    let finishPromise: Promise<void> | undefined;
    const finishLease = (status: TokenLeaseFinishStatus): Promise<void> => {
      if (finishPromise) return finishPromise;
      if (activeFinish === abortFinish) activeFinish = undefined;
      finishPromise = (async () => {
        try {
          await deps.finishLease({ lease_id: lease.lease_id, reservation_id: lease.reservation_id, launch_id: lease.launch_id, status });
        } catch (finishError) {
          process.stderr.write(`[codex-balanced-provider] lease finish failed: ${redactedErrorMessage(finishError)}\n`);
        }
      })();
      return finishPromise;
    };
    const abortFinish = () => finishLease('aborted');
    activeFinish = abortFinish;

    if (signal?.aborted) { await finishLease('aborted'); forwardError(new Error('Request was aborted'), true); return { outcome: 'aborted', slot: lease.slot }; }
    if (!lease.access_token || lease.access_token.trim().length < 8) {
      await finishLease('failed');
      recordAttempt({
        stateRoot: deps.stateRoot,
        attempt_id: attemptId,
        request_id: requestId,
        reservation_id: lease.reservation_id,
        launch_id: lease.launch_id,
        session_hash: lease.session_hash,
        public_model_id: publicModelId(model),
        slot_id: lease.slot,
        account_hash: lease.account_id_hash,
        affinity_generation: lease.affinity_generation,
        phase: 'credential',
        outcome: 'auth_unusable',
        reason_code: 'empty_access_token',
        evidence_codes: ['credential_unusable_before_wire', 'no_application_bytes_written', 'global_auth_fallback_blocked'],
        duration_ms: Math.max(0, deps.now() - startedAt),
      });
      forwardError(new Error('Codex balanced provider refused empty access token'));
      return { outcome: 'other-error', slot: lease.slot };
    }

    let sawRateLimitStatus = false;
    let upstreamStatus: number | undefined;
    let responseHeadersReceived = false;
    const slotAbort = new AbortController();
    const upstreamSignal = signal ? AbortSignal.any([signal, slotAbort.signal]) : slotAbort.signal;
    const upstreamModel = { ...model, id: upstreamModelId(model), provider: UPSTREAM_PROVIDER, api: API };
    const upstreamOptions = {
      ...options,
      // Only SSE exposes HTTP response headers to onResponse; default the balanced
      // path to SSE so live usage ingestion and 429 detection cannot silently miss
      // rate-limit headers. Preserve an explicit caller transport for opt-in use.
      transport: 'sse',
      apiKey: lease.access_token,
      signal: upstreamSignal,
      // One leased slot gets one wire attempt. Newer host streamers honor this;
      // aborting on the first 429 also stops retry loops in older host versions.
      maxRetries: 0,
      onResponse: (response: { status: number; headers: Record<string, string> }, responseModel: Model<typeof API>) => {
        upstreamStatus = response.status;
        responseHeadersReceived = true;
        // This callback is inside host streamer retry logic. Establish the slot
        // state and abort that streamer's local signal before invoking any
        // caller code, so a throwing/slow observer cannot permit another wire
        // request on the same lease.
        if (response.status === 429) {
          sawRateLimitStatus = true;
          slotAbort.abort();
        }
        const observe = (label: string, action: () => unknown) => {
          void Promise.resolve().then(action).catch((error) => {
            process.stderr.write(`[codex-balanced-provider] ${label} failed: ${redactedErrorMessage(error)}\n`);
          });
        };
        observe('usage ingestion', () => deps.ingestUsage({
          slot: lease.slot,
          reservation_id: lease.reservation_id,
          launch_id: lease.launch_id,
          headers: response.headers,
        }));
        const callerOnResponse = (options as any)?.onResponse;
        if (typeof callerOnResponse === 'function') {
          observe('caller onResponse', () => callerOnResponse(response, responseModel));
        }
      },
    } as SimpleStreamOptions;

    let contentPushed = false;
    let terminalError: AssistantMessageEvent | undefined;
    try {
      const outboundContext = normalizedOutboundContext(model, context);
      for await (const event of deps.createUpstream(upstreamModel, outboundContext, upstreamOptions)) {
        if (signal?.aborted) break; // stop forwarding content/done once the caller aborted
        if ('partial' in event) lastUpstreamPartial = event.partial;
        if (event.type === 'done') {
          await finishLease('completed');
          recordAttempt({
            stateRoot: deps.stateRoot,
            attempt_id: attemptId,
            request_id: requestId,
            reservation_id: lease.reservation_id,
            launch_id: lease.launch_id,
            session_hash: lease.session_hash,
            public_model_id: publicModelId(model),
            slot_id: lease.slot,
            account_hash: lease.account_id_hash,
            affinity_generation: lease.affinity_generation,
            phase: 'terminal',
            outcome: 'completed',
            reason_code: 'upstream_done',
            transport_mode: 'sse',
            transport_policy_version: 'codex-balanced-sse-until-account-aware-websocket',
            upstream_status: upstreamStatus,
            response_headers_received: responseHeadersReceived,
            wire_started: true,
            content_started: contentPushed,
            evidence_codes: ['selected_slot_credential_used', 'account_connection_attributed', 'terminal_outcome_recorded', 'transport_policy_recorded'],
            duration_ms: Math.max(0, deps.now() - startedAt),
          });
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

    const aborted = signal?.aborted === true || (!sawRateLimitStatus && terminalError?.type === 'error' && terminalError.reason === 'aborted');
    if (aborted) {
      await finishLease('aborted');
      recordAttempt({
        stateRoot: deps.stateRoot,
        attempt_id: attemptId,
        request_id: requestId,
        reservation_id: lease.reservation_id,
        launch_id: lease.launch_id,
        session_hash: lease.session_hash,
        public_model_id: publicModelId(model),
        slot_id: lease.slot,
        account_hash: lease.account_id_hash,
        affinity_generation: lease.affinity_generation,
        phase: 'terminal',
        outcome: 'aborted',
        reason_code: 'caller_aborted',
        transport_mode: 'sse',
        transport_policy_version: 'codex-balanced-sse-until-account-aware-websocket',
        upstream_status: upstreamStatus,
        response_headers_received: responseHeadersReceived,
        wire_started: responseHeadersReceived || contentPushed,
        content_started: contentPushed,
        evidence_codes: ['terminal_outcome_recorded', ...(contentPushed ? ['content_started_observed' as const] : ['content_not_started' as const])],
        duration_ms: Math.max(0, deps.now() - startedAt),
      });
      forwardTerminal(terminalError ?? { type: 'error', reason: 'aborted', error: buildErrorMessage(new Error('Request was aborted'), true) });
      return { outcome: 'aborted', slot: lease.slot };
    }

    const rateLimited = !contentPushed && sawRateLimitStatus && classifyRateLimit({ status: 429, errorText: errorTextOfEvent(terminalError) });
    await finishLease('failed');

    if (rateLimited && !contentPushed) {
      const cooldownUntil = deps.now() + deps.config.cooldownMs;
      await publishCooldown({ slot: lease.slot, sourceAttemptId: attemptId, reason: 'rate_limited_pre_content', expiresAt: cooldownUntil });
      recordAttempt({
        stateRoot: deps.stateRoot,
        attempt_id: attemptId,
        request_id: requestId,
        reservation_id: lease.reservation_id,
        launch_id: lease.launch_id,
        session_hash: lease.session_hash,
        public_model_id: publicModelId(model),
        slot_id: lease.slot,
        account_hash: lease.account_id_hash,
        affinity_generation: lease.affinity_generation,
        phase: 'headers',
        outcome: 'rate_limited_pre_content',
        reason_code: 'explicit_429_or_rate_limit',
        transport_mode: 'sse',
        transport_policy_version: 'codex-balanced-sse-until-account-aware-websocket',
        upstream_status: sawRateLimitStatus ? 429 : upstreamStatus,
        response_headers_received: responseHeadersReceived || sawRateLimitStatus,
        wire_started: true,
        content_started: false,
        retry_eligible: false,
        rotation_eligible: true,
        evidence_codes: ['explicit_429_rejection', 'content_not_started', 'response_headers_received', 'rate_limit_cooldown_recorded', 'rotation_recorded'],
        duration_ms: Math.max(0, deps.now() - startedAt),
      });
      recordAttempt({
        stateRoot: deps.stateRoot,
        attempt_id: makeId('codex_attempt'),
        request_id: requestId,
        parent_attempt_id: attemptId,
        reservation_id: lease.reservation_id,
        launch_id: lease.launch_id,
        session_hash: lease.session_hash,
        public_model_id: publicModelId(model),
        slot_id: lease.slot,
        account_hash: lease.account_id_hash,
        affinity_generation: lease.affinity_generation,
        phase: 'terminal',
        outcome: 'rotated_pre_content',
        reason_code: 'rate_limit_cooldown_published',
        transport_mode: 'sse',
        transport_policy_version: 'codex-balanced-sse-until-account-aware-websocket',
        evidence_codes: ['rotation_recorded', 'content_not_started', 'rate_limit_cooldown_recorded'],
        duration_ms: 0,
      });
      lastSuppressedError = terminalError;
      return { outcome: 'rate-limited', slot: lease.slot };
    }
    // Upstream rejected the leased token (e.g. couldn't extract a chatgpt_account_id).
    // Quarantine the slot broken and rotate to another slot instead of surfacing it.
    // finishLease('failed') already ran above (idempotent), so do not re-call it.
    if (!contentPushed && !rateLimited && isAuthRejection(errorTextOfEvent(terminalError))) {
      deps.markBroken(lease.slot, 'upstream_no_accountid', redactedErrorMessage(errorTextOfEvent(terminalError) ?? 'upstream could not extract accountId'));
      recordAttempt({
        stateRoot: deps.stateRoot,
        attempt_id: attemptId,
        request_id: requestId,
        reservation_id: lease.reservation_id,
        launch_id: lease.launch_id,
        session_hash: lease.session_hash,
        public_model_id: publicModelId(model),
        slot_id: lease.slot,
        account_hash: lease.account_id_hash,
        affinity_generation: lease.affinity_generation,
        phase: 'headers',
        outcome: 'auth_unusable',
        reason_code: 'upstream_no_accountid',
        transport_mode: 'sse',
        transport_policy_version: 'codex-balanced-sse-until-account-aware-websocket',
        upstream_status: upstreamStatus,
        response_headers_received: responseHeadersReceived,
        wire_started: true,
        content_started: false,
        rotation_eligible: true,
        evidence_codes: ['auth_rejected_before_content', 'content_not_started', 'rotation_recorded'],
        duration_ms: Math.max(0, deps.now() - startedAt),
      });
      lastAuthError = terminalError;
      return { outcome: 'auth-rejected', slot: lease.slot };
    }
    if (contentPushed) {
      recordAttempt({
        stateRoot: deps.stateRoot,
        attempt_id: attemptId,
        request_id: requestId,
        reservation_id: lease.reservation_id,
        launch_id: lease.launch_id,
        session_hash: lease.session_hash,
        public_model_id: publicModelId(model),
        slot_id: lease.slot,
        account_hash: lease.account_id_hash,
        affinity_generation: lease.affinity_generation,
        phase: 'terminal',
        outcome: 'terminal_failure',
        reason_code: 'streamed_error',
        transport_mode: 'sse',
        transport_policy_version: 'codex-balanced-sse-until-account-aware-websocket',
        upstream_status: upstreamStatus,
        response_headers_received: responseHeadersReceived,
        wire_started: true,
        content_started: true,
        retry_eligible: false,
        rotation_eligible: false,
        evidence_codes: ['content_started_observed', 'terminal_outcome_recorded'],
        duration_ms: Math.max(0, deps.now() - startedAt),
      });
      if (terminalError) forwardTerminal(terminalError);
      return { outcome: 'streamed-error', slot: lease.slot };
    }
    recordAttempt({
      stateRoot: deps.stateRoot,
      attempt_id: attemptId,
      request_id: requestId,
      reservation_id: lease.reservation_id,
      launch_id: lease.launch_id,
      session_hash: lease.session_hash,
      public_model_id: publicModelId(model),
      slot_id: lease.slot,
      account_hash: lease.account_id_hash,
      affinity_generation: lease.affinity_generation,
      phase: 'terminal',
      outcome: 'terminal_failure',
      reason_code: 'pre_content_non_rate_error',
      transport_mode: 'sse',
      transport_policy_version: 'codex-balanced-sse-until-account-aware-websocket',
      upstream_status: upstreamStatus,
      response_headers_received: responseHeadersReceived,
      // No headers is not proof of "before wire"; the upstream streamer may have
      // written request bytes and failed before surfacing headers. Treat this as
      // non-replayable and do not authorize rotation.
      wire_started: true,
      content_started: false,
      retry_eligible: false,
      rotation_eligible: false,
      evidence_codes: ['content_not_started', 'terminal_outcome_recorded'],
      duration_ms: Math.max(0, deps.now() - startedAt),
    });
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

/**
 * Re-badge the upstream Codex catalog under this provider. Context metadata is passed
 * through as upstream reports it (272k for the GPT-5.6 family) — the balancer no longer
 * opts these models into the extended window.
 */
export function mapBalancedCodexModels(models: Model<typeof API>[]): Model<typeof API>[] {
  return models.map(publicModel);
}

export function getBalancedCodexModels(models: Model<typeof API>[] = hostingOpenAICodexCatalog): Model<typeof API>[] {
  return mapBalancedCodexModels(models);
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

/**
 * Refresh credentials well before anything needs them.
 *
 * Left alone, the only thing that ever refreshes a slot is a lease that has
 * already run out of runway — so a refresh path that has broken stays invisible
 * until the access token dies, and the first symptom is a hard outage. Doing it
 * from session start instead means a broken refresh surfaces days early, while
 * the current token still works.
 *
 * Fire-and-forget by construction: ensureFreshTokens reports failures rather
 * than throwing, holds the same per-slot lock the lease path uses, and skips
 * slots it refreshed (or failed on) recently, so concurrent pi sessions cannot
 * stampede the token endpoint.
 */
async function topUpTokens(): Promise<void> {
  try {
    if (process.env.CODEX_AUTH_BALANCER_URL) return;
    const outcomes = await ensureFreshTokens();
    for (const outcome of outcomes) {
      if (outcome.action === 'failed') {
        process.stderr.write(`[codex-balancer] proactive refresh failed slot=${outcome.slot} kind=${outcome.errorKind}: ${outcome.error}\n`);
      }
    }
  } catch (error) {
    process.stderr.write(`[codex-balancer] proactive refresh skipped: ${redactSecretsInText(error instanceof Error ? error.message : String(error))}\n`);
  }
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
  pi.on('session_start', () => { registerBalancedProvider(pi); void topUpTokens(); });
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
