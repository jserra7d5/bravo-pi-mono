#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolveStateRoot } from './index.js';

function spawnPi(args: string[], env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PI_BALANCED_PI_BIN || 'pi', args, { env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
}

async function main(): Promise<void> {
  if (process.env.BRAVO_PI_BALANCED === '1') throw new Error('refusing nested pi-balanced launch');
  // The interactive `pi` already loads the bravo-codex-balanced provider (via
  // ~/.pi/agent/settings.json) and leases short-lived access tokens per request under the
  // hardened withRefreshLock. So this launcher no longer copies a slot's refresh token into an
  // isolated dir (the old racy, lock-free rotation path) nor syncs anything back: it is a thin
  // pass-through that just marks the process so a nested launch is refused and points the
  // provider at the right state root. argv is forwarded UNCHANGED so the user's config/--model
  // decides the model (the default already routes to balanced).
  const root = process.env.CODEX_AUTH_BALANCER_HOME ?? resolveStateRoot();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BRAVO_PI_BALANCED: '1',
    CODEX_AUTH_BALANCER_HOME: root,
  };
  process.stderr.write(`[pi-balanced] routing through bravo-codex-balanced provider (state: ${root})\n`);
  const code = await spawnPi(process.argv.slice(2), env);
  process.exitCode = code ?? 1;
}

await main();
