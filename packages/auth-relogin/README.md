# @bravo/auth-relogin

`relogin` — one command to reset the OAuth session window for a Claude or Codex
balancer slot.

## Why this exists

Both balancers keep *access* tokens alive without a human. Neither can keep a
*session* alive.

A Claude refresh token has a hard ~30-day life anchored to the interactive login
that created it. Refreshing does not extend it: the server returns
`refresh_token_expires_in` on every refresh response and it keeps counting down
from that original login. Only logging in again resets it. Before this command,
nothing surfaced that deadline — the first symptom of a dying slot was the slot
going dead.

Codex has no discoverable session deadline, but its recovery path is worse:
`codex login --device-auth` deletes `accounts/<slot>/auth.json` the instant the
flow starts, before any token exchange. An abandoned or timed-out login leaves
the slot with no credential at all and a probably-revoked refresh token.

## Usage

```
relogin <claude|codex> <slot>              interactive re-login (always logs in)
relogin <claude|codex> <slot> --if-needed  refresh first; log in only if that fails
relogin --check [--json]                   deadlines for every slot, both providers
```

Exit codes: `0` success, `1` failed (slot unchanged), `2` usage error or an
unbuilt balancer, `3` `--check` found a slot inside the red threshold, `4` the
login was aborted or timed out (slot unchanged).

## Safety

A failed, timed-out, or interrupted relogin always leaves the slot exactly as it
was.

- **Claude** writes the login into a scratch `CLAUDE_CONFIG_DIR` and touches the
  slot file exactly once, at the end, under the same lock the refresher uses.
- **Codex** backs up `auth.json` before the destructive-first login starts and
  restores it on any non-success exit. SIGKILL cannot be caught, so the backup is
  also recovered on the next run — the crash window always contains both files,
  never neither.
- Either provider rejects a credential belonging to a different account than the
  slot already held, and restores.

## Layout

The binary is a thin dispatcher. Each balancer owns its own `relogin`
subcommand and its own login mechanics; this package resolves and spawns the
right one, and renders the cross-provider `--check`. Thresholds live in
`@bravo/auth-balancer-contract` so the CLI, `status`, and both statuslines
cannot drift apart.

## Install

```bash
npm --workspace @bravo/auth-relogin run build
ln -sf "$PWD/packages/auth-relogin/dist/src/cli.js" ~/.local/bin/relogin
```

Design and test plan: `docs/specs/auth-relogin/SPEC.md`.
