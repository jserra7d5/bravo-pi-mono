export const PROTOCOL_VERSION = 1;

export interface SearchHit {
  repo?: string;
  path: string;
  score: number;
  line?: number | null;
  snippet: string;
}

export interface QueryResponse {
  protocolVersion: number;
  ok: boolean;
  repoRoot?: string;
  query?: string;
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
