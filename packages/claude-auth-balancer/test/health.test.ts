import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { readAuthWarnings, setRefreshWarning } from '../src/health.js';

const roots: string[] = [];
after(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })));
function root(): string {
  const value = mkdtempSync(path.join(os.tmpdir(), 'cab-health-'));
  roots.push(value);
  return value;
}

function warning(slot: string) {
  return { code: 'refresh-terminal' as const, slot, message: `slot ${slot} rejected`, at: Number(slot) };
}

test('per-slot warning writes cannot erase another slot', () => {
  const stateRoot = root();
  setRefreshWarning(stateRoot, '1', warning('1'));
  setRefreshWarning(stateRoot, '2', warning('2'));
  setRefreshWarning(stateRoot, '1');
  assert.deepEqual(readAuthWarnings(stateRoot), [warning('2')]);
});

test('interleaved slot updates aggregate independently', async () => {
  const stateRoot = root();
  await Promise.all(Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => {
    const slot = String(i + 1);
    setRefreshWarning(stateRoot, slot, warning(slot));
  })));
  const found = readAuthWarnings(stateRoot);
  assert.equal(found.length, 20);
  assert.deepEqual(new Set(found.map(w => w.slot)), new Set(Array.from({ length: 20 }, (_, i) => String(i + 1))));
});
