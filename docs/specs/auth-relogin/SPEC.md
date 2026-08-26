# `relogin` — one command to reset an OAuth session window

Status: specified, not implemented.
Owner packages: `@bravo/auth-relogin` (new), `@bravo/claude-auth-balancer`, `@bravo/codex-auth-balancer`, `.pi/extensions/codex-usage.ts`.

## 1. Problem

Both balancers keep *access* tokens alive without a human. Neither can keep a
*session* alive.

- **Claude.** The refresh token has a hard ~30-day life anchored to the last
  interactive login. Refreshing does not extend it: the server returns
  `refresh_token_expires_in` on every refresh response and the value keeps
  counting down from the original login. Observed at spec time: slot 1 refreshed
  hours ago and has 5.5 days of refresh-token life left. `refreshTokenExpiresAt`
  is read in exactly one place today — `isRefreshable()` in
  `packages/claude-auth-balancer/src/accounts.ts` — as a binary already-dead
  test. Lead time is surfaced nowhere. The first symptom of a dying slot is the
  slot going dead.
- **Codex.** No hard deadline is discoverable from the credential (see §3.2),
  but the recovery path is worse than Claude's: the only documented relogin
  recipe is `codex login --device-auth`, which is **destructive-first** — it
  deletes `accounts/<slot>/auth.json` the instant the flow starts, before any
  token exchange. An abandoned or timed-out login leaves the slot with no
  credential and a probably-revoked refresh token. This happened during spec
  work: `~/.bravo/codex-auth-balancer/accounts/3/` currently has no `auth.json`.
- **Both.** The recovery recipe is a multi-line incantation involving
  `CODEX_HOME`/`CLAUDE_CONFIG_DIR` scratch dirs, copy steps, and two traps
  (`codex login` without `--device-auth` cannot complete headless; the pi
  extension's `/reauth` runs `codex logout` first and revokes the refresh token
  server-side). It lives in memory files, not in a command.

Plus one live bug: a persisted `refresh-terminal` warning under
`<stateRoot>/state/auth-health/refresh/<slot>.json` is only cleared from inside
a refresh attempt (`src/refresh.ts`, `emit()` and `ensureFresh()`), and
`TokenRefresher.sweep()` skips any slot outside `REFRESH_SKEW_MS` (30 min before
expiry). After an out-of-band re-login the stale "needs login" warning survives
in `status` and the statusline for up to ~12h.

Goal: one command, `relogin <provider> <slot>`, that is safe to run at any time,
never leaves a slot worse than it found it, and a `--check` that says which slot
to run it on and when.

## 2. Runtime invariants

These are the assertions the implementation exists to uphold. Each is named in
the test plan (§9).

- **I1 — non-destructive failure (codex).** For any exit of `relogin codex <n>`
  other than a verified success, `accounts/<n>/auth.json` is byte-identical to
  its pre-flight content. This holds for a non-zero child exit, a timeout,
  SIGINT, SIGTERM, and SIGKILL of the relogin process itself.
- **I2 — non-destructive failure (claude).** For any non-success exit of
  `relogin claude <n>`, the slot credential file
  `.credentials-<n>-<email>.json` is byte-identical to its pre-flight content.
  The interactive login writes only into a scratch dir; the slot file is touched
  once, at the end, under the same lock the refresher uses.
- **I3 — identity pinning.** A relogin that produces a credential for a
  different account than the slot already held is a failure, not a success. The
  slot is restored and a non-zero exit is returned. Claude compares
  `oauthAccount.emailAddress` from the scratch `.claude.json` against the email
  encoded in the slot filename; codex compares `tokens.account_id` (falling back
  to the `https://api.openai.com/profile.email` claim of `tokens.id_token`)
  against the backup.
- **I4 — no silent no-op (claude).** `relogin claude <n>` without `--if-needed`
  always performs an interactive login. A successful refresh is not an
  acceptable substitute: it leaves the original 30-day clock intact, which is
  precisely what the user ran the command to reset.
- **I5 — warning freshness.** A persisted refresh warning is not displayed once
  the slot's credential has an `expiresAt` newer than the warning's `at`.
- **I6 — single writer.** Every write to a claude slot credential file happens
  while holding `<credentialPath>.refresh.lock`; every write to a codex slot
  `auth.json` happens under the codex per-slot refresh lock
  (`withRefreshLock`). relogin takes the same locks the refreshers take.
