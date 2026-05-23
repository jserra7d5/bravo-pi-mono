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

function normalizeDomainFilter(domain: string): string | undefined {
  const value = domain.trim();
  if (!value || /\s/.test(value)) return undefined;
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname || undefined;
  } catch {
    return value.split("/")[0] || undefined;
  }
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    const key = entity.toLowerCase();
    if (key.startsWith("#x") || key.startsWith("#")) {
      const codePoint = Number.parseInt(key.slice(key.startsWith("#x") ? 2 : 1), key.startsWith("#x") ? 16 : 10);
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    }
    return HTML_ENTITIES[key] ?? match;
  });
}

export function sanitizeBraveSnippet(snippet: string | undefined): string | undefined {
  if (!snippet) return undefined;
  const sanitized = decodeHtmlEntities(snippet)
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized || undefined;
}

export function shapeBraveQuery(input: WebSearchInput): string {
  const parts: string[] = [];
  const query = input.search_mode === "exact" && !/^".*"$/.test(input.query.trim())
    ? `"${input.query.trim()}"`
    : input.query.trim();
  parts.push(query);

  const domains = (input.domains ?? []).flatMap((domain) => {
    const normalized = normalizeDomainFilter(domain);
    return normalized ? [`site:${normalized}`] : [];
  });
  if (domains.length === 1) parts.push(domains[0]);
  if (domains.length > 1) parts.push(`(${domains.join(" OR ")})`);

  for (const domain of input.exclude_domains ?? []) {
    const normalized = normalizeDomainFilter(domain);
    if (normalized) parts.push(`-site:${normalized}`);
  }
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
      snippet: sanitizeBraveSnippet(result.description),
      provider: "brave",
    }];
  });
}
