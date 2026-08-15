import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** Selects Claude's API-key auth mode; stripped by the local proxy, never secret. */
export const GATEWAY_API_KEY_SENTINEL = 'claude-auth-balancer-local-gateway';

export type LaunchClaudeOptions = {
  args: string[];
  baseUrl: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stdio?: 'inherit' | 'pipe';
  /** Absolute path of this CLI, excluded from PATH resolution to prevent recursion. */
  selfPath?: string;
};

export type LaunchResult = { code: number | null; signal: NodeJS.Signals | null };

function validateBaseUrl(baseUrl: string): void {
  let gateway: URL;
  try { gateway = new URL(baseUrl); } catch { throw new Error(`invalid gateway URL: ${baseUrl}`); }
  if (gateway.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(gateway.hostname)) {
    throw new Error('gateway URL must be loopback HTTP');
  }
}

async function executable(file: string): Promise<boolean> {
  try { await access(file, constants.X_OK); return true; } catch { return false; }
}

/** Resolve the real Claude executable, with an explicit override for wrappers/nvm. */
export async function resolveClaudeBin(env: NodeJS.ProcessEnv, selfPath?: string): Promise<string> {
  const override = env.CLAUDE_BIN;
  if (override) {
    if (!path.isAbsolute(override)) throw new Error('CLAUDE_BIN must be an absolute path');
    if (!await executable(override)) throw new Error(`CLAUDE_BIN is not executable: ${override}`);
    return override;
  }

  let selfReal: string | undefined;
  if (selfPath) {
    try { selfReal = await realpath(selfPath); } catch { selfReal = path.resolve(selfPath); }
  }
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(dir, 'claude');
    if (!await executable(candidate)) continue;
    let candidateReal: string;
    try { candidateReal = await realpath(candidate); } catch { candidateReal = candidate; }
    if (selfReal && candidateReal === selfReal) continue;
    return candidate;
  }
  throw new Error('could not find a real claude executable; set CLAUDE_BIN to its absolute path');
}

/** Launch Claude with gateway selection scoped to the child process only. */
export async function launchClaude(options: LaunchClaudeOptions): Promise<LaunchResult> {
  validateBaseUrl(options.baseUrl);
  const env = options.env ?? process.env;
  const bin = await resolveClaudeBin(env, options.selfPath);
  const child = spawn(bin, options.args, {
    cwd: options.cwd ?? process.cwd(),
    env: {
      ...env,
      ANTHROPIC_BASE_URL: options.baseUrl,
      ANTHROPIC_API_KEY: GATEWAY_API_KEY_SENTINEL,
    },
    stdio: options.stdio ?? 'inherit',
  });
  return new Promise((resolve, reject) => {
    const forwards = new Map<NodeJS.Signals, () => void>();
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      const forward = () => child.kill(signal);
      forwards.set(signal, forward);
      process.on(signal, forward);
    }
    const cleanup = () => {
      for (const [signal, forward] of forwards) process.off(signal, forward);
    };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => { cleanup(); resolve({ code, signal }); });
  });
}
