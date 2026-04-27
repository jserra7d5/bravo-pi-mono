import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, '../src/cli.js');
const packageRoot = resolve(here, '../..');

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
function jsonRunInput(args: string[], input: string, opts: { cwd: string; home: string; ok?: boolean }) {
  const res = spawnSync(process.execPath, [cli, ...args, '--json'], {
    cwd: opts.cwd,
    env: { ...process.env, HOME: opts.home, LOOM_HOME: join(opts.home, '.loom') },
    input,
    encoding: 'utf8'
  });
  if (opts.ok !== false && res.status !== 0) {
    throw new Error(`loom ${args.join(' ')} failed\nstdout=${res.stdout}\nstderr=${res.stderr}`);
  }
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

  r = jsonRun(['-L', 'feature-x', 'node', 'create', '--title', 'Top-level proposal', '--kind', 'proposal', '--tag', 'review', '--tag', 'integration'], { cwd: w.outside, home: w.home });
  assert.equal(r.data.node.id, 'N-0001');

  r = jsonRun(['-L', 'feature-x', 'node', 'show', 'N-0001'], { cwd: w.outside, home: w.home });
  assert.deepEqual(r.data.frontmatter.tags, ['review', 'integration']);

  for (const title of ['Storage', 'Search', 'Agents']) {
    jsonRun(['-L', 'feature-x', 'node', 'create', '--title', title, '--kind', 'task', '--parent', 'N-0001'], { cwd: w.outside, home: w.home });
  }
  r = jsonRun(['-L', 'feature-x', 'node', 'list', '--parent', 'N-0001'], { cwd: w.outside, home: w.home });
  assert.deepEqual(r.data.nodes.map((n: any) => n.id), ['N-0002', 'N-0003', 'N-0004']);

  for (const title of ['Markdown', 'SQLite', 'Hybrid']) {
    const created = jsonRun(['-L', 'feature-x', 'node', 'create', '--title', title, '--kind', 'variant', '--parent', 'N-0002'], { cwd: w.outside, home: w.home });
    jsonRun(['-L', 'feature-x', 'edge', 'add', created.data.node.id, '--type', 'related', '--to', 'N-0002'], { cwd: w.outside, home: w.home });
  }
  r = jsonRun(['-L', 'feature-x', 'node', 'list', '--parent', 'N-0002'], { cwd: w.outside, home: w.home });
  assert.deepEqual(r.data.nodes.map((n: any) => n.id), ['N-0005', 'N-0006', 'N-0007']);

  r = jsonRun(['-L', 'feature-x', 'node', 'create', '--title', 'Decision: Storage', '--kind', 'decision', '--parent', 'N-0002', '--summary', 'Hybrid is the v1 choice'], { cwd: w.outside, home: w.home });
  assert.equal(r.data.node.id, 'N-0008');
  jsonRun(['-L', 'feature-x', 'edge', 'add', 'N-0008', '--type', 'chooses', '--to', 'N-0007'], { cwd: w.outside, home: w.home });

  r = jsonRun(['-L', 'feature-x', 'reference', 'add', 'N-0007', '--workspace', 'repo', 'packages/tango/src/start.ts', '--label', 'Tango start'], { cwd: w.outside, home: w.home });
  assert.equal(r.data.references[0].workspace, 'repo');
  assert.equal(r.data.references[0].path, 'packages/tango/src/start.ts');

  const note = spawnSync(process.execPath, [cli, '-L', 'feature-x', 'note', 'add', 'N-0007', '--stdin', '--json'], {
    cwd: w.outside,
    env: { ...process.env, HOME: w.home, LOOM_HOME: join(w.home, '.loom') },
    input: 'Safe note with `backticks` and $HOME preserved.',
    encoding: 'utf8'
  });
  assert.equal(note.status, 0, note.stderr);

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

  const loomPath = join(w.cwd, '.loom/looms/feature-x');
  assert.ok(existsSync(join(w.cwd, '.loom/config.json')));
  assert.ok(existsSync(join(loomPath, 'runtime/runtime.sqlite')));
  jsonRun(['-L', 'feature-x', 'index', 'rebuild'], { cwd: w.outside, home: w.home });
  const count = execFileSync('sqlite3', [join(loomPath, 'runtime/runtime.sqlite'), 'select count(*) from inbox_items;'], { encoding: 'utf8' }).trim();
  assert.equal(count, '1');
});