- **I7 — crash recovery is idempotent.** A leftover
  `accounts/<n>/auth.json.relogin-backup` means a previous relogin died. The
  next relogin (or `--check`) restores it before doing anything else, and this
  is safe to run repeatedly.

## 3. Per-provider ground truth

### 3.1 Claude

- Credentials: `~/.authswap/providers/anthropic/credentials/.credentials-<slot>-<email>.json`,
  shape `{ claudeAiOauth: { accessToken, refreshToken, expiresAt,
  refreshTokenExpiresAt, scopes, subscriptionType, ... } }`.
  Discovery: `discoverAccounts()` / `readOAuth()` in `src/accounts.ts`.
- Interactive login: `CLAUDE_CONFIG_DIR=<scratch> claude`, then `/login` in the
  TUI. On success the scratch dir contains `.credentials.json` (same
  `claudeAiOauth` shape) and `.claude.json` with `oauthAccount.emailAddress`.
- The deadline is `claudeAiOauth.refreshTokenExpiresAt`. Live at spec time:
  slot 1 Aug 31, slot 2 Sep 23, slot 3 Sep 20.

### 3.2 Codex

- Slots: `~/.bravo/codex-auth-balancer/accounts/<slot>/`. Everything in the slot
  dir is a symlink into `~/.codex` except `auth.json`, which is a real file.
- `auth.json` shape: `{ auth_mode, OPENAI_API_KEY, tokens: { id_token,
  access_token, refresh_token, account_id, accountId, expiry_date },
  last_refresh }`.
- There is **no** `pi-openai-codex.json` on disk. The pi auth file is derived at
  launch time by `piAuthStorageForCredential()`
  (`packages/codex-auth-balancer/src/index.ts`). Nothing writes a sibling file
  that must be kept in sync, and relogin must not create one.
- **There is no refresh-token deadline field.** The refresh token rotates on
  every exchange (single-use, reuse-detected) and carries no published hard
  life. The only durable login anchor in the credential is the `auth_time` claim
  of `tokens.id_token`, which is *not* rewritten by a refresh — verified live:
  slot 1 has `auth_time == iat` (its Aug 6 relogin), slot 2 has an `auth_time`
  ~10 days older than its `iat`. So codex gets "last login N days ago", not a
  countdown. See decision D2.
- Non-interactive refresh: `ensureFreshTokens()` in `src/index.ts` — the
  balancer's own owned exchange (`refreshCodexToken`), under the per-slot lock,
  with an atomic write-back. Preferred over shelling out to
  `codex exec --skip-git-repo-check`, which spends real quota to do the same
  thing. (`codex login status` does not refresh at all.)
- Interactive login: `CODEX_HOME=<slotdir> codex login --device-auth`. Prints a
  URL and a one-time code, 15-minute TTL. Plain `codex login` binds a localhost
  callback and cannot complete headless. The pi extension's `/reauth` runs
  `codex logout` first and revokes the refresh token server-side — it is deleted
  by this change (§8.4).
- The child writes `accounts/<slot>/log/codex-login.log`; a completed flow
  contains `oauth token exchange succeeded status=200`. Used only as a
  diagnostic in failure messages — success is decided by reading `auth.json`.

### 3.3 Why there is no shared adapter

The two flows share a noun and nothing else:

| | claude | codex |
|---|---|---|
| login transport | full-TTY child (`claude` TUI, user types `/login`) | device-code, line-oriented output |
| destructiveness | none; writes to a scratch dir | deletes the live credential first |
| install step | copy scratch `.credentials.json` into the slot file | child writes the slot file in place |
| deadline | hard `refreshTokenExpiresAt` | none; only a login anchor |
| `--if-needed` | refuse-to-skip unless deadline is far out | plain non-interactive refresh |
| identity check | email from `.claude.json` | `account_id` from `auth.json` |

Each balancer owns a `relogin` subcommand. `relogin` itself is a thin dispatcher
that resolves and spawns the right balancer CLI. No shared interface.

## 4. Package ownership of the `relogin` bin

**New package `packages/auth-relogin`**, `bin: { "relogin": "./dist/src/cli.js" }`,
depending on `@bravo/auth-balancer-contract` (for `AUTH_BALANCER_PROVIDERS`) and
on both balancers via `file:` deps for resolution only.

