import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStatusSummary, renderMonitorStatus } from '../src/tui/status.js';
import { truncateToWidth, formatMonitorRow } from '../src/tui/format.js';

test('computeStatusSummary counts active triggered failed', () => {
  const monitors = [
    { state: 'running', next_run_at: new Date(Date.now() + 12000).toISOString() },
    { state: 'triggered' },
    { state: 'failed' },
  ];
  const s = computeStatusSummary(monitors as any);
  assert.equal(s.active, 1);
  assert.equal(s.triggered, 1);
  assert.equal(s.failed, 1);
  assert.ok(s.nextRunIn);
});

test('renderMonitorStatus idle', () => {
  const text = renderMonitorStatus({ active: 0, triggered: 0, failed: 0 });
  assert.equal(text, 'Monitors: idle');
});

test('renderMonitorStatus active', () => {
  const text = renderMonitorStatus({ active: 3, triggered: 0, failed: 0 });
  assert.equal(text, 'Monitors: 3 active');
});

test('renderMonitorStatus with triggered and next', () => {
  const text = renderMonitorStatus({ active: 2, triggered: 1, failed: 0, nextRunIn: '12s' });
  assert.equal(text, 'Monitors: 2 active · 1 triggered · next 12s');
});

test('renderMonitorStatus with failed', () => {
  const text = renderMonitorStatus({ active: 4, triggered: 0, failed: 2 });
  assert.equal(text, 'Monitors: 4 active · 2 failed');
});

test('truncateToWidth truncates long text', () => {
  assert.equal(truncateToWidth('hello world', 5), 'hell…');
  assert.equal(truncateToWidth('hi', 5), 'hi');
});

test('formatMonitorRow renders running monitor', () => {
  const line = formatMonitorRow({
    monitor_id: 'm1',
    name: 'build',
    state: 'running',
    next_run_at: new Date(Date.now() + 8000).toISOString(),
    check: { type: 'file', path: '/tmp/watch', mode: 'exists' },
  });
  assert.match(line, /build/);
  assert.match(line, /running/);
});