test('multiple looms under one container resolve by current and local name', () => {
  const w = workspace();
  mkdirSync(w.outside, { recursive: true });

  let r = jsonRun(['create', 'main', '--title', 'Main Loom'], { cwd: w.cwd, home: w.home });
  assert.equal(r.data.path, join(w.cwd, '.loom/looms/main'));

  r = jsonRun(['create', 'feature-a', '--title', 'Feature A'], { cwd: w.cwd, home: w.home });
  assert.equal(r.data.path, join(w.cwd, '.loom/looms/feature-a'));

  r = jsonRun(['list'], { cwd: w.cwd, home: w.home });
  assert.equal(r.data.current, 'feature-a');
  assert.deepEqual(r.data.looms.map((l: any) => l.name).sort(), ['feature-a', 'main']);

  r = jsonRun(['switch', 'main'], { cwd: w.cwd, home: w.home });
  assert.equal(r.data.current, 'main');

  r = jsonRun(['node', 'create', '--title', 'Main node'], { cwd: w.cwd, home: w.home });
  assert.equal(r.data.node.id, 'N-0001');

  r = jsonRun(['-L', 'feature-a', 'node', 'create', '--title', 'Feature node'], { cwd: w.cwd, home: w.home });
  assert.equal(r.data.node.id, 'N-0001');

  r = jsonRun(['switch', 'feature-a'], { cwd: w.cwd, home: w.home });
  assert.equal(r.data.current, 'feature-a');

  r = jsonRun(['current'], { cwd: w.cwd, home: w.home });
  assert.equal(r.data.alias, 'feature-a');
  assert.equal(r.data.loomPath, join(w.cwd, '.loom/looms/feature-a'));

  r = jsonRun(['node', 'list'], { cwd: w.cwd, home: w.home });
  assert.match(JSON.stringify(r.data.nodes), /Feature node/);
  assert.doesNotMatch(JSON.stringify(r.data.nodes), /Main node/);
});

test('top-level create initializes or creates a Loom workstream', () => {
  const w = workspace();
  let r = jsonRun(['create', 'implementation-plan', '--title', 'Implementation Plan'], { cwd: w.cwd, home: w.home });
  assert.equal(r.data.loom.name, 'implementation-plan');
  assert.equal(r.data.current, undefined);
  assert.ok(existsSync(join(w.cwd, '.loom/config.json')));

  r = jsonRun(['create', 'follow-up-plan'], { cwd: w.cwd, home: w.home });
  assert.equal(r.data.loom.name, 'follow-up-plan');
  assert.equal(r.data.loom.title, 'Follow Up Plan');
  assert.equal(r.data.current, 'follow-up-plan');

  r = jsonRun(['list'], { cwd: w.cwd, home: w.home });
  assert.equal(r.data.current, 'follow-up-plan');
  assert.deepEqual(r.data.looms.map((l: any) => l.name).sort(), ['follow-up-plan', 'implementation-plan']);
});

test('json error envelope has stable code', () => {
  const w = workspace();
  const res = run(['-L', 'missing', 'node', 'show', 'N-0001', '--json'], { cwd: w.cwd, home: w.home, ok: false });
  assert.notEqual(res.status, 0);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.status, 'error');
  assert.equal(payload.error.code, 'LOOM_NOT_FOUND');
  assert.equal(payload.error.transient, false);
});

