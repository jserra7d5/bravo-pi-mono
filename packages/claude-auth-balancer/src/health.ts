import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Account } from './accounts.js';
import { readOAuth } from './accounts.js';

export type AuthWarning = {
  code: 'refresh-terminal' | 'refresh-backoff';
  slot?: string;
  message: string;
  at: number;
};

function healthDir(stateRoot: string): string {
  return path.join(stateRoot, 'state', 'auth-health');
}

function refreshPath(stateRoot: string, slot: string): string {
  return path.join(healthDir(stateRoot), 'refresh', `${encodeURIComponent(slot)}.json`);
}

function readWarning(file: string): AuthWarning | undefined {
  try {
    const warning = JSON.parse(readFileSync(file, 'utf8')) as AuthWarning;
    return warning && typeof warning.code === 'string' && typeof warning.message === 'string'
      ? warning
      : undefined;
  } catch {
    return undefined;
  }
}

/** Aggregate independent ownership files. No read-modify-write is involved. */
export function readAuthWarnings(stateRoot: string): AuthWarning[] {
  const warnings: AuthWarning[] = [];
  const dir = path.join(healthDir(stateRoot), 'refresh');
  try {
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith('.json')) continue;
      const warning = readWarning(path.join(dir, name));
      if (warning) warnings.push(warning);
    }
  } catch {
    /* no refresh warnings */
  }
  return warnings;
}

/** Hide warnings made obsolete by a newer credential write. */
export function readActiveAuthWarnings(
  stateRoot: string,
  accounts: readonly Account[],
  _nowMs = Date.now(),
): AuthWarning[] {
  const bySlot = new Map(accounts.map(account => [account.slot, account]));
  return readAuthWarnings(stateRoot).filter(warning => {
    if (!warning.slot) return true;
    const account = bySlot.get(warning.slot);
    if (!account) return true;
    const expiresAt = readOAuth(account.credentialPath)?.expiresAt;
    return expiresAt === undefined || expiresAt <= warning.at;
  });
}

function writeOwnedWarning(file: string, warning?: AuthWarning): void {
  if (!warning) {
    try { unlinkSync(file); } catch { /* already clear */ }
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // A UUID is required even within one process: refreshes for different slots
  // can complete on the same event-loop turn.
  const tmp = `${file}.tmp.${process.pid}.${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify(warning, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Each slot exclusively owns its own warning file. */
export function setRefreshWarning(stateRoot: string, slot: string, warning?: AuthWarning): void {
  writeOwnedWarning(refreshPath(stateRoot, slot), warning);
}

export function conciseWarnings(warnings: AuthWarning[]): string[] {
  return warnings.map(w => {
    const slot = w.slot ? ` slot ${w.slot}` : '';
    switch (w.code) {
      case 'refresh-terminal': return `refresh${slot} needs login`;
      case 'refresh-backoff': return `refresh${slot} backing off`;
    }
  });
}
