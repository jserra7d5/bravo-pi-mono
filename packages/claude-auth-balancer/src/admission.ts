import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const RUNTIME_CREDENTIAL_VERSION = 1 as const;
export const RUNTIME_CREDENTIAL_HEADER = 'x-api-key';

export type RuntimeCredential = {
  schema_version: typeof RUNTIME_CREDENTIAL_VERSION;
  instance_id: string;
  pid: number;
  created_at: string;
  nonce: string;
};

export function runtimeCredentialPath(stateRoot: string): string {
  return path.join(stateRoot, 'runtime', 'claude-gateway-credential.json');
}

export function createRuntimeCredential(stateRoot: string, pid = process.pid): RuntimeCredential {
  const credential: RuntimeCredential = {
    schema_version: RUNTIME_CREDENTIAL_VERSION,
    instance_id: randomBytes(16).toString('hex'),
    pid,
    created_at: new Date().toISOString(),
    nonce: randomBytes(32).toString('base64url'),
  };
  const target = runtimeCredentialPath(stateRoot);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.tmp.${pid}`;
  writeFileSync(tmp, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
  return credential;
}

export function removeRuntimeCredential(stateRoot: string, expectedNonce?: string): void {
  const target = runtimeCredentialPath(stateRoot);
  try {
    if (expectedNonce !== undefined) {
      const current = readRuntimeCredential(stateRoot);
      if (current?.nonce !== expectedNonce) return;
    }
    rmSync(target, { force: true });
  } catch {
    /* best effort on shutdown */
  }
}

export function readRuntimeCredential(stateRoot: string): RuntimeCredential | undefined {
  try {
    const target = runtimeCredentialPath(stateRoot);
    const stat = statSync(target);
    const mode = stat.mode & 0o777;
    if ((mode & 0o077) !== 0) return undefined;
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return undefined;
    const parsed = JSON.parse(readFileSync(target, 'utf8')) as RuntimeCredential;
    if (parsed?.schema_version !== RUNTIME_CREDENTIAL_VERSION) return undefined;
    if (typeof parsed.nonce !== 'string' || parsed.nonce.length === 0) return undefined;
    if (typeof parsed.instance_id !== 'string' || parsed.instance_id.length === 0) return undefined;
    if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function isRuntimeCredentialLive(credential: RuntimeCredential): boolean {
  try {
    process.kill(credential.pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

export function assertRuntimeCredentialForLaunch(stateRoot: string): RuntimeCredential {
  const credential = readRuntimeCredential(stateRoot);
  if (!credential) {
    throw new Error(
      `claude-auth-balancer runtime credential is missing or unreadable at ${runtimeCredentialPath(stateRoot)}; start the daemon and use its active credential`,
    );
  }
  if (!isRuntimeCredentialLive(credential)) {
    throw new Error(
      `claude-auth-balancer runtime credential at ${runtimeCredentialPath(stateRoot)} belongs to a dead daemon instance; restart the daemon and use its active credential`,
    );
  }
  return credential;
}

export function timingSafeNonceEqual(provided: string | undefined, expected: string): boolean {
  const providedDigest = randomSafeDigest(provided ?? '');
  const expectedDigest = randomSafeDigest(expected);
  return timingSafeEqual(providedDigest, expectedDigest);
}

function randomSafeDigest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

// --- per-client credentials -------------------------------------------------
//
// The daemon's per-instance nonce breaks every launched client on restart,
// because the launcher injects it into the child's environment once and the
// child can never re-read it. Per-client credentials make a daemon restart a
// non-event for auth: each launcher mints its OWN nonce, records it in an
// owner-checked registry file bound to the launcher's pid (the launcher stays
// alive wrapping the child), and deletes it when the client exits. The daemon
// accepts any live registry nonce, and the registry survives restarts.
//
// This also tightens the leak bound: a client's nonce dies with that client's
// launcher process instead of living until the next daemon restart, and a
// stolen nonce stops working the moment its client exits. The filesystem is
// the real boundary — writing a valid 0600 entry requires being this user, at
// which point the authswap credential files are readable directly anyway.
//
// Entries without a pid are "adopted" nonces (daemon-upgrade migration). They
// carry a mandatory expiry and exist so already-running clients survive the
// upgrade to this scheme; `sweep` removes them once expired.

export type ClientCredential = {
  schema_version: typeof RUNTIME_CREDENTIAL_VERSION;
  nonce: string;
  /** Launcher pid; the entry is only valid while this process is alive. */
  client_pid?: number;
  /** Required when client_pid is absent: adopted nonces must expire. */
  expires_at_ms?: number;
  created_at: string;
  comment?: string;
};

export function clientCredentialDir(stateRoot: string): string {
  return path.join(stateRoot, 'runtime', 'clients');
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Mint a per-client credential owned by `pid` (the launcher). */
export function createClientCredential(
  stateRoot: string,
  pid = process.pid,
): { credential: ClientCredential; filePath: string } {
  const credential: ClientCredential = {
    schema_version: RUNTIME_CREDENTIAL_VERSION,
    nonce: randomBytes(32).toString('base64url'),
    client_pid: pid,
    created_at: new Date().toISOString(),
  };
  const dir = clientCredentialDir(stateRoot);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, `client-${pid}-${randomBytes(6).toString('hex')}.json`);
  const tmp = `${filePath}.tmp.${pid}`;
  writeFileSync(tmp, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, filePath);
  return { credential, filePath };
}

export function removeClientCredential(filePath: string): void {
  try {
    rmSync(filePath, { force: true });
  } catch {
    /* best effort on client exit */
  }
}

function readClientCredential(filePath: string): ClientCredential | undefined {
  try {
    const stat = statSync(filePath);
    if ((stat.mode & 0o077) !== 0) return undefined;
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return undefined;
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as ClientCredential;
    if (parsed?.schema_version !== RUNTIME_CREDENTIAL_VERSION) return undefined;
    if (typeof parsed.nonce !== 'string' || parsed.nonce.length === 0) return undefined;
    if (parsed.client_pid !== undefined && (!Number.isInteger(parsed.client_pid) || parsed.client_pid <= 0)) {
      return undefined;
    }
    // An entry bound to nothing and expiring never would be a permanent secret.
    if (parsed.client_pid === undefined && typeof parsed.expires_at_ms !== 'number') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function clientCredentialLive(credential: ClientCredential, nowMs: number): boolean {
  if (credential.expires_at_ms !== undefined && credential.expires_at_ms <= nowMs) return false;
  if (credential.client_pid !== undefined && !pidAlive(credential.client_pid)) return false;
  return true;
}

const CLIENT_RESCAN_INTERVAL_MS = 2_000;

/**
 * Registry of live per-client nonces.
 *
 * The directory is rescanned at most every two seconds — and always on an auth
 * miss, so a freshly launched client is never rejected by a stale cache. Every
 * nonce comparison is timing-safe; the presented value is compared against
 * every live entry rather than short-circuiting on a directory lookup keyed by
 * anything derived from the secret.
 */
export class ClientCredentialStore {
  private readonly dir: string;
  private readonly now: () => number;
  private cache: ClientCredential[] = [];
  private lastScan = -Infinity;

  constructor(stateRoot: string, now: () => number = Date.now) {
    this.dir = clientCredentialDir(stateRoot);
    this.now = now;
  }

  private scan(): void {
    this.lastScan = this.now();
    const loaded: ClientCredential[] = [];
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      this.cache = [];
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const credential = readClientCredential(path.join(this.dir, name));
      if (credential) loaded.push(credential);
    }
    this.cache = loaded;
  }

  /** True when `presented` matches any live registry entry. */
  verify(presented: string | undefined): boolean {
    if (!presented) return false;
    if (this.now() - this.lastScan >= CLIENT_RESCAN_INTERVAL_MS) this.scan();
    if (this.matches(presented)) return true;
    // Miss: the client may have launched inside the cache window.
    this.scan();
    return this.matches(presented);
  }

  private matches(presented: string): boolean {
    const nowMs = this.now();
    let ok = false;
    for (const credential of this.cache) {
      if (!clientCredentialLive(credential, nowMs)) continue;
      // No early exit: every live entry is compared so timing does not reveal
      // which entry, if any, matched.
      if (timingSafeNonceEqual(presented, credential.nonce)) ok = true;
    }
    return ok;
  }

  /** Remove entries whose pid is dead or whose expiry has passed. */
  sweep(): number {
    let removed = 0;
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return 0;
    }
    const nowMs = this.now();
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const filePath = path.join(this.dir, name);
      const credential = readClientCredential(filePath);
      if (credential && clientCredentialLive(credential, nowMs)) continue;
      try {
        rmSync(filePath, { force: true });
        removed += 1;
      } catch {
        /* ignore */
      }
    }
    this.lastScan = -Infinity;
    return removed;
  }
}