test('agent-friendly CLI helpers are handoff-safe', () => {
  const w = workspace();
  mkdirSync(w.outside, { recursive: true });

  const help = run(['node', '--help'], { cwd: w.cwd, home: w.home });
  assert.match(help.stdout, /Usage: loom \[-L loom\] node/);

  let r = jsonRun(['init', '--name', 'helpers', '--title', 'Helpers'], { cwd: w.cwd, home: w.home });
  assert.equal(r.status, 'ok');
  jsonRun(['node', 'create', '--title', 'Root', '--kind', 'proposal'], { cwd: w.cwd, home: w.home });
  jsonRun(['node', 'create', '--title', 'Child', '--parent', 'N-0001'], { cwd: w.cwd, home: w.home });

  r = jsonRun(['edge', 'add', 'N-0002', '--to', 'N-0001', '--type', 'depends_on'], { cwd: w.cwd, home: w.home });
  assert.equal(r.data.created, true);
  r = jsonRun(['edge', 'add', 'N-0002', '--to', 'N-0001', '--type', 'depends_on'], { cwd: w.cwd, home: w.home });
  assert.equal(r.data.created, false);
  assert.equal(r.data.duplicate, true);

  r = jsonRun(['reference', 'add', 'N-0002', 'README.md', '--label', 'Readme'], { cwd: w.cwd, home: w.home });
  assert.equal(r.data.created, true);
  r = jsonRun(['reference', 'add', 'N-0002', 'README.md', '--label', 'Readme'], { cwd: w.cwd, home: w.home });
  assert.equal(r.data.created, false);
  assert.equal(r.data.duplicate, true);
  assert.equal(r.data.references.length, 1);

  r = jsonRun(['context', 'N-0002', '--brief'], { cwd: w.cwd, home: w.home });
  assert.equal(r.data.node.id, 'N-0002');
  assert.equal('body' in r.data, false);
  assert.equal(typeof r.data.body_preview, 'string');

  r = jsonRun(['graph', 'summary', 'N-0001'], { cwd: w.cwd, home: w.home });
  assert.equal(r.data.scope, 'N-0001');
  assert.equal(r.data.counts.nodes, 2);

  r = jsonRun(['graph', 'doctor', '--scope', 'N-0001'], { cwd: w.cwd, home: w.home });
  assert.equal(r.data.ok, true);
  assert.deepEqual(r.data.findings, []);

  r = jsonRun(['lock', 'status'], { cwd: w.cwd, home: w.home });
  assert.equal(r.data.locked, false);
});

test('Claude plugin exposes Loom commands and skills', () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, '.claude-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'loom');

  const commands = readdirSync(join(packageRoot, 'commands')).filter(f => f.endsWith('.md')).sort();
  assert.deepEqual(commands, [
    'loom-analyze.md',
    'loom-branch-design.md',
    'loom-breakdown.md',
    'loom-clarify.md',
    'loom-decide.md',
    'loom-design.md',
    'loom-implement.md',
    'loom-plan.md',
    'loom-ready.md',
    'loom-spec.md'
  ]);

  for (const command of commands) {
    const body = readFileSync(join(packageRoot, 'commands', command), 'utf8');
    assert.doesNotMatch(body, /Prefer reusing the persistent `loom-coordinator`/);
    assert.doesNotMatch(body, /child agents execute/);
    assert.match(body, /Claude Code/);
  }

  const skills = readdirSync(join(packageRoot, 'skills')).filter(name => existsSync(join(packageRoot, 'skills', name, 'SKILL.md'))).sort();
  assert.ok(skills.includes('loom-plan'));
  assert.ok(skills.includes('loom-design'));
  assert.ok(skills.includes('loom-implement'));
});

