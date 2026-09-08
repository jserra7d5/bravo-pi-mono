import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AffinityStore } from '../src/affinity.js';
import { handlePostCompact, installCompactionHook } from '../src/compaction.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'cab-compaction-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('PostCompact CLI clears every model lease for only the compacted session', () => {
  const stateRoot = path.join(root, 'state');
  const store = new AffinityStore({ stateRoot });
  for (const model of ['claude-opus-5', 'claude-fable-5-1', 'claude-haiku-4-5']) {
    store.touch('compacted', '1', model);
    store.touch('other', '2', model);
  }
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'post-compact'], {
    env: { ...process.env, CLAUDE_AUTH_BALANCER_HOME: stateRoot },
    input: JSON.stringify({ hook_event_name: 'PostCompact', session_id: 'compacted', trigger: 'auto', compact_summary: 'summary' }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '', 'hook injects no text into the agent context');
  for (const model of ['claude-opus-5', 'claude-fable-5-1', 'claude-haiku-4-5']) {
    assert.equal(store.lookup('compacted', model), undefined);
    assert.equal(store.lookup('other', model), '2');
  }
  assert.equal(handlePostCompact({ hook_event_name: 'PostCompact', session_id: 'compacted' }, stateRoot), 0);
});

test('a pre-compaction or malformed event cannot clear affinity', () => {
  const stateRoot = path.join(root, 'invalid');
  const store = new AffinityStore({ stateRoot });
  store.touch('session', '1');
  for (const event of [null, {}, { hook_event_name: 'PreCompact', session_id: 'session' }, { hook_event_name: 'PostCompact', session_id: '' }]) {
    assert.throws(() => handlePostCompact(event, stateRoot), /PostCompact/);
  }
  assert.equal(store.lookup('session'), '1');
});

test('hook installation preserves settings and other hooks and is idempotent', () => {
  const settingsPath = path.join(root, 'settings.json');
  const existing = { hooks: [{ type: 'command', command: 'existing' }] };
  writeFileSync(settingsPath, JSON.stringify({ env: { KEEP: 'yes' }, hooks: { PostCompact: [existing], Stop: [existing] } }));
  installCompactionHook(settingsPath, '/tmp/cli.js');
  installCompactionHook(settingsPath, '/tmp/cli.js');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.deepEqual(settings.env, { KEEP: 'yes' });
  assert.deepEqual(settings.hooks.Stop, [existing]);
  assert.deepEqual(settings.hooks.PostCompact, [existing, { hooks: [{ type: 'command', command: "'/tmp/cli.js' post-compact", timeout: 10 }] }]);
  writeFileSync(settingsPath, '{invalid');
  assert.throws(() => installCompactionHook(settingsPath, '/tmp/cli.js'));
  assert.equal(readFileSync(settingsPath, 'utf8'), '{invalid');
});
