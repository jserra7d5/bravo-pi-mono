import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { SingletonLockError, acquireSingletonLock, renderUnit, userUnitPath } from '../src/daemon.js';

const roots: string[] = [];
function tmpRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cab-daemon-'));
  roots.push(dir);
  return dir;
}
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A process table: only the listed pids exist. */
function table(alive: number[]): (pid: number, signal: number) => void {
  return pid => {
    if (!alive.includes(pid)) {
      const error = new Error('ESRCH') as NodeJS.ErrnoException;
      error.code = 'ESRCH';
      throw error;
    }
  };
}

// ---------------------------------------------------------------------------
// Singleton lock
// ---------------------------------------------------------------------------

test('the lock records the holding pid', () => {
  const root = tmpRoot();
  const lock = acquireSingletonLock(root, { pid: 4242, kill: table([4242]) });
  assert.equal(readFileSync(lock.path, 'utf8').trim(), '4242');
  assert.equal(lock.path, path.join(root, 'balancer.lock'));
});

test('a second live process is refused, whatever port it would have bound', () => {
  const root = tmpRoot();
  acquireSingletonLock(root, { pid: 100, kill: table([100, 200]) });
  assert.throws(
    () => acquireSingletonLock(root, { pid: 200, kill: table([100, 200]) }),
    (error: unknown) => error instanceof SingletonLockError && error.holderPid === 100,
  );
});

test('a lock from a crashed process is taken over without human intervention', () => {
  const root = tmpRoot();
  acquireSingletonLock(root, { pid: 100, kill: table([100]) });
  // 100 is gone; 200 is the new daemon after a reboot or an unclean kill.
  const lock = acquireSingletonLock(root, { pid: 200, kill: table([200]) });
  assert.equal(readFileSync(lock.path, 'utf8').trim(), '200');
});

test('a pid that exists but belongs to another user still counts as alive', () => {
  const root = tmpRoot();
  writeFileSync(path.join(root, 'balancer.lock'), '999\n');
  const eperm = (pid: number) => {
    const error = new Error('EPERM') as NodeJS.ErrnoException;
    error.code = 'EPERM';
    throw error;
  };
  assert.throws(
    () => acquireSingletonLock(root, { pid: 1, kill: eperm }),
    SingletonLockError,
    'EPERM means running, not absent — treating it as free would allow two daemons',
  );
});

test('releasing removes the lock', () => {
  const root = tmpRoot();
  const lock = acquireSingletonLock(root, { pid: 100, kill: table([100]) });
  lock.release();
  assert.ok(!existsSync(lock.path));
  lock.release(); // idempotent
});

test('releasing never deletes a lock another process has since taken', () => {
  const root = tmpRoot();
  const first = acquireSingletonLock(root, { pid: 100, kill: table([100]) });
  // 100 dies; 200 takes over; then 100's exit handler finally fires.
  acquireSingletonLock(root, { pid: 200, kill: table([200]) });
  first.release();
  assert.ok(existsSync(first.path), 'the live daemon keeps its lock');
  assert.equal(readFileSync(first.path, 'utf8').trim(), '200');
});

test('the same process re-acquiring its own lock is not a conflict', () => {
  const root = tmpRoot();
  acquireSingletonLock(root, { pid: 100, kill: table([100]) });
  assert.doesNotThrow(() => acquireSingletonLock(root, { pid: 100, kill: table([100]) }));
});

test('a garbage lock file is treated as free rather than wedging the daemon forever', () => {
  const root = tmpRoot();
  writeFileSync(path.join(root, 'balancer.lock'), 'not-a-pid');
  const lock = acquireSingletonLock(root, { pid: 100, kill: table([100]) });
  assert.equal(readFileSync(lock.path, 'utf8').trim(), '100');
});

// ---------------------------------------------------------------------------
// systemd unit
// ---------------------------------------------------------------------------

const unitOptions = {
  execPath: '/usr/bin/node',
  cliPath: '/home/u/pkg/dist/src/cli.js',
  port: 8789,
  allowOverage: false,
};

test('the unit runs the CLI with the configured port', () => {
  const unit = renderUnit(unitOptions);
  assert.match(unit, /^ExecStart="\/usr\/bin\/node" "\/home\/u\/pkg\/dist\/src\/cli\.js" "serve" "--port" "8789"$/m);
});

test('overage is baked into the unit, not left to a runtime flag', () => {
  assert.ok(!renderUnit(unitOptions).includes('--allow-overage'));
  assert.match(renderUnit({ ...unitOptions, allowOverage: true }), /"--allow-overage"/);
});

test('paths with spaces survive into ExecStart', () => {
  // systemd splits ExecStart on whitespace; an unquoted path here silently
  // becomes two arguments and the service fails to start.
  const unit = renderUnit({ ...unitOptions, cliPath: '/home/u/my code/cli.js' });
  assert.match(unit, /"\/home\/u\/my code\/cli\.js"/);
});

test('the sandbox leaves the credential directory writable', () => {
  // ProtectHome=read-only plus token refresh is a contradiction: refresh
  // rewrites the authswap credential file in place, so without this the daemon
  // would run fine and quietly fail to keep any account alive.
  const unit = renderUnit(unitOptions);
  assert.match(unit, /ProtectHome=read-only/);
  assert.match(unit, /ReadWritePaths=.*%h\/\.authswap/);
  assert.match(unit, /ReadWritePaths=.*%h\/\.bravo/);
});

test('the unit restarts on failure and waits for the network', () => {
  const unit = renderUnit(unitOptions);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /After=network-online\.target/);
  assert.match(unit, /WantedBy=default\.target/, 'a user unit, started at login');
});

test('a custom state root is passed through as an environment override', () => {
  const unit = renderUnit({ ...unitOptions, stateRoot: '/srv/balancer' });
  assert.match(unit, /Environment=CLAUDE_AUTH_BALANCER_HOME=\/srv\/balancer/);
  assert.ok(!renderUnit(unitOptions).includes('CLAUDE_AUTH_BALANCER_HOME'));
});

test('the unit lands in the systemd user directory', () => {
  assert.equal(userUnitPath('/home/u'), '/home/u/.config/systemd/user/claude-auth-balancer.service');
});
