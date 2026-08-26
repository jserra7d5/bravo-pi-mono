import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packages = {
  claude: '@bravo/claude-auth-balancer',
  codex: '@bravo/codex-auth-balancer',
} as const;

export class BalancerNotBuiltError extends Error {}

export function resolveBalancerCli(provider: keyof typeof packages): string {
  const pkg = packages[provider];
  let resolved: string;
  try { resolved = fileURLToPath(import.meta.resolve(pkg)); }
  catch { throw new BalancerNotBuiltError(`relogin: ${pkg} is not built; run npm run build in packages/${provider}-auth-balancer`); }
  const cli = path.join(path.dirname(resolved), 'cli.js');
  if (!existsSync(cli)) throw new BalancerNotBuiltError(`relogin: ${pkg} is not built; run npm run build in packages/${provider}-auth-balancer`);
  return cli;
}
