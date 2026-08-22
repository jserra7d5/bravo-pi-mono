import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
