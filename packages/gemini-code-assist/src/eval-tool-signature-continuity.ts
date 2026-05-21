#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { getAccessToken } from './credentials.js';
import { buildHeaders } from './headers.js';
import { codeAssistUrl, errorMessageForResponse, resolveCodeAssistProject } from './code-assist-client.js';
import { readSse, extractTextFromSse, type SseEvent } from './sse.js';
import { collectUsageAndCacheMetrics, extractFunctionCallParts, extractModelContentFromSse, hasFunctionCall, hasThoughtSignatureOnFunctionCall, stripThoughtSignatures, type ModelContent } from './reasoning-continuity.js';

const DEFAULT_MODEL = 'gemini-3-flash-preview';
const FUNCTION_NAME = 'record_nonce';

type EvalResult = { ok: boolean; error?: string; text?: string; functionCallObserved?: boolean; thoughtSignatureOnFunctionCall?: boolean; usageMetadata?: unknown; cacheTokens?: Record<string, unknown> };

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

function buildTools(): unknown[] {
  return [{ functionDeclarations: [{ name: FUNCTION_NAME, description: 'Record the exact nonce supplied by the user before answering.', parameters: { type: 'object', properties: { nonce: { type: 'string', description: 'The exact nonce from the user.' } }, required: ['nonce'] } }] }];
}

function buildRequest(model: string, project: string | undefined, contents: unknown[], tools: unknown[] | undefined): unknown {
  return {
    model,
    ...(project ? { project } : {}),
    user_prompt_id: randomUUID(),
    request: { contents, ...(tools ? { tools } : {}), generationConfig: {}, session_id: randomUUID() },
  };
}

async function callCodeAssist(accessToken: string, model: string, project: string | undefined, contents: unknown[], timeoutMs: number, tools?: unknown[]): Promise<SseEvent[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(codeAssistUrl(), {
      method: 'POST',
      headers: buildHeaders(accessToken, model),
      body: JSON.stringify(buildRequest(model, project, contents, tools)),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(await errorMessageForResponse(response));
    return readSse(response);
  } finally {
    clearTimeout(timeout);
  }
}

function firstFunctionResponse(modelContent: ModelContent, nonce: string): unknown {
  const call = extractFunctionCallParts(modelContent)[0]?.functionCall as Record<string, unknown> | undefined;
  return { role: 'user', parts: [{ functionResponse: { name: typeof call?.name === 'string' ? call.name : FUNCTION_NAME, response: { ok: true, nonce } } }] };
}

async function runTurn2(accessToken: string, model: string, project: string | undefined, history: unknown[], timeoutMs: number): Promise<EvalResult> {
  try {
    const events = await callCodeAssist(accessToken, model, project, history, timeoutMs, buildTools());
    const modelContent = extractModelContentFromSse(events);
    return { ok: true, text: extractTextFromSse(events), functionCallObserved: hasFunctionCall(modelContent), thoughtSignatureOnFunctionCall: hasThoughtSignatureOnFunctionCall(modelContent), ...collectUsageAndCacheMetrics(events) };
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
  const turn1 = { role: 'user', parts: [{ text: `Call the ${FUNCTION_NAME} function with this exact nonce before any final answer: ${nonce}` }] };
  const accessToken = await getAccessToken(undefined, fetch);
  const project = await resolveCodeAssistProject(accessToken, model, fetch);
  const turn1Events = await callCodeAssist(accessToken, model, project, [turn1], timeoutMs, buildTools());
  const modelContent = extractModelContentFromSse(turn1Events);
  if (!modelContent) throw new Error('Turn 1 returned no model content.');

  const functionResponse = firstFunctionResponse(modelContent, nonce);
  const turn2 = { role: 'user', parts: [{ text: 'Use the function result and answer with only the nonce.' }] };
  const preserved = await runTurn2(accessToken, model, project, [turn1, modelContent, functionResponse, turn2], timeoutMs);
  const strippedModelContent = stripThoughtSignatures(modelContent) as ModelContent;
  const stripped = compareStripped ? await runTurn2(accessToken, model, project, [turn1, strippedModelContent, functionResponse, turn2], timeoutMs) : undefined;

  const functionCallObserved = hasFunctionCall(modelContent);
  const thoughtSignatureOnFunctionCall = hasThoughtSignatureOnFunctionCall(modelContent);
  const pass = functionCallObserved && thoughtSignatureOnFunctionCall && preserved.ok && typeof preserved.text === 'string' && preserved.text.includes(nonce);
  process.stdout.write(`${JSON.stringify({ pass, functionCallObserved, thoughtSignatureOnFunctionCall, preserved, ...(stripped ? { stripped } : {}), turn1: collectUsageAndCacheMetrics(turn1Events) })}\n`);
}

main().catch((error: unknown) => {
  console.error(`tool-signature-continuity eval failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
