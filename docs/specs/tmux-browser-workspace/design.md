# Browser workspace MVP

Status: implemented local MVP (2026-07-09).

The package owns only a disposable presentation path:

```text
Tailnet browser → operator-owned Tailscale Serve mapping → 127.0.0.1 ttyd → exact tmux session → shell/Pi
```

## Boundaries

- Strict JSON config records dynamic absolute executable paths and one tmux socket/session identity.
- `start` adopts that exact live session or creates it only when the tmux socket namespace is empty.
- ttyd binds loopback, is readiness-checked, and runs in an owned process group cleaned on launcher shutdown. tmux is intentionally retained across browser reload and launcher restart.
- Tailscale is read-only: the package inspects Serve/Funnel state and never applies or removes mappings.
- There is no daemon, systemd renderer, proof state machine, receipt, oracle, JSONL parser, or attestation layer.

## Current limitations

The foreground launcher is not reboot-persistent and cannot clean up after its own SIGKILL. Tailnet ACL and the existing Serve mapping remain operator responsibilities. ttyd grants shell-equivalent authority, so access must remain private. The explicit live smoke is manual because it launches Pi and can spend a model turn.

## Verification

One local real-browser smoke proves Chromium input traverses ttyd into the exact tmux session, writes an exact file, and browser reload preserves tmux identity. The manual Tailnet smoke launches Pi, sends `hello`, and checks that terminal output advances in the remote browser.
