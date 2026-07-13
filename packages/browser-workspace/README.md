# @bravo/browser-workspace

A deliberately small private browser terminal: Chromium → existing Tailscale Serve mapping → loopback workspace UI/ttyd → exact tmux sessions.

```sh
npm run build
node dist/src/cli.js config init
node dist/src/cli.js start
node dist/src/cli.js status --json
node dist/src/cli.js ingress inspect --json
```

`config init` discovers absolute `ttyd`, `tmux`, and `tailscale` paths (and Pi when available). Configuration is strict, mode 0600, and defaults to `~/.config/bravo-browser-workspace/config.json`. Edit `workspace`, ports, and the private tmux socket namespace there.

`start` serves a left-hand workspace tab stack. Create tabs with **New workspace**, use **✎** to rename one, and use **×** to forget its browser metadata. Identities, names, order, and active selection live in that browser's localStorage. Each tab has an opaque, stable tmux session identity. Returning to a live tab attaches that exact session. A dead session is marked stale and is never silently replaced or redirected. Forgetting, switching, reload, browser close, and launcher shutdown never kill tmux sessions.

The compact sidebar drop zone streams regular files to `~/tmp-agent-drops/YYYY-MM-DD/` (or the constrained root set in `BRAVO_BROWSER_WORKSPACE_DROP_ROOT` before launch). Names are sanitized, collisions get numeric suffixes, failed partial files are removed, and each file is limited to 100 MiB. The browser stores only the three latest successful upload paths in localStorage; copy copies the full desktop-local path.

The UI and its internal ttyd bind only to `127.0.0.1`. ttyd's process group is cleaned on SIGINT/SIGTERM. The launcher also records the exact ttyd process identity under `$XDG_RUNTIME_DIR` (mode 0600) so a restarted launcher can clean only its own ttyd after a crash. The package never changes Tailscale state: `ingress inspect` and `status` only read it. Review the operator-owned Serve mapping separately and keep Funnel disabled.

An optional host-specific user unit is provided at `systemd/bravo-browser-workspace.service`. Build first, then install it with:

```sh
install -Dm644 systemd/bravo-browser-workspace.service ~/.config/systemd/user/bravo-browser-workspace.service
systemctl --user daemon-reload
systemctl --user enable --now bravo-browser-workspace.service
```

The unit supervises only the Node launcher/ttyd (`Restart=on-failure`, `KillMode=process`); tmux remains the durable session owner. Browser metadata does not sync between devices. The MVP intentionally has no server catalog or arbitrary tmux discovery, UI session killing, reorder/group/pin, or collaboration/auth changes.

## Validation and manual browser check

```sh
npm run check
npm run build
```

Then start the service and open the configured operator-owned Tailnet URL (or `http://127.0.0.1:7681/` locally):

```sh
node dist/src/cli.js start
```

Create two tabs, give them distinct names, run `echo $TMUX` in each, switch between them, rename one with **✎**, and reload the page. If launcher transport drops, the iframe keeps its last xterm rendering visible, hides ttyd's connection overlays, and shows a small parent-owned **Reconnecting…** badge; the UI makes at most four delayed attempts when ttyd falls back to manual Enter. Confirm names/order/selection remain and each terminal returns to its own output. In one terminal run `tmux kill-session`; switch away and back and confirm its tab says `(stale)` rather than opening another session. Click **×** and confirm only the tab metadata is forgotten. Close/reopen the browser and restart the launcher to confirm live tmux sessions remain attachable.

The explicit paid live smoke remains available with `npm run smoke:live -- URL`; do not run it automatically.