test('v2 noun-first commands, schema, and patch workflow work', () => {
  const w = workspace();
  mkdirSync(w.outside, { recursive: true });

  let r = jsonRun(['init', '--name', 'v2', '--title', 'V2'], { cwd: w.cwd, home: w.home });
  assert.equal(r.status, 'ok');

  r = jsonRun(['node', 'create', '--title', 'Root', '--kind', 'proposal'], { cwd: w.cwd, home: w.home });
  assert.equal(r.data.node.id, 'N-0001');
  r = jsonRun(['node', 'update', 'N-0001', '--state', 'active', '--summary', 'Root summary'], { cwd: w.cwd, home: w.home });
  assert.equal(r.data.node.state, 'active');
  assert.equal(r.data.node.summary, 'Root summary');
  r = jsonRun(['node', 'list', '--state', 'active'], { cwd: w.cwd, home: w.home });
  assert.deepEqual(r.data.nodes.map((n: any) => n.id), ['N-0001']);

  r = jsonRun(['note', 'add', 'N-0001', 'Design note'], { cwd: w.cwd, home: w.home });
  assert.equal(r.data.node.id, 'N-0001');
  r = jsonRun(['note', 'list', 'N-0001'], { cwd: w.cwd, home: w.home });
  assert.equal(r.data.notes.length, 1);
  assert.match(r.data.notes[0].body, /Design note/);
  r = jsonRun(['note', 'retract', 'N-0001:note:1', '--reason', 'test cleanup'], { cwd: w.cwd, home: w.home });
  assert.equal(r.data.retracted, 'N-0001:note:1');

  r = jsonRun(['edge', 'types'], { cwd: w.cwd, home: w.home });
  assert.ok(r.data.types.includes('depends_on'));

  const dryPatch = JSON.stringify({ operations: [
    { op: 'create_node', local_ref: 'child', title: 'Patch child', kind: 'task', parent: 'N-0001', summary: 'Patch summary', tags: ['a'] },
    { op: 'add_note', node: '$child', message: 'Patch note' }
  ]});
  r = jsonRunInput(['patch', 'preview', '--stdin', '--scope', 'N-0001'], dryPatch, { cwd: w.cwd, home: w.home });
  assert.equal(r.data.dryRun, true);
  assert.equal(r.data.summary.created, 1);
  r = jsonRun(['node', 'list'], { cwd: w.cwd, home: w.home });
  assert.equal(r.data.nodes.length, 1);

  r = jsonRunInput(['patch', 'apply', '--stdin', '--scope', 'N-0001'], dryPatch, { cwd: w.cwd, home: w.home });
  assert.equal(r.data.summary.applied, true);
  assert.equal(r.data.summary.created, 1);
  r = jsonRun(['node', 'list'], { cwd: w.cwd, home: w.home });
  assert.deepEqual(r.data.nodes.map((n: any) => n.id), ['N-0001', 'N-0002']);

  const draftPatch = JSON.stringify({ operations: [
    { op: 'create_node', local_ref: 'draft_child', title: 'Draft child', parent: 'N-0001' }
  ]});
  r = jsonRunInput(['draft', 'create', '--stdin', '--scope', 'N-0001', '--title', 'Draft child patch'], draftPatch, { cwd: w.cwd, home: w.home });
  assert.equal(r.data.draft.id, 'D-0001');
  r = jsonRun(['draft', 'list'], { cwd: w.cwd, home: w.home });
  assert.equal(r.data.drafts.length, 1);
  r = jsonRun(['draft', 'commit', 'D-0001'], { cwd: w.cwd, home: w.home });
  assert.equal(r.data.committed, true);
  r = jsonRun(['node', 'list'], { cwd: w.cwd, home: w.home });
  assert.deepEqual(r.data.nodes.map((n: any) => n.id), ['N-0001', 'N-0002', 'N-0003']);

  r = jsonRun(['edge', 'add', 'N-0002', '--to', 'N-0001', '--type', 'depends_on'], { cwd: w.cwd, home: w.home });
  assert.equal(r.data.created, true);
  r = jsonRun(['edge', 'list', 'N-0002'], { cwd: w.cwd, home: w.home });
  assert.equal(r.data.edges[0].type, 'depends_on');

  const badPatch = JSON.stringify({ operations: [
    { op: 'create_node', local_ref: 'other', title: 'Other root' },
    { op: 'add_edge', from: 'N-0002', to: '$other', type: 'depends_on' }
  ]});
  r = jsonRunInput(['patch', 'validate', '--stdin', '--scope', 'N-0001'], badPatch, { cwd: w.cwd, home: w.home, ok: false });
  assert.equal(r.status, 'error');
  assert.equal(r.error.code, 'SCOPE_VIOLATION');

  r = jsonRun(['schema', 'commands'], { cwd: w.cwd, home: w.home });
  assert.ok(r.data.commands.some((c: any) => c.name === 'patch.apply'));
  assert.ok(r.data.commands.some((c: any) => c.name === 'draft.commit'));
  r = jsonRun(['schema', 'command', 'node.create'], { cwd: w.cwd, home: w.home });
  assert.equal(r.data.command.name, 'node.create');

  r = jsonRun(['node', 'list', '--bogus'], { cwd: w.cwd, home: w.home, ok: false });
  assert.equal(r.status, 'error');
  assert.equal(r.error.code, 'INVALID_ARGUMENT');
  assert.match(r.error.message, /unknown flag/);
});
