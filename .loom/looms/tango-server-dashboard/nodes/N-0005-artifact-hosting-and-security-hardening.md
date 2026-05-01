---
id: N-0005
title: Artifact hosting and security hardening
kind: task
state: open
parent: N-0001
summary: Artifact hosting and security hardening
tags: []
edges: []
created_at: "2026-04-27T00:41:30.367Z"
updated_at: "2026-04-27T03:28:36.717Z"
---







# Summary

Artifact hosting and security hardening

# Context


# Analysis


# Result

Pending.


# Note 2026-04-27T00:41:42.279Z

## Focus

Harden explicit artifact publishing/serving.

## Required behavior

- Serve only registered artifacts.
- Copy into controlled artifact store by default.
- Tokenized artifact URLs, even on localhost.
- Revocation works and returns non-success status.
- Reject path traversal and secret-looking paths.
- Tailnet/private bind remains explicit opt-in.


# Note 2026-04-27T00:43:23.662Z

## Implementation plan: artifact/security hardening

### Objective and scope

Harden Tango's artifact path from CLI publish through HTTP serve so v1 exposes only explicitly registered artifacts, never arbitrary filesystem paths. Preserve host-native/local default behavior and file-backed state. This plan is limited to `packages/tango` in the `bravo-pi-mono-tango-server` worktree; do not touch active linked main package except during explicit rollout testing.

### Ordered steps

1. Inventory current artifact implementation in `packages/tango/src/server.ts` and CLI wiring in `packages/tango/src/cli.ts`; identify current manifest fields, artifact store layout, and HTTP routes.
2. Define a small artifact manifest contract with stable `schemaVersion`, `artifactId`, per-artifact `token`, copied `storedPath`/`entry`, source metadata for display only, `createdAt`, optional `revokedAt`, `rootSessionId`/`runId` when available, `mime`, and `size` if cheap to compute.
3. Make `tango artifact publish` copy source files/directories into `$TANGO_HOME/artifacts/<artifactId>/...` by default. If an explicit non-copy mode exists or is proposed, defer it for v1 unless a verified consumer needs it.
4. Normalize and validate publish inputs before copying:
   - reject paths containing traversal after `resolve`/`realpath` checks;
   - reject symlinks that escape the selected source root;
   - reject secret-looking path segments such as `.ssh`, `.gnupg`, `.aws`, `.config/gcloud`, `id_rsa`, `private.key`, `token`, `secret`, `credential`, `.env` unless an explicit future override is designed;
   - reject unreadable or unsupported entries with clear CLI errors.
5. Ensure HTTP serving resolves only from manifest `artifactId` + token to controlled store paths; never accept a raw path query parameter or join untrusted path without root containment checks.
6. Require the per-artifact token for every artifact GET/list detail URL, including localhost. Return `401/403` for missing/wrong token and `404` or `410` for unknown/revoked artifacts; do not leak source filesystem paths in error bodies.
7. Implement revocation as durable manifest update and make all serving paths check `revokedAt` before reading. Revoked URLs must become non-success immediately after the next request.
8. Keep server bind policy strict: default host `127.0.0.1`; reject private/non-loopback hosts unless `--allow-private-bind` is present; never auto-enable public bind.
9. Add structured events/log messages for artifact publish/revoke/serve-denied without logging tokens or full secret-looking paths.
10. Update CLI help/API response examples only after behavior is stable.

### Files/areas likely to change

- `/home/joe/Documents/projects/bravo-pi-mono-tango-server/packages/tango/src/server.ts` — manifest schema, publish/list/revoke helpers, HTTP artifact routes, bind/token checks.
- `/home/joe/Documents/projects/bravo-pi-mono-tango-server/packages/tango/src/cli.ts` — artifact CLI options/errors/help.
- `/home/joe/Documents/projects/bravo-pi-mono-tango-server/packages/tango/src/paths.ts` — only if artifact/data-root helpers need centralizing.
- Existing or new Tango tests under `packages/tango` once test layout is confirmed.

### Acceptance criteria

- Artifact URLs are generated only by publish/list from registered manifests and contain an unguessable per-artifact token.
- A request for an arbitrary filesystem path, traversal path, or artifact without a valid token cannot return file contents.
- Published artifacts are copied into `$TANGO_HOME/artifacts`; deleting/moving the original source does not break serving.
- Revoked artifacts return a non-2xx response and are visibly marked revoked in `tango artifact list --json`.
- Publish rejects traversal, symlink escape, and secret-looking paths with actionable errors.
- Server refuses non-loopback/private bind unless the opt-in flag is set.
- Logs/events do not expose artifact tokens or sensitive source paths.

### Tests / validation

