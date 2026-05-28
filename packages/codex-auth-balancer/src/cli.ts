#!/usr/bin/env node
import { cleanupLaunch, getUsage, importAuthswap, loadAccounts, prepareLaunch, redactForJson, refreshUsage, resolveStateRoot, syncBack } from './index.js';
import pkg from '../package.json' with { type: 'json' };

function arg(name: string) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }
function has(name: string) { return process.argv.includes(name); }
function out(v: unknown) { console.log(JSON.stringify(redactForJson(v), null, 2)); }
function needJson() { if (!has('--json')) throw new Error('only --json output is supported'); }
async function main() {
  if (has('--version')) { needJson(); out({ schema_version: 1, name: '@bravo/codex-auth-balancer', version: pkg.version, capabilities: { codex_usage_json: 1, codex_refresh_usage_json: 1, codex_prepare_launch_json: 1, codex_sync_back_json: 1 } }); return; }
  const cmd = process.argv[2]; const stateRoot = resolveStateRoot();
  switch (cmd) {
    case 'usage': needJson(); out({ schema_version: 1, ...(await getUsage({ stateRoot })) }); break;
    case 'list': needJson(); out({ schema_version: 1, stateRoot, accounts: (await loadAccounts(stateRoot)).map(a => ({ slot: a.slot, idHash: a.idHash, hasPiAuth: !!a.piAuthPath, usage: a.usage })) }); break;
    case 'refresh-usage': needJson(); out({ schema_version: 1, ...(await refreshUsage({ stateRoot, all: has('--all'), slot: arg('--slot') })) }); break;
    case 'prepare-launch': { needJson(); const dir = arg('--isolated-dir'); if (!dir) throw new Error('--isolated-dir required'); out(await prepareLaunch(dir, { stateRoot, slot: arg('--slot') })); break; }
    case 'sync-back': { needJson(); const dir = arg('--isolated-dir'); const slot = arg('--slot'); if (!dir || !slot) throw new Error('--isolated-dir and --slot required'); const r = await syncBack(dir, { stateRoot, slot }); if (r.ok) await cleanupLaunch(dir); out({ schema_version: 1, ...r }); break; }
    case 'import-authswap': { needJson(); out({ schema_version: 1, ...(await importAuthswap(arg('--from'), { stateRoot, dryRun: has('--dry-run'), overwrite: has('--overwrite'), slot: arg('--slot') })) }); break; }
    default: throw new Error('unknown command');
  }
}
main().catch(e => { console.error(JSON.stringify({ schema_version: 1, error: String(e.message || e) })); process.exit(1); });
