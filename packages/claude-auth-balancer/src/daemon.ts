// Running as a single long-lived process.
//
// Every remaining multi-process hazard in this package — two proxies racing a
// lease, two writers on the metrics DB, two refreshers rotating one token — is
// solved by there being exactly one balancer. Selection and lease-pinning are
// already atomic *within* a process, because Node does not yield between them.
//
// So rather than adding a lock per shared resource, this enforces the premise
// those atomicity arguments rest on, and does it in a way that survives a crash:
// the lock records a pid, and a lock whose pid is gone is not a lock.
//
// A port collision is NOT a sufficient guard. Two `serve` invocations on
// different ports bind happily and then share one state root, which is the
// exact configuration the in-process reasoning does not cover.

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type SingletonLock = {
  path: string;
  release: () => void;
};

export class SingletonLockError extends Error {
  readonly holderPid: number;
  constructor(lockPath: string, holderPid: number) {
    super(
      `another claude-auth-balancer is already running (pid ${holderPid}).\n` +
        `If that is wrong, remove ${lockPath} and try again.`,
    );
    this.name = 'SingletonLockError';
    this.holderPid = holderPid;
  }
}

/** True if a process with this pid exists. Signal 0 checks without delivering. */
function pidAlive(pid: number, kill: (pid: number, signal: number) => void): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Claim the singleton lock for a state root.
 *
 * Throws {@link SingletonLockError} when a live process already holds it. A
 * lock left by a crashed process is taken over silently, which is the only
 * behaviour that does not require a human after every unclean shutdown.
 */
export function acquireSingletonLock(
  stateRoot: string,
  deps: { pid?: number; kill?: (pid: number, signal: number) => void } = {},
): SingletonLock {
  const pid = deps.pid ?? process.pid;
  const kill = deps.kill ?? ((p, s) => process.kill(p, s));
  const lockPath = path.join(stateRoot, 'balancer.lock');
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });

  try {
    const holder = Number(readFileSync(lockPath, 'utf8').trim());
    if (holder !== pid && pidAlive(holder, kill)) throw new SingletonLockError(lockPath, holder);
  } catch (error) {
    if (error instanceof SingletonLockError) throw error;
    /* absent or unreadable — ours to take */
  }

  // Write via rename so a reader never sees a half-written pid and concludes
  // the lock is free.
  const tmp = `${lockPath}.tmp.${pid}`;
  writeFileSync(tmp, `${pid}\n`, { mode: 0o600 });
  renameSync(tmp, lockPath);

  let released = false;
  return {
    path: lockPath,
    release: () => {
      if (released) return;
      released = true;
      try {
        // Only drop the lock if it is still ours. A stale-takeover by another
        // process must not be undone by our exit handler.
        if (Number(readFileSync(lockPath, 'utf8').trim()) === pid) unlinkSync(lockPath);
      } catch {
        /* already gone */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// systemd user unit
// ---------------------------------------------------------------------------

export type UnitOptions = {
  execPath: string;
  cliPath: string;
  port: number;
  allowOverage: boolean;
  stateRoot?: string;
};

export function userUnitPath(home = os.homedir()): string {
  return path.join(home, '.config', 'systemd', 'user', 'claude-auth-balancer.service');
}

/**
 * Render the unit.
 *
 * `--allow-overage` is baked in at install time rather than left to a runtime
 * flag, because a daemon is exactly the thing nobody is watching: overage
 * spends real money past 100%, and it should never be a surprise discovered in
 * a bill. Changing it means reinstalling the unit, deliberately.
 */
export function renderUnit(options: UnitOptions): string {
  const args = ['serve', '--port', String(options.port)];
  if (options.allowOverage) args.push('--allow-overage');
  const exec = [options.execPath, options.cliPath, ...args].map(a => JSON.stringify(a)).join(' ');

  return `[Unit]
Description=Claude OAuth balancing proxy (claude-auth-balancer)
Documentation=https://github.com/bravo/bravo-pi-mono
# The proxy is useless without egress, and systemd starts user units early.
After=network-online.target
Wants=network-online.target
# Loops fast enough to trip this are broken, not busy.
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
ExecStart=${exec}
# A crash must not silently leave ANTHROPIC_BASE_URL pointing at a dead port:
# every client would fail closed until someone noticed.
Restart=on-failure
RestartSec=5
${options.stateRoot ? `Environment=CLAUDE_AUTH_BALANCER_HOME=${options.stateRoot}\n` : ''}\
# It only ever talks to the Anthropic API and its own state directory.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
# ...but state and canonical authswap credentials must stay writable.
ReadWritePaths=%h/.bravo %h/.authswap

[Install]
WantedBy=default.target
`;
}
