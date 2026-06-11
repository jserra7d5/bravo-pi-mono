// OAuth *app client* secret resolution for the Gemini Code Assist providers.
//
// These are installed-app OAuth client secrets used during the token exchange —
// they must never be compiled into source (GitHub push-protection flags them and
// they leak into git history). Resolve them at call time from, in priority order:
//   1. an explicit environment variable (per provider), then
//   2. a local JSON config file (default ~/.gemini/oauth_client.json, mode 0600),
//      shaped as: { "antigravity": { "client_secret": "..." }, "gemini-cli": {...} }
// No hardcoded fallback — if neither is present, resolution throws with guidance.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type OAuthClientKey = "antigravity" | "gemini-cli";
type ClientEntry = { client_id?: string; client_secret?: string };

export function oauthClientConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.GEMINI_CODE_ASSIST_OAUTH_CLIENT_PATH ?? join(homedir(), ".gemini", "oauth_client.json");
}

let cache: Record<string, ClientEntry> | undefined;
let cachePath: string | undefined;

function loadClientConfig(env: NodeJS.ProcessEnv): Record<string, ClientEntry> {
  const path = oauthClientConfigPath(env);
  if (cache && cachePath === path) return cache;
  try {
    cache = JSON.parse(readFileSync(path, "utf8")) as Record<string, ClientEntry>;
  } catch {
    cache = {};
  }
  cachePath = path;
  return cache;
}

/** Resolve an OAuth client secret from the per-provider env var, then the config file. Throws if absent. */
export function resolveOAuthClientSecret(key: OAuthClientKey, envVar: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[envVar];
  if (fromEnv && fromEnv.trim()) return fromEnv;
  const fromFile = loadClientConfig(env)[key]?.client_secret;
  if (fromFile && fromFile.trim()) return fromFile;
  throw new Error(
    `Missing OAuth client secret for "${key}". Set ${envVar}, or add ` +
      `{"${key}":{"client_secret":"…"}} to ${oauthClientConfigPath(env)}.`,
  );
}
