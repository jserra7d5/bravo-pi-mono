import { fetch } from "undici";
import { adapterError } from "./errors.js";
import { requireBraveApiKey, type WebCacheConfig } from "./config.js";
import type { SearchResultRecord, WebSearchInput } from "./types.js";
import { composeAbortSignal } from "./signals.js";

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

export function shapeBraveQuery(input: WebSearchInput): string {
  const parts: string[] = [];
  const query = input.search_mode === "exact" && !/^".*"$/.test(input.query.trim())
    ? `"${input.query.trim()}"`
    : input.query.trim();
  parts.push(query);
  for (const domain of input.domains ?? []) parts.push(`site:${domain}`);
  for (const domain of input.exclude_domains ?? []) parts.push(`-site:${domain}`);
  return parts.filter(Boolean).join(" ");
}

export async function braveSearch(input: WebSearchInput, config: WebCacheConfig, signal?: AbortSignal): Promise<Omit<SearchResultRecord, "id" | "alias" | "query" | "rank" | "created_at">[]> {
  const key = requireBraveApiKey(config);
  const limit = Math.min(20, Math.max(1, Math.floor(input.limit ?? 10)));
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", shapeBraveQuery(input));
  url.searchParams.set("count", String(limit));
  if (input.recency) url.searchParams.set("freshness", input.recency);

  let response;
  try {
    response = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "X-Subscription-Token": key,
      },
      signal: composeAbortSignal(config.timeoutMs, signal),
    });
  } catch (cause) {
    throw adapterError("Brave Search request failed.", "Retry web_search later or check network connectivity.", cause);
  }

  if (!response.ok) {
    throw adapterError(`Brave Search returned HTTP ${response.status}.`, "Check the Brave API key/quota or retry later.");
  }

  const body = await response.json() as BraveSearchResponse;
  return (body.web?.results ?? []).flatMap((result) => {
    if (!result.url || !result.title) return [];
    return [{
      title: result.title,
      url: result.url,
      snippet: result.description,
      provider: "brave",
    }];
  });
}
