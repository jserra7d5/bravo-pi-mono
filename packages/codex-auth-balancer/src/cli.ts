#!/usr/bin/env node
import { finishTokenLease, cleanupLaunch, getDbStatus, getPolicy, getUsage, listReservations, loadAccounts, prepareLaunch, redactForJson, refreshUsage, resolveStateRoot, startTokenLease, syncBack } from './index.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import pkg from '../package.json' with { type: 'json' };

function arg(name: string) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }
function has(name: string) { return process.argv.includes(name); }
function out(v: unknown) { console.log(JSON.stringify(redactForJson(v), null, 2)); }
function needJson() { if (!has('--json')) throw new Error('only --json output is supported'); }
function sha(s: string) { return createHash('sha256').update(s).digest('hex'); }
function leaseKeyPath(stateRoot: string, key: string) { return path.join(stateRoot, 'leases', 'keys', sha(key).slice(0, 32) + '.json'); }
async function readJson<T>(p: string): Promise<T | undefined> { try { return JSON.parse(await fs.readFile(p, 'utf8')) as T; } catch { return undefined; } }
async function writeUniqueJson(p: string, v: unknown) {
  await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
  const handle = await fs.open(p, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(redactForJson(v), null, 2) + '\n'); } finally { await handle.close(); }
}
async function main() {
  if (has('--version')) { needJson(); out({ schema_version: 1, name: '@bravo/codex-auth-balancer', version: pkg.version, capabilities: { codex_usage_json: 1, codex_refresh_usage_json: 1, codex_prepare_launch_json: 1, codex_sync_back_json: 1, codex_db_status_json: 1, codex_reservations_json: 1, codex_policy_json: 1, codex_token_lease: 1 } }); return; }
  const cmd = process.argv[2]; const stateRoot = resolveStateRoot();
  switch (cmd) {
    case 'usage': needJson(); out({ schema_version: 1, ...(await getUsage({ stateRoot })) }); break;
    case 'list': needJson(); out({ schema_version: 1, stateRoot, accounts: (await loadAccounts(stateRoot)).map(a => ({ slot: a.slot, idHash: a.idHash, hasPiAuth: !!a.piAuthPath, usage: a.usage })) }); break;
    case 'refresh-usage': needJson(); out({ schema_version: 1, ...(await refreshUsage({ stateRoot, all: has('--all'), slot: arg('--slot') })) }); break;
    case 'prepare-launch': { needJson(); const dir = arg('--isolated-dir'); if (!dir) throw new Error('--isolated-dir required'); out(await prepareLaunch(dir, { stateRoot, slot: arg('--slot'), runId: arg('--run-id'), rootRunId: arg('--root-run-id') })); break; }
    case 'sync-back': { needJson(); const dir = arg('--isolated-dir'); const slot = arg('--slot'); if (!dir || !slot) throw new Error('--isolated-dir and --slot required'); const r = await syncBack(dir, { stateRoot, slot }); if (r.ok) await cleanupLaunch(dir); out({ schema_version: 1, ...r }); break; }
    case 'db-status': needJson(); out({ schema_version: 1, ...(await getDbStatus({ stateRoot })) }); break;
    case 'reservations': needJson(); out({ schema_version: 1, stateRoot, reservations: await listReservations({ stateRoot, includeInactive: has('--all') }) }); break;
    case 'policy': needJson(); out({ schema_version: 1, stateRoot, ...(await getPolicy({ stateRoot })) }); break;
    case 'token': {
      const provider = arg('--provider');
      const leaseKey = arg('--lease-key');
      if (provider !== 'bravo-codex-balanced') throw new Error('--provider bravo-codex-balanced required');
      if (!leaseKey) throw new Error('--lease-key required');
      const p = leaseKeyPath(stateRoot, leaseKey);
      const existing = await readJson<{ expires_at?: number; finished?: boolean }>(p);
      if (existing && !existing.finished && (existing.expires_at ?? 0) > Date.now()) throw new Error('active lease-key already exists');
      if (existing) await fs.rm(p, { force: true });
      const lease = await startTokenLease({ provider: 'bravo-codex-balanced', model: arg('--model') || 'command-backed-token', purpose: 'command-backed-token', expected_runtime_ms: Number(arg('--expected-runtime-ms') || 240_000), ttl_safety_buffer_ms: Number(arg('--ttl-safety-buffer-ms') || 60_000), stateRoot, lease_key: leaseKey, preferred_slot: arg('--slot'), session_affinity_key: arg('--session-affinity-key') });
      try {
        await writeUniqueJson(p, { schema_version: 1, lease_key_hash: sha(leaseKey), lease_id: lease.lease_id, reservation_id: lease.reservation_id, launch_id: lease.launch_id, slot: lease.slot, model: lease.model, provider: lease.provider, expires_at: lease.expires_at, created_at: Date.now(), finished: false });
      } catch (error) {
        await finishTokenLease({ stateRoot, lease_id: lease.lease_id, reservation_id: lease.reservation_id, launch_id: lease.launch_id, status: 'failed', error_kind: 'lease_key_metadata_write_failed' }).catch(() => undefined);
        throw error;
      }
      process.stdout.write(`${lease.access_token}\n`);
      break;
    }
    case 'token-finish': {
      const leaseKey = arg('--lease-key');
      const status = arg('--status');
      if (!leaseKey) throw new Error('--lease-key required');
      if (status !== 'completed' && status !== 'failed' && status !== 'aborted' && status !== 'preflight_failed') throw new Error('--status must be completed, failed, aborted, or preflight_failed');
      const p = leaseKeyPath(stateRoot, leaseKey);
      const entry = await readJson<{ lease_id: string; reservation_id: string; launch_id: string; finished?: boolean }>(p);
      if (!entry) throw new Error('unknown lease-key');
      const result = await finishTokenLease({ stateRoot, lease_id: entry.lease_id, reservation_id: entry.reservation_id, launch_id: entry.launch_id, status });
      await fs.rm(p, { force: true });
      if (has('--json')) out(result);
      break;
    }
    default: throw new Error('unknown command');
  }
}
main().catch(e => { console.error(JSON.stringify({ schema_version: 1, error: String(e.message || e) })); process.exit(1); });
