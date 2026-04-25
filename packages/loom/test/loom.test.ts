import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, '../src/cli.js');

function run(args: string[], opts: { cwd: string; home: string; ok?: boolean } ) {
  const res = spawnSync(process.execPath, [cli, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, HOME: opts.home, LOOM_HOME: join(opts.home, '.loom') },
    encoding: 'utf8'
  });
  if (opts.ok !== false && res.status !== 0) {
    throw new Error(`loom ${args.join(' ')} failed\nstdout=${res.stdout}\nstderr=${res.stderr}`);
  }
  return res;
}
function jsonRun(args: string[], opts: { cwd: string; home: string; ok?: boolean }) {
  const res = run([...args, '--json'], opts);
  return JSON.parse(res.stdout);
}
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'loom-test-'));
  const home = join(root, 'home');
  const cwd = join(root, 'repo/docs/specs/feature-x');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(root, 'repo/packages/tango/src'), { recursive: true });
  writeFileSync(join(root, 'repo/packages/tango/src/start.ts'), 'export const start = true;\n');
  return { root, home, cwd, outside: join(root, 'outside') };
}

test('vertical slice works from inside and outside loom root', () => {
  const w = workspace();
  mkdirSync(w.outside, { recursive: true });

  let r = jsonRun(['init', '--name', 'feature-x', '--title', 'Feature X', '--workspace', 'repo=../../..'], { cwd: w.cwd, home: w.home });
  assert.equal(r.ok, true);
  assert.equal(r.data.loom.name, 'feature-x');

  r = jsonRun(['-L', 'feature-x', 'create', 'Top-level proposal', '--kind', 'proposal'], { cwd: w.outside, home: w.home });
  assert.equal(r.data.node.id, 'N-0001');

  r = jsonRun(['-L', 'feature-x', 'decompose', 'N-0001', 'Storage', 'Search', 'Agents'], { cwd: w.outside, home: w.home });
  assert.deepEqual(r.data.children, ['N-0002', 'N-0003', 'N-0004']);

  r = jsonRun(['-L', 'feature-x', 'branch', 'N-0002', 'Markdown', 'SQLite', 'Hybrid'], { cwd: w.outside, home: w.home });
  assert.deepEqual(r.data.variants, ['N-0005', 'N-0006', 'N-0007']);

  r = jsonRun(['-L', 'feature-x', 'decide', 'N-0002', '--choose', 'N-0007', '--summary', 'Hybrid is the v1 choice'], { cwd: w.outside, home: w.home });
  assert.equal(r.data.chosen, 'N-0007');

  r = jsonRun(['-L', 'feature-x', 'reference', 'add', 'N-0007', '--workspace', 'repo', 'packages/tango/src/start.ts', '--label', 'Tango start'], { cwd: w.outside, home: w.home });
  assert.equal(r.data.references[0].workspace, 'repo');
  assert.equal(r.data.references[0].path, 'packages/tango/src/start.ts');

  r = jsonRun(['-L', 'feature-x', 'index', 'rebuild'], { cwd: w.outside, home: w.home });
  assert.equal(r.data.rebuilt, true);

  r = jsonRun(['-L', 'feature-x', 'search', 'Hybrid'], { cwd: w.outside, home: w.home });
  assert.ok(r.data.hits.some((h: any) => h.node.id === 'N-0007'));

  r = jsonRun(['-L', 'feature-x', 'context', 'N-0007'], { cwd: w.outside, home: w.home });
  assert.equal(r.data.node.id, 'N-0007');
  assert.equal(r.data.references[0].label, 'Tango start');

  const guide = run(['-L', 'feature-x', 'agent', 'guide'], { cwd: w.outside, home: w.home });
  assert.match(guide.stdout, /Normal Worker Protocol/);

  r = jsonRun(['-L', 'feature-x', 'agent', 'join', 'worker-a', '--role', 'worker'], { cwd: w.outside, home: w.home });
  assert.equal(r.data.joined, true);

  r = jsonRun(['-L', 'feature-x', 'inbox', 'send', 'worker-a', '--type', 'review_request', '--node', 'N-0007', '--message', 'Review this choice'], { cwd: w.outside, home: w.home });
  assert.equal(r.data.item.id, 'M-0001');
  assert.equal(r.data.item.state, 'open');

  r = jsonRun(['-L', 'feature-x', 'inbox', 'next', 'worker-a'], { cwd: w.outside, home: w.home });
  assert.equal(r.data.item.id, 'M-0001');

  r = jsonRun(['-L', 'feature-x', 'inbox', 'done', 'M-0001', '--summary', 'Reviewed'], { cwd: w.outside, home: w.home });
  assert.equal(r.data.item.state, 'done');

  const loomPath = join(w.cwd, '.loom');
  assert.ok(existsSync(join(loomPath, 'runtime/runtime.sqlite')));
  jsonRun(['-L', 'feature-x', 'index', 'rebuild'], { cwd: w.outside, home: w.home });
  const count = execFileSync('sqlite3', [join(loomPath, 'runtime/runtime.sqlite'), 'select count(*) from inbox_items;'], { encoding: 'utf8' }).trim();
  assert.equal(count, '1');
});

test('json error envelope has stable code', () => {
  const w = workspace();
  const res = run(['-L', 'missing', 'show', 'N-0001', '--json'], { cwd: w.cwd, home: w.home, ok: false });
  assert.notEqual(res.status, 0);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'LOOM_NOT_FOUND');
});
