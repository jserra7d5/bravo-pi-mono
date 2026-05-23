export type EvidenceFormat = "auto" | "semantic_html" | "markdown" | "text";
export type SearchMode = "auto" | "exact" | "broad";

export interface WebSearchInput {
  query: string;
  limit?: number;
  search_mode?: SearchMode;
  domains?: string[];
  exclude_domains?: string[];
  recency?: string | null;
}

export interface WebFetchInput {
  refs: string[];
  format?: EvidenceFormat;
  refresh?: "auto" | "force";
}

export interface WebLookupInput {
  query: string;
  limit?: number;
  domain?: string | null;
  format?: EvidenceFormat;
}

export interface SearchResultRecord {
  id: string;
  alias: string;
  title: string;
  url: string;
  snippet?: string;
  provider: string;
  query: string;
  rank: number;
  created_at: string;
}

export interface WebSearchResultItem {
  id: string;
  alias: string;
  title: string;
  url: string;
  snippet?: string;
  provider: string;
}

export interface WebSearchResult {
  results: WebSearchResultItem[];
  count: number;
  truncated: boolean;
  next_cursor?: string | null;
}

export interface ChunkRecord {
  id: string;
  page_id: string;
  ordinal: number;
  heading_path?: string;
  semantic_html_path: string;
  markdown_path: string;
  text_path: string;
  line_start?: number;
  line_end?: number;
  text: string;
  token_count: number;
}

export interface PageRecord {
  id: string;
  alias: string;
  source_result_id?: string;
  url: string;
  final_url?: string;
  canonical_url: string;
  title: string;
  fetched_at: string;
  content_hash: string;
  extractor: string;
  confidence: "good" | "partial" | "weak";
  warnings: string[];
  artifact_dir: string;
  semantic_html_path: string;
  markdown_path: string;
  text_path: string;
  metadata_path: string;
  chunks_path: string;
}

export interface WebFetchResultItem extends PageRecord {
  indexed: boolean;
  best_path: string;
  best_format: Exclude<EvidenceFormat, "auto">;
  preview: string;
  extraction: {
    engine: string;
    confidence: "good" | "partial" | "weak";
    warnings: string[];
  };
}

export interface WebFetchResult {
  results: WebFetchResultItem[];
  count: number;
  truncated: false;
}

export interface WebLookupResultItem {
  page_id: string;
  page_alias: string;
  title: string;
  url: string;
  path: string;
  best_path: string;
  best_format: Exclude<EvidenceFormat, "auto">;
  semantic_html_path: string;
  markdown_path: string;
  text_path: string;
  line_start?: number;
  line_end?: number;
  chunk_id: string;
  heading_path?: string;
  snippet: string;
  matched_terms: string[];
}

export interface WebLookupResult {
  results: WebLookupResultItem[];
  count: number;
  truncated: boolean;
  next_cursor?: string | null;
}
