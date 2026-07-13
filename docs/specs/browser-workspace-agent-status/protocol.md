# Unix-socket Protocol and Exact Binding

## Transport and ownership

The supervised browser-workspace process owns one AF_UNIX stream socket. Default path:

```text
${XDG_RUNTIME_DIR}/bravo-browser-workspace/status-v1.sock
```

If `XDG_RUNTIME_DIR` is unavailable, startup must fail with a clear configuration error; do not fall back to `/tmp` or a project directory. The status socket path may be explicitly configured only as an absolute path under a directory owned by the current uid and not writable by group/other.

Startup rules:

1. create/validate parent directory as uid-owned mode `0700`;
2. if the path exists, connect/probe it: fail on a live listener; unlink only a socket proven stale and owned by the current uid; never unlink a regular file or symlink;
3. bind with restrictive umask and chmod socket `0600`;
4. rely on the owner-only runtime directory and socket permissions as the caller boundary for this personal same-user service; do not add a native peer-credential dependency;
5. unlink only the inode/socket instance owned by this service on graceful shutdown.

The systemd user service remains the owner of browser-workspace lifetime. No separate daemon is introduced.

## Framing and limits

Use newline-delimited UTF-8 JSON, one request and one response per connection. Close after the response.

Hard limits:

- 8 KiB maximum request including newline;
- 1 second server read deadline;
- reject extra frames/trailing non-whitespace;
- exact-key schema validation;
- integers must be safe, nonnegative, and bounded;
- no compression or binary payloads.

## v1 report

```json
{
  "protocolVersion": 1,
  "type": "lead_async_running_count",
  "workspace": {
    "name": "bw-0123456789abcdef01234567",
    "tmuxSocketPath": "/tmp/tmux-1000/bravo-browser-workspace",
    "tmuxSessionId": "$3"
  },
  "lead": {
    "piSessionId": "<Pi session id>",
    "rootSessionId": "root_..."
  },
  "reporterInstanceId": "<128-bit random opaque id>",
  "sequence": 42,
  "runningCount": 2,
  "ttlMs": 7000
}
```

Validation bounds:

- workspace name: existing exact `bw-[a-f0-9]{24}` grammar;
- tmux session ID: `^\$[0-9]+$`;
- `piSessionId`, `rootSessionId`, `reporterInstanceId`: nonempty bounded opaque strings (max 256 bytes each; reporter ID generated locally, not displayed);
- `sequence`: safe integer `>= 1`;
- `runningCount`: safe integer `0..10_000`;
- `ttlMs`: `3_000..15_000`; v1 reporter requests `7_000` for a 2-second heartbeat.

Success:

```json
{"ok":true,"protocolVersion":1,"acceptedSequence":42,"expiresInMs":7000}
```

Errors return `ok:false` and a stable code such as `invalid_request`, `unsupported_version`, `workspace_not_live`, `workspace_identity_mismatch`, `stale_sequence`, or `lead_conflict`. Responses must not echo opaque identities unnecessarily.

## Exact binding algorithm

For each report, browser-workspace must:

1. accept the connection only through the owner-restricted socket path;
2. validate shape and bounds;
3. require `workspace.tmuxSocketPath` to resolve to the configured browser-workspace tmux server socket (canonical path/inode where available), not merely any same-uid tmux socket;
4. query the configured tmux executable/namespace with a bounded command for exact `=workspace.name`, obtaining at least session name, immutable `#{session_id}`, and server pid/socket identity;
5. require exactly one live result and exact equality with reported `tmuxSessionId`;
6. apply lead/instance/sequence conflict rules;
7. atomically replace the in-memory lease for that exact workspace.

Never bind by cwd, display name, active browser tab, pid alone, client-supplied workspace name alone, or prefix tmux matching. A destroyed/recreated session with the same `bw-*` name gets a different tmux session ID; old reports cannot bind to it.

## Registry key and value

```ts
Map<WorkspaceName, {
  tmuxSessionId: string;
  piSessionId: string;
  rootSessionId: string;
  reporterInstanceId: string;
  sequence: number;
  runningCount: number;
  receivedAtMonotonicMs: number;
  expiresAtMonotonicMs: number;
}>
```

Use a monotonic clock for TTL. Wall-clock changes must not extend a lease. Expired entries are treated as absent on every read; periodic deletion is only memory hygiene.

## Security boundary

The payload carries no secrets, but false counts can leak activity across workspace cards. The owner-only runtime directory and socket establish the local caller boundary; exact tmux validation establishes workspace binding; lead identity plus instance sequencing prevents accidental cross-session takeover/rollback. This is not a defense against a malicious process already running as the same Unix user with tmux access.