Rejected alternatives, and why. Putting the bin in `claude-auth-balancer` would
make the Claude balancer depend on the Codex balancer, a dependency that does not
exist today and that exists purely so one CLI can spawn another — the Claude
package would then fail to build without Codex present. Putting it in
`auth-balancer-contract` inverts the dependency graph: the contract package is
consumed *by* both balancers and is declared policy-free; teaching it the bin
paths of its own consumers makes it the top of the graph and the bottom at once.
Rendering `--check` also needs to read both providers' state, which neither
balancer can do without importing the other. A ~200-line third package is the
only shape where the dependency arrows all point one way, and it is where the
`--check` cross-provider rendering naturally lives.

Resolution of the balancer CLIs is by node module resolution, not PATH:
`fileURLToPath(import.meta.resolve('@bravo/claude-auth-balancer'))` →
`dist/src/index.js` → sibling `dist/src/cli.js`; same for codex. If the resolved
file does not exist, exit 2 with `relogin: <pkg> is not built; run npm run build
in packages/<pkg>`. Children are spawned as
`spawn(process.execPath, [cliPath, ...args], { stdio: 'inherit' })` so the
interactive child owns the terminal, and the dispatcher exits with the child's
exit code (re-raising the child's signal if it was signalled).

## 5. CLI surface

### 5.1 `relogin --help` (verbatim)

```
relogin — reset the OAuth session window for one balancer slot.

usage:
  relogin <claude|codex> <slot>              interactive re-login (always logs in)
  relogin <claude|codex> <slot> --if-needed  refresh first; log in only if that fails
  relogin --check [--json]                   deadlines for every slot, both providers
  relogin --help

why:
  Access tokens refresh themselves. Sessions do not. A Claude refresh token dies
  ~30 days after the interactive login that created it, and refreshing does NOT
  extend that clock — only logging in again does. Codex has no published
  deadline but its refresh chain can be revoked, and the recovery flow deletes
  the credential before it replaces it.

flags:
  --if-needed   Try a non-interactive refresh first. claude: skips the login only
                if the refresh-token deadline is more than 7 days out AND a
                forced refresh succeeds. codex: skips the login if a forced token
                refresh succeeds. Without this flag a login always happens.
  --json        Only valid with --check. The interactive flows own the terminal
                and emit no machine output.

safety:
  A failed, timed-out, or interrupted relogin always leaves the slot exactly as
  it was. Codex logins are destructive-first, so the credential is backed up
  before the flow starts and restored on any non-success exit — including a kill
  of this process (the backup is recovered on the next run).

exit codes:
  0  success (or --check found nothing past the warn threshold)
  1  relogin failed; the slot is unchanged
  2  usage error, or a balancer is not built
  3  --check found at least one slot inside the red threshold (< 2 days)
  4  the login was aborted or timed out; the slot is unchanged

examples:
  relogin --check
  relogin claude 1
  relogin codex 3
  relogin claude 2 --if-needed
```

### 5.2 `relogin --check` — exact human rendering

Column widths are fixed. `deadline` is `refreshTokenExpiresAt` for claude and
`—` for codex (no such field exists; see D2). `last login` is derived from
`refreshTokenExpiresAt - 30d` for claude and from the `id_token` `auth_time`
claim for codex. Colour: default for OK, yellow for `< 7d`, red for `< 2d`,
`DEAD`, or a missing credential. Colour is emitted only when
`process.stdout.isTTY`.

```
relogin --check                                              2026-08-25 14:02 -04

claude   slot  account                                deadline      in     last login
         1     info@notanotherdashboard.com           Aug 31 03:33   5.6d   Aug 01
         2     joseph.b.serra@gmail.com               Sep 23 21:58  29.3d   Aug 24
         3     progamer5051@gmail.com                 Sep 20 19:13  26.2d   Aug 21

codex    slot  account                                deadline      in     last login
         1     progamer5051@gmail.com                 —              —      Aug 06
         2     joseph.b.serra@gmail.com               —              —      Jul 26
         3     (no credential)                        —              —      —

warn  claude slot 1 is due in 5.6d               relogin claude 1
warn  claude slots 2 and 3 fall 3.1d apart; stagger one of them
fail  codex slot 3 has no credential             relogin codex 3

3 slots healthy, 2 need attention, 1 dead.
```

Rules for the summary block, in this order:

1. One `fail` line per slot with no credential, an expired deadline, or a
   leftover `auth.json.relogin-backup` that could not be restored.
2. One `warn` line per slot inside 7 days.
3. One `warn` line per pair of claude slots whose deadlines are within
   `CLUSTER_WINDOW_MS` (5 days) of each other. Pairs are reported once, lowest
   slot first, and only when both deadlines are known.
4. The count line. Always printed, even when everything is healthy, so a
   healthy run is visibly a run and not a silent failure.

With no summary lines, the count line reads
`6 slots healthy, 0 need attention, 0 dead.`

### 5.3 `relogin --check --json`

```json
{
  "schema_version": 1,
  "generated_at": 1787000000000,
  "worst": "warn",
  "providers": {
    "claude": [
      {
        "slot": "1",
        "account": "info@notanotherdashboard.com",
        "deadline_at": 1788000794813,
        "deadline_in_ms": 484992000,
        "last_login_at": 1785408794813,
        "level": "warn",
        "reason": "due in 5.6d",
        "command": "relogin claude 1"
      }
    ],
    "codex": [
      {
        "slot": "3",
        "account": null,
        "deadline_at": null,
        "deadline_in_ms": null,
        "last_login_at": null,
        "level": "fail",
        "reason": "no credential",
        "command": "relogin codex 3"
      }
    ]
  },
  "clusters": [
    { "provider": "claude", "slots": ["2", "3"], "apart_ms": 267840000 }
  ]
}
```

`level` is one of `ok` | `warn` | `fail`. `worst` is the max over all slots.
Exit code follows `worst`: `ok`/`warn` → 0, `fail` or any `deadline_in_ms <
RED_MS` → 3.

### 5.4 Balancer subcommands (what the dispatcher spawns)

- `claude-auth-balancer relogin <slot> [--if-needed]` — human output, inherits
  all three stdio. No `--json`.
- `claude-auth-balancer relogin --check-json` — one JSON object on stdout,
  the claude half of §5.3. Used only by the dispatcher.
- `codex-auth-balancer relogin --slot <slot> [--if-needed] --json` — obeys the
  package's strict JSON-out convention (`needJson()`, `schema_version: 1`): the
  final result object is the only thing on stdout. The `codex login
  --device-auth` child's stdout and stderr are both mirrored to *stderr*, so the
  human sees the URL and code without polluting the JSON stream.
- `codex-auth-balancer relogin --check --json` — the codex half of §5.3.

The dispatcher renders §5.2 from the two `--check` payloads. For an interactive
run it just forwards stdio and, for codex, parses the trailing JSON line to
print the one-line human result and the staggering warning.

## 6. Flows

### 6.1 `relogin claude <slot>`

```
resolve slot -> Account via discoverAccounts()          fail -> exit 2 "unknown slot"
read current oauth via readOAuth()                      absent -> continue (a dead
                                                        slot is exactly the case
                                                        relogin exists for)
if --if-needed:
    deadline = oauth.refreshTokenExpiresAt
    if deadline - now > WARN_MS (7d):
        run TokenRefresher.ensureFresh(account) with forced skew
        on 'refreshed' | 'fresh'  -> print "slot N is fine (deadline in X d);
                                     not logging in" ; exit 0
    (otherwise fall through to the login: a refresh cannot move the deadline)

scratch = mkdtemp(<stateRoot>/tmp/relogin-claude-<slot>-XXXX, mode 0700)
print the two-line instruction (see below)
spawn CLAUDE_CONFIG_DIR=<scratch> claude   stdio inherit
      SIGINT/SIGTERM in the parent are forwarded to the child, then treated as abort

on child exit:
    read <scratch>/.credentials.json          missing/unparseable -> exit 4 "no
                                              login was completed"
    validate claudeAiOauth.accessToken, .refreshToken, .refreshTokenExpiresAt > now
                                              invalid -> exit 1
    read <scratch>/.claude.json -> oauthAccount.emailAddress
    if email !== account.email                -> exit 1 "logged in as <x>, slot N
                                                 holds <y>; slot unchanged" (I3)
    acquireLock(account.credentialPath)        busy -> retry 5x/2s, then exit 1
    raw = readFileSync(account.credentialPath) (or '{}' if the slot file is gone)
    writeCredentialFile(path, mergeCredentialFile(raw, tokensFromScratch))
    releaseLock
    setRefreshWarning(stateRoot, slot)         // clear any stale warning
rm -rf scratch (always, including on every failure path)
print the result line + any staggering warning
```

The slot file is written exactly once, at the very end, through the existing
`mergeCredentialFile()` + `writeCredentialFile()` (tmp + rename) in
`src/refresh.ts`. Everything before that touches only the scratch dir — that is
how I2 holds without a backup/restore dance.

Instruction printed before the child starts, verbatim:

```
Logging in to claude slot 1 (info@notanotherdashboard.com).
Type /login in the Claude session that opens, finish in the browser, then /exit.
Your existing credential is untouched until the new one is verified.
```

### 6.2 `relogin codex <slot>`

```
slotDir  = <stateRoot>/accounts/<slot>       missing -> exit 2
authPath = <slotDir>/auth.json
backup   = <slotDir>/auth.json.relogin-backup

--- crash recovery, runs first, always (I7) ---
if backup exists:
    if authPath missing or unparseable: rename(backup -> authPath)   [restored]
    else: unlink(backup)                                              [stale]

if --if-needed:
    ensureFreshTokens({ stateRoot, slot, force: true })
    action 'refreshed' | 'adopted' | 'fresh' -> print + exit 0
    otherwise fall through

--- pre-flight backup (I1) ---
if authPath exists: copyFile(authPath, backup, COPYFILE_EXCL-ish: overwrite ok
                             after the recovery step above); fsync; chmod 0600
identity_before = account_id / profile.email from the backup (undefined if none)

install restore handlers BEFORE spawning:
    process.on('SIGINT'|'SIGTERM'|'uncaughtException'|'exit') -> restore()
    restore(): if backup exists -> rename(backup -> authPath); this is atomic and
               idempotent, and safe to call from an exit handler.
    (SIGKILL of this process is covered by the crash-recovery step above, not by
     a handler.)

spawn CODEX_HOME=<slotDir> codex login --device-auth
      stdin inherited; child stdout AND stderr piped -> mirrored to our stderr
      line by line; timeout DEVICE_AUTH_TIMEOUT_MS = 16 min (the code TTL is 15)

on non-zero exit / timeout / signal:
    restore(); exit 4 (timeout or signal) or 1 (non-zero exit), message includes
    the last line of <slotDir>/log/codex-login.log if it exists

on exit 0:
    read authPath -> must parse, must have tokens.refresh_token and
                     tokens.access_token                  else restore(); exit 1
    identity_after vs identity_before                     mismatch -> restore();
                                                          exit 1 (I3)
    unlinkSync(backup)                          // point of no return
    unbrickSlot(stateRoot, slot)
    clear the proactive_refresh:<slot> failure record
    refreshUsage({ stateRoot, slot })           // best-effort; a failure here is
                                                // a warning, not a failed relogin
    exit 0
```

Note the ordering: the backup is deleted only after the new credential has been
read back and its identity verified. Between the child's exit and that unlink,
both a valid new credential and the old backup exist, and the restore handler is
still armed — so a crash in that window restores the old credential rather than
leaving a half-verified one.

### 6.3 Staggering warning after a successful relogin

Only meaningful for claude (codex has no deadline). After a success, read every
claude slot's `refreshTokenExpiresAt` and, if the new deadline is within
`CLUSTER_WINDOW_MS` (5 days) of another slot's, print:

```
warn  slot 1's new deadline (Sep 24) is 1.8d from slot 2's (Sep 23).
      Two slots will die in the same week. Consider re-logging one of them
      early to spread them out.
```

## 7. Constants

Defined once in `packages/auth-relogin/src/thresholds.ts` and imported by both
balancers, so `--check`, `status`, and the statuslines cannot drift apart.

| name | value | meaning |
|---|---|---|
| `WARN_MS` | 7d | yellow; `--check` emits a warn line |
| `RED_MS` | 2d | red; `--check` exits 3 |
| `CLUSTER_WINDOW_MS` | 5d | two deadlines this close are clustered |
| `DEVICE_AUTH_TIMEOUT_MS` | 16 min | one minute past the device-code TTL |
| `CLAUDE_REFRESH_WINDOW_MS` | 30d | only for deriving "last login" for display |

`auth-balancer-contract` is not the right home: it is the integrity contract
(literals, attempt validation, redaction), and these are display/policy
thresholds.

## 8. File-by-file changes

### 8.1 New: `packages/auth-relogin`

- `package.json` — `bin: { "relogin": "./dist/src/cli.js" }`, deps on
  `@bravo/auth-balancer-contract`, `@bravo/claude-auth-balancer`,
  `@bravo/codex-auth-balancer` (all `file:`), `build` script chmods the bin, in
  line with the other two packages.
- `src/thresholds.ts` — §7.
- `src/resolve.ts` — `resolveBalancerCli('claude'|'codex'): string`, per §4.
- `src/check.ts` — merges the two `--check` payloads, computes clusters, and
  renders §5.2 / §5.3. Pure functions over a payload object; no I/O, so the
  golden tests do not need a fake terminal.
- `src/cli.ts` — argument parsing, `--help` (§5.1 verbatim), dispatch, exit-code
  mapping, signal forwarding.

### 8.2 `packages/claude-auth-balancer`

- `src/accounts.ts` — add `refreshTokenExpiresAt` to the `AccountState` produced
  by `loadAccountStates()` (the field is already on `ClaudeOAuth`; it is simply
  dropped on the way into the state). No behaviour change to `isRefreshable()`.
- `src/relogin.ts` (new) — the §6.1 flow. Reuses `discoverAccounts`,
  `readOAuth`, `mergeCredentialFile`, and the lock helpers. `acquireLock` /
  `releaseLock` / `writeCredentialFile` in `src/refresh.ts` become exported (they
  are module-private today) rather than being reimplemented — two lock
  implementations for one file is exactly the race the lock exists to prevent.
- `src/cli.ts` — new `relogin` command and `--check-json`; add both to the usage
  text in the `default:` branch. `cmdStatus()` gains a `relogin` column showing
  days until `refreshTokenExpiresAt`, coloured on `WARN_MS`/`RED_MS`.
  `cmdAccounts()` gains the same value inline.
- `src/health.ts` — new
  `readActiveAuthWarnings(stateRoot, accounts, nowMs): AuthWarning[]`: reads the
  warnings as today, then drops any whose slot credential has
  `expiresAt > warning.at`. This is the §1 bug fix (I5). It is a **filter, not a
  delete** — the read paths include the statusline, which runs every turn, and a
  write in a hot read path buys nothing here. The stale file is removed for real
  the next time the refresher writes that slot, or by relogin's explicit
  `setRefreshWarning(stateRoot, slot)` clear.
- `src/cli.ts` + `src/statusline.ts` — replace both
  `conciseWarnings(readAuthWarnings(stateRoot))` call sites with
  `readActiveAuthWarnings`. `readAuthWarnings` stays exported only because
  `readActiveAuthWarnings` is built on it; there is no second display path.
- `src/statusline.ts` — `AccountView` gains
  `refreshTokenExpiresAt?: number`, populated from `readOAuth()` in the same loop
  that already computes `needsReauth`.
- `src/statusline-render.ts` — render the countdown next to the account label
  when it is inside `WARN_MS` (yellow) or `RED_MS` (red), as `relogin 5d`. It is
  invisible outside the warn window, so the normal line does not get longer, and
  it is dropped before the bars in the existing overflow order.

### 8.3 `packages/codex-auth-balancer`

- `src/index.ts` — `ensureFreshTokens()` gains an optional `slot?: string`
  option that filters the scanned accounts. Everything else in that function is
  unchanged; `--if-needed` needs to refresh one slot, not all of them.
- `src/relogin.ts` (new) — the §6.2 flow, including crash recovery, the restore
  handlers, and identity comparison. Exports
  `reloginCodexSlot(opts): Promise<ReloginResult>` and
  `recoverAbandonedRelogin(stateRoot, slot): 'restored' | 'stale' | 'none'`.
- `src/cli.ts` — `relogin` command per §5.4, strictly `--json` out, with the
  child's output mirrored to stderr. Add `codex_relogin_json: 1` to the
  `--version` capabilities map.

### 8.4 `.pi/extensions/codex-usage.ts` — delete `/reauth`

Clean cutover, no dual path. Remove `REAUTH_TIMEOUT_MS`, `AUTH_URL_RE`,
`runCodexCmd`, `ReauthResult`, `reauthSlot`, and the
`pi.registerCommand("reauth", ...)` block. `reauthSlot` is not merely redundant
with the new command, it is actively harmful: it runs `codex logout` (revoking
the refresh token server-side), then plain `codex login` (which cannot complete
over SSH), then writes a `pi-openai-codex.json` that nothing on disk should have.

`codexHealthWarnings()` keeps its shape but its advice becomes the command:

```
Codex slot 2 cannot refresh itself and expires 2d — run: relogin codex 2
```

Its tests in `.pi/extensions/__tests__/codex-usage.test.ts` move with it: the
`--device-auth` assertion at line ~845 is replaced by an assertion that the
warning names the exact command to run. Any test of `reauthSlot` is deleted, not
ported.

## 9. Test plan

Each entry names the seam and what is faked at it. Nothing is faked at a
decision seam; there is no in-memory credential store anywhere.

**T1 — codex, killed mid-flight (I1, the fault that matters most).**
Seam: a real executable `codex` script placed first on `PATH` in the test's env,
which does exactly what the real one does — `rm auth.json`, print a device URL,
then sleep. Test: record `sha256(auth.json)`, spawn `relogin codex 1` as a real
child process, wait for the log line proving the delete happened, `SIGKILL` the
relogin process, then run `relogin codex 1 --check`-equivalent recovery and
assert `auth.json` exists with the identical sha256. Runs three times: SIGKILL,
SIGINT, and SIGTERM. Uses a real temp `CODEX_AUTH_BALANCER_HOME`.

**T2 — codex, child fails after deleting.** Same fake `codex`, exits 1 after the
delete. Assert in-process restore: identical sha256, exit code 1, backup file
gone.

**T3 — codex, wrong account (I3).** Fake `codex` writes a syntactically valid
`auth.json` with a different `tokens.account_id`. Assert restore to the original
bytes and exit 1.

**T4 — codex, happy path.** Fake `codex` writes a valid `auth.json` with the
matching `account_id`. Assert exit 0, no `.relogin-backup` left, the slot has the
new bytes, and the broken snapshot for that slot has been cleared.

**T5 — codex `--if-needed`.** Real `ensureFreshTokens` against a real local HTTP
token endpoint (the pattern `packages/claude-auth-balancer/test/refresh.test.ts`
already uses: only the host is redirected). Two runs: endpoint returns 200 →
exit 0 and `codex` is never spawned (a fake `codex` on PATH that writes a
tripwire file proves it); endpoint returns 400 `invalid_grant` → falls through to
the login path.

**T6 — claude, slot untouched on failure (I2).** Fake `claude` executable on
PATH that (a) exits 1 without writing anything, (b) writes a malformed
`.credentials.json`, (c) writes a valid credential under a different
`oauthAccount.emailAddress`. All three: slot file byte-identical, exit non-zero,
scratch dir removed.

**T7 — claude, happy path.** Fake `claude` writes a valid scratch
`.credentials.json` + `.claude.json` with the matching email. Assert the slot
file is merged (unknown top-level keys and unmodelled `claudeAiOauth` fields such
as `subscriptionType` survive — the existing `mergeCredentialFile` guarantee),
mode `0600`, no `.refresh.lock` left behind, and any pre-existing
`refresh-terminal` warning file cleared.

**T8 — claude `--if-needed` never silently no-ops (I4).** Deadline 20 days out
and a live token endpoint → exit 0 without spawning `claude` (tripwire).
Deadline 3 days out → `claude` IS spawned even though the refresh would have
succeeded. Deadline 20 days out but the endpoint returns 400 → `claude` is
spawned.

**T9 — stale warning is not displayed (I5).** Real temp state root. Write a
`refresh-terminal` warning at `T`; write a credential file with
`expiresAt = T + 1h` → `readActiveAuthWarnings` returns `[]`. With
`expiresAt = T - 1h` → the warning is returned. With no credential file at all →
the warning is returned (a vanished credential is a real problem).

**T10 — `--check` rendering golden.** Build a real temp authswap dir and a real
temp codex state root with: one healthy slot, one inside `WARN_MS`, one inside
`RED_MS`, one with no credential, and one pair 3 days apart. Assert the exact
§5.2 text (ANSI stripped) and the exit code (3). One golden, not a term-list
check.

**T11 — lock contention.** Hold `<credentialPath>.refresh.lock` from the test,
run `relogin claude 1` through to a successful fake login, assert it retries and
then fails cleanly with the slot unchanged rather than writing through the lock
(I6).

Explicitly not tested: that certain strings are absent from the source, that
`/reauth` no longer exists as a token. Deleting the command is proven once by
the diff.

## 10. Install

The existing precedent is a symlink in `~/.local/bin` pointing straight at the
package's built bin (`~/.local/bin/claude-auth-balancer ->
.../packages/claude-auth-balancer/dist/src/cli.js`). Match it:

```
cd packages/auth-relogin && npm run build
ln -sf "$PWD/dist/src/cli.js" ~/.local/bin/relogin
```

`dist/src/cli.js` carries `#!/usr/bin/env node` and is chmod +x by the `build`
script, exactly like the two balancer CLIs. No wrapper script, no npm link.

Documentation to update in the same PR: the codex balancer `README.md` (its
re-auth recipe), and the memory note `codex-balancer-ssh-reauth-fastpath.md`,
whose whole content becomes "run `relogin codex <slot>`".

## 11. Lead amendments

Verified after the spec was written; these override the corresponding text above.

**A1 — a freshly-logged-in codex slot has no `expiry_date`.** The codex CLI's
login writes `tokens` + `last_refresh` but NOT `expiry_date`; only the
balancer's own `persistRefreshedCredential()` writes that field. Confirmed live:
slots 1 and 2 (balancer-refreshed) carry `expiry_date 2026-09-04T04:28:12`,
while slot 3 (just re-logged-in) has none. So immediately after any relogin,
`tokenFromAuth()` reports `expiresAt: undefined` for that slot.

Two consequences the implementation must handle:
- §6.2's success path runs `ensureFreshTokens({ stateRoot, slot, force: true })`
  after `unlink(backup)` and before `refreshUsage()`, to backfill `expiry_date`.
  A failure there is a warning, not a failed relogin — the credential is already
  installed and verified.
- `--check` must render a codex slot with a live `refresh_token` but no
  `expiry_date` as healthy, not as unknown or dead.

Add to the test plan: **T12** — fake `codex` writes an `auth.json` with no
`expiry_date` (matching the real CLI's output); assert the relogin succeeds,
`expiry_date` is present afterwards via the forced refresh against the local
token endpoint, and that a `--check` run before that refresh still reports the
slot healthy.

**A2 — codex deadlines cluster too.** §6.3 restricts the staggering warning to
claude on the grounds that codex has no deadline. Codex has no *session*
deadline, but its access-token expiries do cluster: slots 1 and 2 both expire
`2026-09-04T04:28:12`, .569 and .966 — the same sweep, so they fail together.
`--check` reports codex clustering off `expiry_date` with its own wording
(`expire together`, not `fall N apart`), and the §5.2 rendering gains that line.
The post-relogin staggering warning in §6.3 stays claude-only.

**A3 — corrected live figures.** Claude slot 3's deadline is
`2026-09-21T06:13:54Z`, not Sep 20. Codex slot 3 was re-logged-in at
`2026-08-26T02:20:43Z` and now holds a valid credential for
`engineering@quantiiv.com` — §1's "currently has no `auth.json`" is stale.

**A4 — the `D2` reference in §3.2 has no target.** There is no decisions
appendix. Either add one or inline the reasoning; do not leave a dangling
pointer.

**A5 — thresholds live in `auth-balancer-contract`, not `auth-relogin`.** §7 as
written creates a package cycle: §4 has `auth-relogin` depending on both
balancers, while §7 has both balancers importing
`auth-relogin/src/thresholds.ts`. §7's rejection of the contract package is
stylistic — it calls these display/policy values rather than integrity ones —
and the only alternatives are a cycle or duplicated constants that drift apart,
which is exactly what §7 exists to prevent.

Resolution, overriding §7 and the `src/thresholds.ts` bullet in §8.1:

- `WARN_MS`, `RED_MS`, `CLUSTER_WINDOW_MS`, `DEVICE_AUTH_TIMEOUT_MS`, and
  `CLAUDE_REFRESH_WINDOW_MS` are exported from
  `packages/auth-balancer-contract/src/index.ts`.
- Both balancers already depend on that package. `auth-relogin` adds it as its
  only workspace dependency for constants.
- `packages/auth-relogin/src/thresholds.ts` is not created. Nothing re-exports
  the constants; call sites import them from `@bravo/auth-balancer-contract`
  directly.
- §8.2 and §8.3 are amended to include this import in each balancer.

`auth-relogin` still depends on both balancer packages for CLI resolution per
§4. Those arrows are unchanged and remain acyclic:
`auth-relogin -> {claude,codex}-auth-balancer -> auth-balancer-contract`.
