import assert from 'node:assert/strict';
import test from 'node:test';
import { isAccessTokenFresh } from '../src/credentials.js';
import { buildHeaders, buildUserAgent, parseCustomHeaders } from '../src/headers.js';
import { extractTextFromSse, parseSseEvents } from '../src/sse.js';
import { assertSupportedSpikeModel, buildTextOnlyRequest, codeAssistUrl } from '../src/code-assist-client.js';
import { collectUsageAndCacheMetrics, extractFunctionCallParts, extractModelContentFromSse, extractModelContentsFromSse, hasFunctionCall, hasThoughtSignature, hasThoughtSignatureOnFunctionCall, stripThoughtSignatures } from '../src/reasoning-continuity.js';

test('parseCustomHeaders follows Gemini CLI semantics', () => {
  assert.deepEqual(parseCustomHeaders(' A: one , nope, B: two:three, Empty: , A: later, C: x,y '), {
    A: 'later',
    B: 'two:three',
    Empty: '',
    C: 'x,y',
  });
  assert.deepEqual(parseCustomHeaders('NoColon, : bad, X-Flag:, X-List: a,b,c, X-Url: https://x.test/a:b'), {
    'X-Flag': '',
    'X-List': 'a,b,c',
    'X-Url': 'https://x.test/a:b',
  });
});

test('buildHeaders preserves Gemini CLI precedence except protected Authorization and User-Agent', () => {
  const headers = buildHeaders('token', 'gemini-3.5-flash', 'content-type: custom/type, user-agent: Bad, authorization: Bad, X-Test: ok');
  assert.equal(headers['Content-Type'], 'custom/type');
  assert.match(headers['User-Agent'], /^GeminiCLI\//);
  assert.equal(headers.Authorization, 'Bearer token');
  assert.equal(headers['X-Test'], 'ok');
  const normalized = new Headers(headers);
  assert.equal(normalized.get('authorization'), 'Bearer token');
  assert.match(normalized.get('user-agent') ?? '', /^GeminiCLI\//);
});

test('buildUserAgent uses override version and model', () => {
  const ua = buildUserAgent('gemini-test', { GEMINI_CODE_ASSIST_USER_AGENT_VERSION: '1.2.3' });
  assert.match(ua, /^GeminiCLI\/1\.2\.3\/gemini-test \(.+; .+\)$/);
});

test('isAccessTokenFresh requires token and more than refresh skew', () => {
  assert.equal(isAccessTokenFresh({ access_token: 'x', expiry_date: 1_000_000 }, 100), true);
  assert.equal(isAccessTokenFresh({ access_token: 'x', expiry_date: 1_000 }, 100), false);
  assert.equal(isAccessTokenFresh({ expiry_date: 1_000_000 }, 100), false);
});

test('SSE parser extracts wrapped Code Assist candidate text parts', () => {
  const events = parseSseEvents('event: result\ndata: {"traceId":"t","response":{"candidates":[{"content":{"parts":[{"text":"hi"},{"text":" there"}]}}]}}\n\ndata: [DONE]\n\n');
  assert.equal(extractTextFromSse(events), 'hi there');
});

test('codeAssistUrl creates v1internal SSE method URL', () => {
  assert.equal(codeAssistUrl({}), 'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse');
});

test('buildTextOnlyRequest creates Code Assist text-only envelope', () => {
  const request = buildTextOnlyRequest('hello', 'm', { GOOGLE_CLOUD_PROJECT: 'project-1' }) as {
    model: string;
    project?: string;
    user_prompt_id?: string;
    request?: { contents?: unknown; generationConfig?: unknown; session_id?: string };
  };
  assert.equal(request.model, 'm');
  assert.equal(request.project, 'project-1');
  assert.equal(typeof request.user_prompt_id, 'string');
  assert.equal(typeof request.request?.session_id, 'string');
  assert.deepEqual(request.request?.contents, [{ role: 'user', parts: [{ text: 'hello' }] }]);
  assert.deepEqual(request.request?.generationConfig, {});
});

test('assertSupportedSpikeModel rejects unverified models unless explicit diagnostic override is set', () => {
  assert.doesNotThrow(() => assertSupportedSpikeModel('gemini-3.5-flash', {}));
  assert.throws(() => assertSupportedSpikeModel('gemini-3-flash-preview', {}), /Unsupported spike model/);
  assert.doesNotThrow(() => assertSupportedSpikeModel('gemini-3-flash-preview', { GEMINI_CODE_ASSIST_ALLOW_UNVERIFIED_MODEL: '1' }));
});

test('reasoning continuity helpers preserve raw model parts and thought signatures', () => {
  const events = parseSseEvents('data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"hidden","thoughtSignature":"sig-1"},{"text":" visible"}]}}],"usageMetadata":{"promptTokenCount":1,"cachedContentTokenCount":2}}}\n\ndata: {"response":{"candidates":[{"content":{"parts":[{"text":" more","thoughtSignature":"sig-2"}]}}]}}\n\n');
  const contents = extractModelContentsFromSse(events);
  assert.equal(contents.length, 2);
  assert.deepEqual(extractModelContentFromSse(events), {
    role: 'model',
    parts: [{ text: 'hidden', thoughtSignature: 'sig-1' }, { text: ' visible' }, { text: ' more', thoughtSignature: 'sig-2' }],
  });
  assert.equal(hasThoughtSignature(contents), true);
});

test('reasoning continuity helpers detect function calls and signatures on function call parts', () => {
  const content = { role: 'model', parts: [{ functionCall: { name: 'record_nonce', args: { nonce: 'abc' } }, thoughtSignature: 'sig-fn' }, { text: 'ok' }] };
  assert.equal(hasFunctionCall(content), true);
  assert.deepEqual(extractFunctionCallParts(content), [content.parts[0]]);
  assert.equal(hasThoughtSignatureOnFunctionCall(content), true);
  assert.equal(hasFunctionCall({ parts: [{ text: 'none' }] }), false);
});

test('reasoning continuity helpers collect usage/cache metrics and strip thought signatures', () => {
  const events = parseSseEvents('data: {"response":{"usageMetadata":{"totalTokenCount":9,"cachedContentTokenCount":4},"cacheTokens":7}}\n\n');
  assert.deepEqual(collectUsageAndCacheMetrics(events), {
    usageMetadata: { totalTokenCount: 9, cachedContentTokenCount: 4 },
    cacheTokens: { cachedContentTokenCount: 4, cacheTokens: 7 },
  });
  const stripped = stripThoughtSignatures({ parts: [{ text: 'x', thoughtSignature: 'secret', nested: { thoughtSignature: 'secret2', ok: true } }] });
  assert.deepEqual(stripped, { parts: [{ text: 'x', nested: { ok: true } }] });
  assert.equal(hasThoughtSignature(stripped), false);
});
