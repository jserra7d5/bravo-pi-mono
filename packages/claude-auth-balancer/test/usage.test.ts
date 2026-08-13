import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_1H_MULTIPLIER,
  UsageCollector,
  computeCost,
  pricingForModel,
  usageFromJsonBody,
} from '../src/usage.js';

/** Shape of a real Claude Code streaming response, abbreviated. */
const SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-5","usage":{"input_tokens":12,"cache_read_input_tokens":261443,"cache_creation_input_tokens":1024,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":1024}}}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","usage":{"output_tokens":57}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n');

test('collects input, cache, and output usage from an SSE stream', () => {
  const c = new UsageCollector();
  c.push(SSE);
  const usage = c.end();
  assert.equal(usage.inputTokens, 12);
  assert.equal(usage.cacheReadInputTokens, 261443);
  assert.equal(usage.cacheCreationInputTokens, 1024);
  assert.equal(usage.cacheCreation1hTokens, 1024);
  assert.equal(usage.cacheCreation5mTokens, 0);
  assert.equal(usage.outputTokens, 57);
  assert.equal(c.model, 'claude-opus-5');
});

test('usage survives arbitrary chunk boundaries', () => {
  for (const size of [1, 3, 17, 64, 501]) {
    const c = new UsageCollector();
    for (let i = 0; i < SSE.length; i += size) c.push(SSE.slice(i, i + size));
    const usage = c.end();
    assert.equal(usage.cacheReadInputTokens, 261443, `split at ${size}`);
    assert.equal(usage.outputTokens, 57, `split at ${size}`);
  }
});

test('a truncated stream still yields whatever arrived', () => {
  const c = new UsageCollector();
  c.push(SSE.slice(0, SSE.indexOf('message_delta')));
  const usage = c.end();
  assert.equal(usage.cacheReadInputTokens, 261443);
  assert.equal(usage.outputTokens, undefined, 'no output event arrived');
});

test('malformed data lines are skipped without throwing', () => {
  const c = new UsageCollector();
  c.push('event: x\ndata: {not json\n\ndata: [DONE]\n\n');
  assert.doesNotThrow(() => c.end());
});

test('non-streaming JSON bodies are parsed too', () => {
  const usage = usageFromJsonBody(
    '{"id":"msg_2","usage":{"input_tokens":5,"output_tokens":9,"cache_read_input_tokens":100}}',
  );
  assert.equal(usage.inputTokens, 5);
  assert.equal(usage.outputTokens, 9);
  assert.equal(usage.cacheReadInputTokens, 100);
});

test('pricing resolves the longest matching model key', () => {
  assert.deepEqual(pricingForModel('claude-opus-5'), { input: 5, output: 25 });
  assert.deepEqual(pricingForModel('claude-fable-5'), { input: 10, output: 50 });
  assert.deepEqual(pricingForModel('claude-sonnet-5'), { input: 3, output: 15 });
  assert.deepEqual(pricingForModel('claude-haiku-4-5'), { input: 1, output: 5 });
  assert.equal(pricingForModel('some-unknown-model'), undefined);
});

test('a cached 260k prefix costs 20x more to re-create than to read', () => {
  const prefix = 260_000;
  const read = computeCost('claude-opus-5', { cacheReadInputTokens: prefix })!;
  const write = computeCost('claude-opus-5', { cacheCreationInputTokens: prefix })!;

  assert.equal(Number(read.totalUsd.toFixed(4)), 0.13);
  assert.equal(Number(write.totalUsd.toFixed(4)), 2.6);
  assert.equal(
    Number((write.totalUsd / read.totalUsd).toFixed(6)),
    CACHE_WRITE_1H_MULTIPLIER / CACHE_READ_MULTIPLIER,
  );
});

test('cost reports what the cache actually saved', () => {
  const cost = computeCost('claude-opus-5', {
    inputTokens: 12,
    outputTokens: 100,
    cacheReadInputTokens: 260_000,
  })!;
  // uncached would have charged all 260,012 input tokens at full rate
  assert.equal(Number(cost.uncachedEquivalentUsd.toFixed(4)), Number((260_012 * 5e-6 + 100 * 25e-6).toFixed(4)));
  assert.ok(cost.savedUsd > 1.1, 'cache saved over a dollar on this one request');
});

test('cache creation with no TTL split is priced at 1h, which is what Claude Code writes', () => {
  const split = computeCost('claude-opus-5', {
    cacheCreationInputTokens: 1000,
    cacheCreation1hTokens: 1000,
    cacheCreation5mTokens: 0,
  })!;
  const unsplit = computeCost('claude-opus-5', { cacheCreationInputTokens: 1000 })!;
  assert.equal(split.totalUsd, unsplit.totalUsd);
});

test('an unknown model yields no cost rather than a wrong one', () => {
  assert.equal(computeCost('gpt-something', { inputTokens: 100 }), undefined);
});
