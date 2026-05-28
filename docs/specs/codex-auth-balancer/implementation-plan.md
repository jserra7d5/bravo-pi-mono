# Codex Auth Balancer Implementation Notes

Current architecture is owned by `@bravo/codex-auth-balancer` in this monorepo. Runtime consumers import/call that package directly; they do not shell out to authswap.

## Runtime contracts

- Pi local extension imports `packages/codex-auth-balancer/src/index.ts` so it works without a package build.
- `packages/async-subagents` keeps importing `@bravo/codex-auth-balancer` by package name.
- `prepareLaunch()` creates a run-local isolated directory (normally `<runDir>/auth/codex-balancer`) and writes internal `balancer-metadata.json`.
- `syncBack()` uses internal metadata hashes to detect conflicts, but API/CLI/launch output must not expose token-derived auth hashes or generation values.
- `cleanupLaunch()` may recursively delete only directories prepared by this package and verified by matching metadata.
- Usage reads are cache-only. `getUsage()` reports stale when the cache mtime or stored generated timestamp is older than `staleAfterMs`.

## Authswap migration

`importAuthswap()` is the only supported authswap integration. It copies existing authswap account/cache files into the package-owned state root and reports a clear absent-source error when the source tree is missing. Authswap is not a runtime provider for balancing, usage, prepare-launch, or sync-back.
