# @bravo/browser-workspace

A deliberately small private browser terminal: Chromium → existing Tailscale Serve mapping → loopback ttyd → one exact tmux session.

```sh
npm run build
node dist/src/cli.js config init
node dist/src/cli.js start                 # foreground; creates or adopts the exact session
node dist/src/cli.js status --json
node dist/src/cli.js ingress inspect --json
```

`config init` discovers absolute `ttyd`, `tmux`, and `tailscale` paths (and Pi when available). Configuration is strict, mode 0600, and defaults to `~/.config/bravo-browser-workspace/config.json`. Edit `workspace`, ports, and names there. `start --require-existing-tmux` refuses to create a session.

`start` binds ttyd only to `127.0.0.1`, waits for HTTP readiness, and cleans up ttyd's process group on SIGINT/SIGTERM. It deliberately leaves tmux alive. This foreground MVP is **not reboot-persistent**; run it under a managed background process if needed.

The package never changes Tailscale state. `ingress inspect` and `status` only read it. The mapping is shared state; review it separately and keep Funnel disabled.

## Tests and explicit live smoke

`npm test` includes one real local Playwright smoke (skipped only when its installed executable prerequisites are absent): Chromium types through ttyd into tmux, writes an exact file, then reloads while tmux identity remains unchanged.

After an operator starts the service and reviews Tailnet access, they may explicitly run:

```sh
npm run smoke:live -- 'https://host.tailnet.ts.net:8443/'
```

That script launches configured Pi in the browser terminal, types `hello`, and waits for subsequent browser-visible terminal output. It creates no receipts or attestations. It may consume a paid model turn. Do not run it automatically.