- Unit tests for path normalization, containment, secret-looking path rejection, token comparison, and revoked-state decisions.
- Integration test with isolated `TANGO_HOME`: start server on loopback random port, publish temp file, fetch with correct token succeeds, missing/wrong token fails, revoke then fetch fails.
- Integration test for directory artifact with safe nested entry and traversal attempts like `../`, encoded traversal, and absolute path attempts.
- Regression test that source deletion after publish still serves copied content.
- Manual smoke: `tango server --host 127.0.0.1 --port 0`, `tango artifact publish`, browser/curl generated URL, `tango artifact revoke`.

### Risks and staging

- Directory copy can accidentally include secrets; default-deny secret-looking names mitigates but may block legitimate artifacts. Stage by first implementing clear rejections, then consider explicit allowlist override only if a real workflow requires it.
- Token-in-query URLs may leak via browser history; acceptable for local v1 but document as local/private only and avoid logging query strings.
- MIME sniffing can be complex; prefer conservative `application/octet-stream` plus explicit user-provided MIME rather than risky inference.
- Existing prototype manifests may lack new fields; support reading old local manifests only enough to classify/list or require republish in isolated prototype data. Do not add broad compatibility shims unless a live user has artifacts to preserve.


# Note 2026-04-27T03:17:24.711Z

## N-0005 implementation update after quota interruption

Initial worker `n0005-artifact-security-impl` hit provider quota before applying hardening. Coordinator stopped the stalled worker and completed the artifact/server hardening directly.

Implemented:

- Artifact serving remains registered-only via manifest lookup.
- Wrong/missing token returns 404; revoked artifacts return 410.
- Empty artifact subpath serves manifest `entry`.
- `safeId` rejects `.` and `..`.
- Publish validates entry containment and existence.
- Serving rejects `.`/`..` path segments, verifies resolved path containment, follows `realpath`, and rejects symlink traversal outside stored artifact root.
- Non-local bind still requires explicit `--allow-private-bind`.
- Artifact lineage metadata remains compatible with N-0003 scoping.

Tests added in `packages/tango/src/server.test.ts`:

- registered-only serving
- wrong token 404
- revoked artifact 410
- empty subpath serves entry with MIME
- symlink traversal rejected
- non-local bind guard

Validation:

```bash
npm test --workspace @bravo/tango   # 109 tests pass
npm run check --workspace @bravo/tango
npm run build --workspace @bravo/tango
```


# Note 2026-04-27T03:20:26.815Z

## N-0005 review blocker fixes

Reviewer `n0005-artifact-security-review` returned BLOCKED. Coordinator fixed the blockers directly:

- Dashboard HTML no longer leaks the server API token before authorization.
- `publishArtifact()` rejects top-level symlink artifact sources and checks the real resolved source path for secret-looking paths.
- Artifact URLs encode each entry path segment with `encodeURIComponent`; React dashboard fallback URLs do the same.
- Artifact serving decodes path segments safely and applies manifest `mime` only to the manifest entry file, not all nested assets.
- Production dashboard source maps are disabled.

Additional tests added:

- unauthorized dashboard HTML does not expose token;
- dashboard API requires authorization;
- top-level symlink artifact source is rejected;
- reserved characters in artifact entry URLs are encoded and fetchable;
- manifest MIME applies only to entry file.

Validation:

```bash
npm test --workspace @bravo/tango   # 114 tests pass
npm run check --workspace @bravo/tango
npm run build --workspace @bravo/tango
```


# Note 2026-04-27T03:23:44.575Z

## N-0005 artifact/security rereview blocker fixed

Fixed remaining blocker from n0005-artifact-security-rereview in packages/tango:

- Removed dashboard SPA meta-token injection entirely; authorized dashboard HTML served via Authorization header no longer contains the server token.
- Added regression test covering Authorization-header dashboard HTML and asserting no token / tango-token meta appears.
- Updated fallback dashboard artifact href construction to encode artifact entry paths segment-wise with encodeURIComponent per segment instead of encodeURI.
- Kept scope limited to existing auth design; no broader auth redesign introduced.

Validation passed:

```bash
npm test --workspace @bravo/tango
npm run check --workspace @bravo/tango
npm run build --workspace @bravo/tango
```


# Note 2026-04-27T03:28:36.717Z

## N-0005 final artifact/security review pass

After `n0005-artifact-security-rereview2` found one remaining fallback dashboard token leak, smart-worker follow-up removed token interpolation from fallback dashboard HTML and added query-token regression coverage.

Final state:
- No `meta name="tango-token"` injection.
- Dashboard HTML does not contain the server token for unauthenticated, Authorization-header auth, or query-token auth cases.
- Fallback dashboard nav no longer embeds query tokens in server-rendered HTML.
- Fallback and React artifact links use segment-wise path encoding.
- Production dashboard source maps disabled.
- Artifact registered-only/token/revoke/path/symlink/MIME protections retained.

Validation:
```bash
npm test --workspace @bravo/tango   # 116 tests pass
npm run check --workspace @bravo/tango
npm run build --workspace @bravo/tango
```

Final reviewer `n0005-artifact-security-rereview3`: PASS.
