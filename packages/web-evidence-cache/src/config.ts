import { contextError } from "./errors.js";

export interface WebCacheConfig {
  braveApiKey?: string;
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): WebCacheConfig {
  return {
    braveApiKey: env.BRAVE_SEARCH_API_KEY || env.BRAVE_API_KEY,
    maxBytes: 5_000_000,
    timeoutMs: 15_000,
    maxRedirects: 5,
  };
}

export function requireBraveApiKey(config: WebCacheConfig = readConfig()): string {
  if (!config.braveApiKey) {
    throw contextError(
      "Brave Search API key is not configured.",
      "Set BRAVE_SEARCH_API_KEY or BRAVE_API_KEY in the Pi process environment, then retry web_search.",
    );
  }
  return config.braveApiKey;
}
