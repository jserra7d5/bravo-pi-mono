import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { combineChecks, exitCodeForCheck, renderHuman, type ProviderPayload } from '../src/check.js';

const NOW = Date.UTC(2026, 7, 25, 18, 2);
const DAY = 86_400_000;
test('T10 --check rendering golden includes healthy, warn, red, missing, and clustered real provider payloads', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'relogin-check-'));
  try {
    const authswap = path.join(root, 'authswap');
    const credentials = path.join(authswap, 'providers', 'anthropic', 'credentials');
    mkdirSync(credentials, { recursive: true });
    const claudeRows = [
      ['1', 'healthy@example.com', NOW + 20 * DAY], ['2', 'warn@example.com', NOW + 6 * DAY],
      ['3', 'red@example.com', NOW + DAY], ['5', 'cluster@example.com', NOW + 9 * DAY],
    ] as const;
    for (const [slot, email, deadline] of claudeRows) writeFileSync(
      path.join(credentials, `.credentials-${slot}-${email}.json`),
      JSON.stringify({ claudeAiOauth: { accessToken: 'access', refreshToken: 'refresh', expiresAt: NOW + DAY, refreshTokenExpiresAt: deadline } }),
    );
    writeFileSync(path.join(credentials, '.credentials-4-missing@example.com.json'), '{}');
    const codexRoot = path.join(root, 'codex'); const codexSlot = path.join(codexRoot, 'accounts', '1'); mkdirSync(codexSlot, { recursive: true });
    const idToken = `e30.${Buffer.from(JSON.stringify({ auth_time: (NOW - 5 * DAY) / 1000, 'https://api.openai.com/profile.email': 'codex@example.com' })).toString('base64url')}.sig`;
    writeFileSync(path.join(codexSlot, 'auth.json'), JSON.stringify({ tokens: { id_token: idToken, access_token: 'access', refresh_token: 'refresh', account_id: 'acct', expiry_date: NOW + 4 * DAY } }));
    const run = (source: string) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' })) as ProviderPayload;
    const claude = run(`import {checkClaude} from ${JSON.stringify(new URL('../../../claude-auth-balancer/dist/src/relogin.js', import.meta.url).href)}; console.log(JSON.stringify({accounts:checkClaude(${NOW},${JSON.stringify(authswap)})}))`);
    const codex = run(`import {checkCodex} from ${JSON.stringify(new URL('../../../codex-auth-balancer/dist/src/relogin.js', import.meta.url).href)}; console.log(JSON.stringify(checkCodex(${JSON.stringify(codexRoot)},${NOW})))`);
    const check = combineChecks(claude, codex, NOW);
  const rendered = renderHuman(check, { color: false, timezone: 'UTC' });
  const expected = `relogin --check                                              2026-08-25 18:02 +00

claude   slot  account                                deadline      in     last login
         1     healthy@example.com                   Sep 14 18:02 20.0d  Aug 15
         2     warn@example.com                      Aug 31 18:02 6.0d   Aug 01
         3     red@example.com                       Aug 26 18:02 1.0d   Jul 27
         4     missing@example.com                   —            —      —
         5     cluster@example.com                   Sep 03 18:02 9.0d   Aug 04

codex    slot  account                                deadline      in     last login
         1     codex@example.com                     —            —      Aug 20

fail  claude slot 4 no credential                relogin claude 4
warn  claude slot 2 due in 6.0d                  relogin claude 2
warn  claude slot 3 due in 1.0d                  relogin claude 3
warn  claude slots 2 and 5 fall 3.0d apart; stagger one of them

3 slots healthy, 2 need attention, 1 dead.`;
    assert.equal(rendered, expected);
    assert.equal(exitCodeForCheck(check), 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
