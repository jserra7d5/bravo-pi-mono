#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { getAccessToken } from './credentials.js';
import { buildHeaders } from './headers.js';
import { codeAssistUrl, errorMessageForResponse, resolveCodeAssistProject } from './code-assist-client.js';
import { readSse, extractTextFromSse, type SseEvent } from './sse.js';
import { collectUsageAndCacheMetrics, extractModelContentFromSse, hasThoughtSignature, stripThoughtSignatures, type ModelContent } from './reasoning-continuity.js';

const DEFAULT_MODEL = 'gemini-3-flash-preview';

type EvalResult = { ok: boolean; status?: string; error?: string; text?: string; usageMetadata?: unknown; cacheTokens?: Record<string, unknown> };

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function assertEvalModelAllowed(model: string): void {
  if (process.env.GEMINI_CODE_ASSIST_ALLOW_UNVERIFIED_MODEL === '1' || hasFlag('--allow-unverified')) return;
  throw new Error(`Eval model ${model} is unverified. Set GEMINI_CODE_ASSIST_ALLOW_UNVERIFIED_MODEL=1 or pass --allow-unverified.`);
}

function buildRequest(model: string, project: string | undefined, contents: unknown[]): unknown {
  return {
    model,
    ...(project ? { project } : {}),
    user_prompt_id: randomUUID(),
    request: { contents, generationConfig: {}, session_id: randomUUID() },
  };
}

async function callCodeAssist(accessToken: string, model: string, project: string | undefined, contents: unknown[], timeoutMs: number): Promise<SseEvent[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(codeAssistUrl(), {
      method: 'POST',
      headers: buildHeaders(accessToken, model),
      body: JSON.stringify(buildRequest(model, project, contents)),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(await errorMessageForResponse(response));
    return readSse(response);
  } finally {
    clearTimeout(timeout);
  }
}

async function runTurn2(accessToken: string, model: string, project: string | undefined, history: unknown[], timeoutMs: number): Promise<EvalResult> {
  try {
    const events = await callCodeAssist(accessToken, model, project, history, timeoutMs);
    const text = extractTextFromSse(events);
    const metrics = collectUsageAndCacheMetrics(events);
    return { ok: true, status: text, text, ...metrics };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main(): Promise<void> {
  const model = readArg('--model') ?? DEFAULT_MODEL;
  const timeoutMs = Number(readArg('--timeout-ms') ?? '90000');
  const compareStripped = hasFlag('--compare-stripped');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout-ms must be a positive number.');
  assertEvalModelAllowed(model);

  const nonce = randomUUID();
  const turn1 = { role: 'user', parts: [{ text: `Remember this nonce exactly for the next turn: ${nonce}. Reply briefly that it is stored.` }] };
  const turn2 = { role: 'user', parts: [{ text: 'What is the nonce I asked you to remember? Reply with only the nonce.' }] };

  const accessToken = await getAccessToken(undefined, fetch);
  const project = await resolveCodeAssistProject(accessToken, model, fetch);
  const turn1Events = await callCodeAssist(accessToken, model, project, [turn1], timeoutMs);
  const modelContent = extractModelContentFromSse(turn1Events);
  if (!modelContent) throw new Error('Turn 1 returned no model content.');
  const thoughtSignatureObserved = hasThoughtSignature(modelContent);
  const preservedHistory = [turn1, modelContent, turn2];
  const preserved = await runTurn2(accessToken, model, project, preservedHistory, timeoutMs);
  const strippedModelContent = stripThoughtSignatures(modelContent) as ModelContent;
  const stripped = compareStripped ? await runTurn2(accessToken, model, project, [turn1, strippedModelContent, turn2], timeoutMs) : undefined;

  const turn1Metrics = collectUsageAndCacheMetrics(turn1Events);
  const pass = preserved.ok && typeof preserved.text === 'string' && preserved.text.includes(nonce);
  process.stdout.write(`${JSON.stringify({ pass, nonceMatched: pass, thoughtSignatureObserved, turn1: turn1Metrics, turn2: preserved, ...(stripped ? { strippedComparison: stripped } : {}) })}\n`);
}

main().catch((error: unknown) => {
  console.error(`reasoning-continuity eval failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
