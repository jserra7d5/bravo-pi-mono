export const PROTOCOL_VERSION = 1;

export interface SearchSnippetWindow {
  lineStart: number;
  lineEnd: number;
  text: string;
  /** Legacy summary flag; true when the snippet window was shortened. */
  truncated?: boolean;
  truncatedBefore?: boolean;
  truncatedAfter?: boolean;
}

export interface SearchHit {
  repo?: string;
  path: string;
  score: number;
  line?: number | null;
  snippet: string;
  snippets?: SearchSnippetWindow[];
  lineStart?: number | null;
  lineEnd?: number | null;
  matchedFields?: string[];
}

export interface TermBoost {
  term: string;
  weight: number;
}

export interface QueryResponse {
  protocolVersion: number;
  ok: boolean;
  repoRoot?: string;
  query?: string;
  boosts?: TermBoost[];
  excludeTerms?: string[];
  hits: SearchHit[];
  count: number;
  indexFreshness?: string;
  warnings?: string[];
  error?: string;
}

export interface StatusResponse {
  protocolVersion: number;
  ok: boolean;
  repoRoot?: string;
  cacheDir?: string;
  indexedFiles?: number;
  warnings?: string[];
  error?: string;
}
