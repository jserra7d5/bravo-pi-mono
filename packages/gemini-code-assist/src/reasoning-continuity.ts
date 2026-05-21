import type { SseEvent } from './sse.js';

export type ModelContent = { role?: string; parts?: unknown[]; [key: string]: unknown };
export type UsageAndCacheMetrics = {
  usageMetadata?: unknown;
  cacheTokens?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseEventData(event: SseEvent): unknown | undefined {
  if (event.data === '[DONE]') return undefined;
  try {
    return JSON.parse(event.data) as unknown;
  } catch {
    return undefined;
  }
}

export function extractModelContentsFromSse(events: SseEvent[]): ModelContent[] {
  const contents: ModelContent[] = [];
  for (const event of events) {
    const value = parseEventData(event);
    if (!isRecord(value)) continue;
    const response = isRecord(value.response) ? value.response : value;
    const candidates = Array.isArray(response.candidates) ? response.candidates : [];
    for (const candidate of candidates) {
      if (!isRecord(candidate) || !isRecord(candidate.content)) continue;
      contents.push({ role: 'model', ...candidate.content });
    }
  }
  return contents;
}

export function extractModelContentFromSse(events: SseEvent[]): ModelContent | undefined {
  const contents = extractModelContentsFromSse(events);
  const parts = contents.flatMap((content) => (Array.isArray(content.parts) ? content.parts : []));
  if (parts.length > 0) return { role: 'model', parts };
  return contents[contents.length - 1];
}

export function hasThoughtSignature(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasThoughtSignature);
  const record = value as Record<string, unknown>;
  if (typeof record.thoughtSignature === 'string' && record.thoughtSignature.length > 0) return true;
  return Object.values(record).some(hasThoughtSignature);
}

export function extractFunctionCallParts(value: unknown): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    if (isRecord(record.functionCall)) parts.push(record);
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return parts;
}

export function hasFunctionCall(value: unknown): boolean {
  return extractFunctionCallParts(value).length > 0;
}

export function hasThoughtSignatureOnFunctionCall(value: unknown): boolean {
  return extractFunctionCallParts(value).some(hasThoughtSignature);
}

export function stripThoughtSignatures<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => stripThoughtSignatures(item)) as T;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'thoughtSignature') continue;
    output[key] = stripThoughtSignatures(child);
  }
  return output as T;
}

export function collectUsageAndCacheMetrics(events: SseEvent[]): UsageAndCacheMetrics {
  let usageMetadata: unknown;
  const cacheTokens: Record<string, unknown> = {};
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    if (isRecord(record.usageMetadata)) usageMetadata = record.usageMetadata;
    for (const [key, value] of Object.entries(record)) {
      if (/cache|cached/i.test(key) && /token/i.test(key)) cacheTokens[key] = value;
      visit(value);
    }
  };
  for (const event of events) visit(parseEventData(event));
  return { usageMetadata, cacheTokens: Object.keys(cacheTokens).length ? cacheTokens : undefined };
}
