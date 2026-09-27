import { createServer, type Server } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { exec } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { cleanupLaunch, finishTokenLease, getConservationQuota, getUsage, ingestLiveUsage, listRateLimitCooldowns, loadAccounts, publishRateLimitCooldown, recordCodexAttempt, resolveStateRoot, startTokenLease, syncBack, writeBrokenSnapshot } from './index.js';

export async function serveLeaseService(stateRoot = resolveStateRoot(), port = 8790): Promise<Server> {
  const credentialPath = path.join(stateRoot, 'runtime', 'lease-service-credential.json');
  await fs.mkdir(path.dirname(credentialPath), { recursive: true, mode: 0o700 });
  let nonce: string;
  try {
    const stat = await fs.stat(credentialPath);
    if ((stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('unsafe lease credential permissions');
    const parsed = JSON.parse(await fs.readFile(credentialPath, 'utf8')) as { nonce?: string };
    if (!parsed.nonce || typeof parsed.nonce !== 'string') throw new Error('invalid lease credential');
    nonce = parsed.nonce;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    nonce = randomBytes(32).toString('base64url');
    try { await fs.writeFile(credentialPath, JSON.stringify({ nonce }) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; return serveLeaseService(stateRoot, port); }
  }
  const handlers: Record<string, (input: any) => unknown> = {
    startLease: input => startTokenLease({ ...input, stateRoot }),
    finishLease: input => finishTokenLease({ ...input, stateRoot }),
    ingestUsage: input => ingestLiveUsage({ ...input, stateRoot }),
    publishCooldown: input => publishRateLimitCooldown({ ...input, stateRoot }),
    recordAttempt: input => recordCodexAttempt({ ...input, stateRoot }),
    listSlots: async () => {
      const cooldowns = new Map(listRateLimitCooldowns({ stateRoot }).map(c => [c.slot, c.expiresAt]));
      return (await loadAccounts(stateRoot)).map(a => ({ slot: a.slot, primaryRemaining: a.usage?.primary?.remainingPercent, cooldownUntil: cooldowns.get(a.slot) }));
    },
    markBroken: input => writeBrokenSnapshot(stateRoot, input.slot, input.code, input.message),
    getConservationQuota: input => getConservationQuota({ ...input, stateRoot }),
    getUsage: input => getUsage({ ...input, stateRoot }),
  };
  const server = createServer(async (req, res) => {
    const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value ?? null)); };
    const supplied = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    if (!timingSafeEqual(createHash('sha256').update(supplied).digest(), createHash('sha256').update(nonce).digest()) || !req.headers.authorization?.startsWith('Bearer ')) { send(401, { error: 'unauthorized' }); return; }
    const operation = req.url?.slice(1) ?? '';
    if (req.method !== 'POST' || !Object.hasOwn(handlers, operation)) { send(404, { error: 'not found' }); return; }
    try {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 1024 * 1024) throw new Error('request too large'); }
      send(200, await handlers[operation](JSON.parse(raw)));
    } catch (error) { send(400, { error: error instanceof Error ? error.message : 'request failed' }); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}

let cachedKey: string | undefined;
function readKey(): Promise<string> {
  const command = process.env.CODEX_AUTH_BALANCER_KEY_COMMAND;
  if (!command) return Promise.reject(new Error('CODEX_AUTH_BALANCER_KEY_COMMAND required'));
  return new Promise((resolve, reject) => exec(command, { timeout: 5000, maxBuffer: 4096 }, (error, stdout) => {
    if (error || !stdout.trim()) reject(new Error('Codex lease service key command failed'));
    else resolve(stdout.trim());
  }));
}
export async function leaseServiceCall<T>(operation: string, input: unknown = {}): Promise<T> {
  const url = process.env.CODEX_AUTH_BALANCER_URL;
  if (!url) throw new Error('CODEX_AUTH_BALANCER_URL required');
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!cachedKey || attempt) cachedKey = await readKey();
    let response: Response;
    try {
      response = await fetch(new URL(operation, url.endsWith('/') ? url : `${url}/`), {
        method: 'POST', headers: { authorization: `Bearer ${cachedKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(input), signal: AbortSignal.timeout(15000),
      });
    } catch (error) { throw new Error(`Codex lease service unreachable at ${url}: ${error instanceof Error ? error.message : String(error)}`); }
    if (response.status === 401 && attempt === 0) continue;
    if (!response.ok) throw new Error(`Codex lease service ${url} returned ${response.status}: ${((await response.json()) as { error?: string }).error ?? 'request failed'}`);
    return await response.json() as T;
  }
  throw new Error(`Codex lease service ${url} unauthorized`);
}
