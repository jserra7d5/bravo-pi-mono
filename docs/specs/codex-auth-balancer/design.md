# Codex Auth Balancer Design

`@bravo/codex-auth-balancer` owns Codex account state, usage cache access, launch isolation, sync-back, and cleanup safety.

Runtime callers:

- Pi footer extension imports the TypeScript source directly from this repo-local package.
- Async subagents imports the package by name and prepares a per-run `auth/codex-balancer` directory before launch.

Security constraints:

- Isolated directories must be absolute and safe; cleanup requires package metadata and matching isolated-dir/state metadata.
- Raw tokens, keys, token-derived auth hashes, and generation IDs are internal only and are redacted/omitted from CLI/API/log output.
- Sync-back conflicts retain the isolated directory with a marker instead of overwriting newer state.

Authswap is an import-only migration source via `importAuthswap()` and is not used at runtime.
