# Browser workspace MVP

Status: minimal workspace-tabs increment implemented (2026-07-12).

```text
Tailnet browser → operator-owned Tailscale Serve mapping → 127.0.0.1 workspace UI → loopback ttyd → exact tmux session → shell/Pi
```

## Behavior and ownership

- A left vertical tab stack is browser-owned. localStorage retains opaque identities, display names, ordering, and active selection.
- Creating a tab creates one tmux session with that opaque identity in the configured private socket namespace. Opening a live tab always attaches that exact session.
- The server exposes no session catalog or arbitrary tmux discovery. A browser can only ask about an identity it already holds or submit a newly generated identity.
- A missing/dead identity is displayed as stale. It is not recreated or redirected. Forget removes browser metadata only.
- Switching, reload, browser close, forgetting, launcher shutdown, and launcher restart never kill tmux.
- ttyd and the workspace UI bind loopback only. ttyd runs in an owned process group cleaned on launcher shutdown. Its exact identity, executable, and argv are atomically recorded in a restrictive per-user runtime file; after a launcher crash, only that validated process group is recovered.
- An already-open iframe remains mounted across a transport failure, preserving its last xterm rendering. The parent suppresses only ttyd's three known connection overlays, shows a non-blocking status badge for the active tab, and dispatches bounded synthetic Enter key events only while ttyd's manual reconnect overlay exists. It never writes terminal data or injects Enter into tmux.
- The host-specific systemd user unit owns launcher lifetime only (`Restart=on-failure`, `KillMode=process`). tmux owns durable shell state.
- Tailscale remains read-only: the package inspects Serve/Funnel state and never applies or removes mappings.

## Deliberate exclusions

There is no cross-device metadata sync, server catalog, UI session killing, reorder/group/pin, auth/collaboration change, or arbitrary tmux discovery. Tailnet ACL and the existing Serve mapping remain operator responsibilities. ttyd grants shell-equivalent authority, so access must remain private.

## Verification

Build/typecheck are automated. Manual browser verification creates two named tabs, demonstrates distinct exact tmux sessions, switches and reloads, checks localStorage restoration, interrupts launcher transport to verify unobstructed retained output and automatic recovery, kills one session from within tmux to verify honest stale display, and verifies forgetting does not kill a live session. A systemd validation kills only `MainPID`, then proves a new launcher PID, HTTP readiness, exact tmux survival, and one owned ttyd. The Tailnet smoke remains explicit because it launches Pi and can spend a model turn.
