use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::env;
use std::fs::{self, File};
use std::io::Read;
use std::time::UNIX_EPOCH;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use tantivy::collector::TopDocs;
use tantivy::query::{BooleanQuery, BoostQuery, Occur, Query, QueryParser};
use tantivy::schema::{Schema, Value, STORED, TEXT};
use tantivy::{doc, Index, IndexWriter, TantivyDocument};

const PROTOCOL_VERSION: u32 = 1;
const MAX_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RepoConfig {
    enabled: Option<bool>,
    allowlist: Option<Vec<String>>,
    exclude: Option<Vec<String>>,
    #[serde(rename = "maxFileBytes")]
    max_file_bytes: Option<u64>,
}

#[derive(Default)]
struct EffectiveConfig {
    enabled: bool,
    exclude: Vec<String>,
    max_file_bytes: u64,
}

#[derive(Clone, Serialize, Deserialize)]
struct TermBoost { term: String, weight: f32 }

#[derive(Serialize)]
struct Hit { path: String, score: f32, line: Option<usize>, snippet: String }

#[derive(Serialize)]
struct QueryResponse {
    #[serde(rename = "protocolVersion")]
    protocol_version: u32,
    ok: bool,
    #[serde(rename = "repoRoot")]
    repo_root: Option<String>,
    query: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    boosts: Vec<TermBoost>,
    #[serde(rename = "excludeTerms", skip_serializing_if = "Vec::is_empty")]
    exclude_terms: Vec<String>,
    hits: Vec<Hit>,
    count: usize,
    #[serde(rename = "indexFreshness")]
    index_freshness: Option<String>,
    warnings: Vec<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct IndexManifest {
    #[serde(rename = "indexedFiles")]
    indexed_files: usize,
}

#[derive(Serialize)]
struct StatusResponse {
    #[serde(rename = "protocolVersion")]
    protocol_version: u32,
    ok: bool,
    #[serde(rename = "repoRoot")]
    repo_root: Option<String>,
    #[serde(rename = "cacheDir")]
    cache_dir: Option<String>,
    #[serde(rename = "indexedFiles", skip_serializing_if = "Option::is_none")]
    indexed_files: Option<usize>,
    warnings: Vec<String>,
    error: Option<String>,
}

#[derive(Clone)]
struct Fields { path: tantivy::schema::Field, body: tantivy::schema::Field }

fn schema() -> (Schema, Fields) {
    let mut b = Schema::builder();
    let path = b.add_text_field("path", TEXT | STORED);
    let body = b.add_text_field("body", TEXT | STORED);
    (b.build(), Fields { path, body })
}

fn main() {
    let code = match run() { Ok(code) => code, Err(e) => { print_query_error(&e.to_string()); 10 } };
    std::process::exit(code);
}

fn run() -> Result<i32> {
    let args: Vec<String> = env::args().skip(1).collect();
    let cmd = args.first().map(String::as_str).unwrap_or("");
    match cmd {
        "query" => query_cmd(&args[1..]),
        "index" => index_cmd(&args[1..]),
        "status" => status_cmd(&args[1..]),
        "purge" => purge_cmd(&args[1..]),
        "config" => config_cmd(&args[1..]),
        _ => { print_query_error("usage: source-search-sidecar query|index|status|config|purge --repo PATH --json"); Ok(2) }
    }
}

fn arg(args: &[String], name: &str) -> Option<String> { args.windows(2).find(|w| w[0] == name).map(|w| w[1].clone()) }
fn repo_arg(args: &[String]) -> Result<PathBuf> { Ok(fs::canonicalize(arg(args, "--repo").ok_or_else(|| anyhow!("--repo is required"))?)?) }

fn validate_plain_text(value: &str, label: &str) -> Result<()> {
    if value.chars().count() > 512 { bail!("QueryError: {label} is too long"); }
    let has_query_syntax = value.chars().any(|ch| matches!(ch, ':' | '^' | '~' | '*' | '(' | ')' | '[' | ']' | '{' | '}' | '"' | '\\'))
        || value.split_whitespace().any(|token| matches!(token, "AND" | "OR" | "NOT") || token.starts_with('+') || token.starts_with('-'));
    if has_query_syntax { bail!("QueryError: {label} must use plain lexical terms; pass boosts/excludeTerms as typed parameters instead of query syntax"); }
    Ok(())
}

fn parse_boosts(raw: Option<String>) -> Result<Vec<TermBoost>> {
    let Some(raw) = raw else { return Ok(vec![]); };
    let parsed: Vec<TermBoost> = serde_json::from_str(&raw).context("QueryError: --boosts must be a JSON array of {term, weight}")?;
    if parsed.len() > 20 { bail!("QueryError: --boosts supports at most 20 entries"); }
    let mut cleaned = Vec::new();
    for boost in parsed {
        let term = boost.term.trim();
        if term.is_empty() { bail!("QueryError: boost term must not be empty"); }
        if term.chars().count() > 100 { bail!("QueryError: boost term is too long; use a short lexical term or phrase"); }
        validate_plain_text(term, "boost term")?;
        if !boost.weight.is_finite() || boost.weight <= 0.0 || boost.weight > 10.0 { bail!("QueryError: boost weight must be > 0 and <= 10"); }
        cleaned.push(TermBoost { term: term.to_string(), weight: boost.weight });
    }
    Ok(cleaned)
}

fn parse_exclude_terms(raw: Option<String>) -> Result<Vec<String>> {
    let Some(raw) = raw else { return Ok(vec![]); };
    let parsed: Vec<String> = serde_json::from_str(&raw).context("QueryError: --exclude-terms must be a JSON array of strings")?;
    if parsed.len() > 20 { bail!("QueryError: --exclude-terms supports at most 20 entries"); }
    let mut cleaned = Vec::new();
    for term in parsed {
        let term = term.trim();
        if term.is_empty() { bail!("QueryError: exclude term must not be empty"); }
        if term.chars().count() > 100 { bail!("QueryError: exclude term is too long; use a short lexical term or phrase"); }
        validate_plain_text(term, "exclude term")?;
        cleaned.push(term.to_string());
    }
    Ok(cleaned)
}

fn manifest_path(repo: &Path) -> Result<PathBuf> { Ok(cache_dir(repo)?.join("manifest.json")) }

fn read_manifest(repo: &Path) -> Result<Option<IndexManifest>> {
    let path = manifest_path(repo)?;
    if !path.exists() { return Ok(None); }
    let raw = fs::read_to_string(&path).with_context(|| format!("failed to read {}", path.display()))?;
    let manifest: IndexManifest = serde_json::from_str(&raw).with_context(|| format!("invalid Source Search manifest {}", path.display()))?;
    Ok(Some(manifest))
}

fn cache_dir(repo: &Path) -> Result<PathBuf> {
    let mut h = Sha256::new(); h.update(repo.to_string_lossy().as_bytes());
    let home = env::var("HOME").context("HOME is not set")?;
    let dir = PathBuf::from(home).join(".cache/pi-coding-agent/source-search").join(hex::encode(h.finalize()));
    secure_dir(&dir)?;
    Ok(dir)
}

fn secure_dir(dir: &Path) -> Result<()> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)] fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn git_files(repo: &Path) -> Result<Vec<PathBuf>> {
    let out = Command::new("git").arg("-C").arg(repo).args(["ls-files", "-z", "-co", "--exclude-standard"]).env("GIT_TERMINAL_PROMPT", "0").output()?;
    if !out.status.success() { bail!("git ls-files failed"); }
    Ok(out.stdout.split(|b| *b == 0).filter(|s| !s.is_empty()).map(|s| PathBuf::from(String::from_utf8_lossy(s).to_string())).collect())
}

fn load_config(repo: &Path) -> Result<EffectiveConfig> {
    let mut cfg = EffectiveConfig { enabled: true, exclude: vec![], max_file_bytes: MAX_FILE_BYTES };
    for rel in [".bravo/source-search.json"] {
        let path = repo.join(rel);
        if !path.exists() { continue; }
        let raw = fs::read_to_string(&path).with_context(|| format!("failed to read {}", rel))?;
        let parsed: RepoConfig = serde_json::from_str(&raw).with_context(|| format!("invalid Source Search config {}", rel))?;
        if let Some(enabled) = parsed.enabled { cfg.enabled = enabled; }
        if let Some(exclude) = parsed.exclude { cfg.exclude.extend(exclude); }
        if let Some(max) = parsed.max_file_bytes { cfg.max_file_bytes = max.min(16 * 1024 * 1024); }
        if parsed.allowlist.as_ref().is_some_and(|v| !v.is_empty()) {
            bail!("ignored-path allowlist is not implemented in this build; remove allowlist entries or rebuild after allowlist support lands");
        }
    }
    Ok(cfg)
}

fn simple_match(pattern: &str, path: &str) -> bool {
    if let Some(prefix) = pattern.strip_suffix("/**") { return path == prefix || path.starts_with(&format!("{}/", prefix)); }
    if let Some(prefix) = pattern.strip_suffix('*') { return path.starts_with(prefix); }
    path == pattern
}

fn deny(path: &str) -> bool {
    path == ".git"
        || path.starts_with(".git/")
        || path.ends_with(".pem")
        || path.ends_with(".key")
        || path.ends_with(".p12")
        || path.ends_with(".pfx")
        || path == ".env"
        || path.starts_with(".env.")
        || path.contains("secret")
        || path.contains("credential")
        || path.contains("token")
        || path.contains("/dist/")
        || path.starts_with("dist/")
        || path.contains("/build/")
        || path.starts_with("build/")
        || path.contains("/target/")
        || path.starts_with("target/")
        || path.contains("/node_modules/")
        || path.starts_with("node_modules/")
}

fn looks_binary(buf: &[u8]) -> bool { buf.iter().take(8192).any(|b| *b == 0) }

fn safe_text(repo: &Path, rel: &Path, cfg: &EffectiveConfig) -> Result<Option<String>> {
    let rel_s = rel.to_string_lossy().replace('\\', "/");
    if deny(&rel_s.to_lowercase()) || cfg.exclude.iter().any(|p| simple_match(p, &rel_s)) { return Ok(None); }
    let full = repo.join(rel);
    let canon = match fs::canonicalize(&full) { Ok(p) => p, Err(_) => return Ok(None) };
    if !canon.starts_with(repo) { return Ok(None); }
    let meta = fs::metadata(&canon)?;
    if !meta.is_file() || meta.len() > cfg.max_file_bytes { return Ok(None); }
    let mut f = File::open(&canon)?;
    let mut buf = Vec::new(); f.read_to_end(&mut buf)?;
    if looks_binary(&buf) { return Ok(None); }
    Ok(Some(String::from_utf8_lossy(&buf).to_string()))
}

fn open_or_create_index(repo: &Path) -> Result<(Index, Fields)> {
    let (schema, fields) = schema();
    let dir = cache_dir(repo)?.join("tantivy"); secure_dir(&dir)?;
    let index = Index::open_in_dir(&dir).or_else(|_| Index::create_in_dir(&dir, schema.clone()))?;
    Ok((index, fields))
}

fn rebuild(repo: &Path) -> Result<usize> {
    let cfg = load_config(repo)?;
    if !cfg.enabled { bail!("Source Search is disabled by config"); }
    let dir = cache_dir(repo)?.join("tantivy");
    if dir.exists() { fs::remove_dir_all(&dir)?; }
    secure_dir(&dir)?;
    let (schema, fields) = schema();
    let index = Index::create_in_dir(&dir, schema)?;
    let mut writer: IndexWriter<TantivyDocument> = index.writer(50_000_000)?;
    let mut count = 0;
    let mut seen = HashSet::new();
    for rel in git_files(repo)? {
        let rel_s = rel.to_string_lossy().replace('\\', "/");
        if !seen.insert(rel_s.clone()) { continue; }
        if let Some(text) = safe_text(repo, &rel, &cfg)? {
            writer.add_document(doc!(fields.path => rel_s, fields.body => text))?;
            count += 1;
        }
    }
    writer.commit()?;
    let manifest = serde_json::json!({
        "indexedFiles": count,
        "lastIndexedAtUnixMs": UNIX_EPOCH.elapsed().map(|d| d.as_millis()).unwrap_or_default()
    });
    let path = manifest_path(repo)?;
    fs::write(&path, manifest.to_string())?;
    #[cfg(unix)] fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    Ok(count)
}

fn query_cmd(args: &[String]) -> Result<i32> {
    let repo = repo_arg(args)?;
    let q = arg(args, "--query").ok_or_else(|| anyhow!("--query is required"))?;
    validate_plain_text(&q, "query")?;
    let limit: usize = arg(args, "--limit").and_then(|v| v.parse().ok()).unwrap_or(10).clamp(1, 50);
    let path_prefix = arg(args, "--path-prefix");
    let boosts = parse_boosts(arg(args, "--boosts"))?;
    let exclude_terms = parse_exclude_terms(arg(args, "--exclude-terms"))?;
    rebuild(&repo)?;
    let (index, fields) = open_or_create_index(&repo)?;
    let reader = index.reader()?;
    let searcher = reader.searcher();
    let mut parser = QueryParser::for_index(&index, vec![fields.body, fields.path]);
    parser.set_field_boost(fields.path, 2.0);
    let base_query = parser.parse_query(&q).map_err(|e| anyhow!("QueryError: query must use plain lexical terms: {e}"))?;
    let mut clauses: Vec<(Occur, Box<dyn Query>)> = vec![(Occur::Must, base_query)];
    for boost in boosts.iter().filter(|boost| boost.weight > 1.0 && !is_phrase(&boost.term)) {
        let boost_query = parser.parse_query(&boost.term).map_err(|e| anyhow!("QueryError: invalid boost term {:?}: {e}", boost.term))?;
        clauses.push((Occur::Should, Box::new(BoostQuery::new(boost_query, boost.weight))));
    }
    for term in exclude_terms.iter().filter(|term| !is_phrase(term)) {
        let exclude_query = parser.parse_query(term).map_err(|e| anyhow!("QueryError: invalid exclude term {term:?}: {e}"))?;
        clauses.push((Occur::MustNot, exclude_query));
    }
    let query: Box<dyn Query> = if clauses.len() == 1 { clauses.remove(0).1 } else { Box::new(BooleanQuery::new(clauses)) };
    let has_post_scored_boosts = boosts.iter().any(|boost| boost.weight < 1.0 || is_phrase(&boost.term));
    let has_post_filtered_excludes = exclude_terms.iter().any(|term| is_phrase(term));
    let top_limit = if path_prefix.is_some() || has_post_scored_boosts || has_post_filtered_excludes { 1000.max(limit * 20) } else { limit * 3 };
    let top = searcher.search(&query, &TopDocs::with_limit(top_limit).order_by_score())?;
    let boost_needles: Vec<(String, f32)> = boosts.iter().map(|b| (b.term.to_lowercase(), b.weight)).collect();
    let exclude_needles: Vec<String> = exclude_terms.iter().map(|t| t.to_lowercase()).collect();
    let mut hits = Vec::new();
    for (score, addr) in top {
        let doc: TantivyDocument = searcher.doc(addr)?;
        let path = doc.get_first(fields.path).and_then(|v| v.as_str()).unwrap_or("").to_string();
        if let Some(prefix) = &path_prefix {
            let normalized_prefix = prefix.trim_end_matches('/');
            if path != normalized_prefix && !path.starts_with(&format!("{normalized_prefix}/")) { continue; }
        }
        let body = doc.get_first(fields.body).and_then(|v| v.as_str()).unwrap_or("");
        let haystack = format!("{}\n{}", path, body).to_lowercase();
        if exclude_needles.iter().any(|term| contains_plain_term(&haystack, term)) { continue; }
        let adjusted_score = boost_needles.iter().fold(score, |current, (term, weight)| {
            if contains_plain_term(&haystack, term) { current * *weight } else { current }
        });
        let (line, snippet) = best_snippet(body, &q);
        hits.push(Hit { path, score: adjusted_score, line, snippet });
    }
    hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    hits.truncate(limit);
    let mut warnings = vec![];
    if has_post_scored_boosts || has_post_filtered_excludes { warnings.push(format!("phrase controls or down-weight boosts are applied after retrieving a bounded top-{top_limit} BM25 candidate set")); }
    let resp = QueryResponse { protocol_version: PROTOCOL_VERSION, ok: true, repo_root: Some(repo.display().to_string()), query: Some(q), boosts, exclude_terms, count: hits.len(), hits, index_freshness: Some("fresh".into()), warnings, error: None };
    println!("{}", serde_json::to_string(&resp)?); Ok(0)
}

fn is_word_byte(byte: u8) -> bool { byte.is_ascii_alphanumeric() || byte == b'_' }

fn is_phrase(value: &str) -> bool { value.split_whitespace().count() > 1 }

fn contains_plain_term(haystack_lower: &str, needle_lower: &str) -> bool {
    if is_phrase(needle_lower) { return haystack_lower.contains(needle_lower); }
    for (start, _) in haystack_lower.match_indices(needle_lower) {
        let end = start + needle_lower.len();
        let before_ok = start == 0 || !is_word_byte(haystack_lower.as_bytes()[start - 1]);
        let after_ok = end == haystack_lower.len() || !is_word_byte(haystack_lower.as_bytes()[end]);
        if before_ok && after_ok { return true; }
    }
    false
}

fn best_snippet(body: &str, q: &str) -> (Option<usize>, String) {
    let terms: Vec<String> = q.split_whitespace().map(|s| s.to_lowercase()).collect();
    for (i, line) in body.lines().enumerate() {
        let lower = line.to_lowercase();
        if terms.iter().any(|t| contains_plain_term(&lower, t)) { return (Some(i + 1), line.trim().chars().take(300).collect()); }
    }
    (None, body.chars().take(300).collect())
}

fn index_cmd(args: &[String]) -> Result<i32> { let repo = repo_arg(args)?; let n = rebuild(&repo)?; status_print(repo, n, vec![]) }
fn status_cmd(args: &[String]) -> Result<i32> {
    let repo = repo_arg(args)?;
    let _cfg = load_config(&repo)?;
    let mut warnings = vec![];
    let n = match read_manifest(&repo)? {
        Some(manifest) => manifest.indexed_files,
        None => {
            warnings.push("index has not been built yet; run `source-search index --repo <path> --force --json` or use ranked_search to build on demand".into());
            0
        }
    };
    status_print(repo, n, warnings)
}
fn purge_cmd(args: &[String]) -> Result<i32> { let repo = repo_arg(args)?; let dir = cache_dir(&repo)?; if dir.exists() { fs::remove_dir_all(&dir)?; } let resp = StatusResponse{protocol_version:PROTOCOL_VERSION,ok:true,repo_root:Some(repo.display().to_string()),cache_dir:Some(dir.display().to_string()),indexed_files:Some(0),warnings:vec![],error:None}; println!("{}", serde_json::to_string(&resp)?); Ok(0) }
fn config_cmd(args: &[String]) -> Result<i32> {
    if args.first().map(String::as_str) != Some("validate") { print_query_error("only config validate is implemented"); return Ok(2); }
    let repo = repo_arg(&args[1..])?;
    let cfg = load_config(&repo)?;
    let mut warnings = vec![];
    if !cfg.enabled { warnings.push("Source Search is disabled by config".into()); }
    status_print_optional(repo, None, warnings)
}
fn status_print(repo: PathBuf, n: usize, warnings: Vec<String>) -> Result<i32> { status_print_optional(repo, Some(n), warnings) }
fn status_print_optional(repo: PathBuf, n: Option<usize>, warnings: Vec<String>) -> Result<i32> { let resp = StatusResponse{protocol_version:PROTOCOL_VERSION,ok:true,repo_root:Some(repo.display().to_string()),cache_dir:Some(cache_dir(&repo)?.display().to_string()),indexed_files:n,warnings,error:None}; println!("{}", serde_json::to_string(&resp)?); Ok(0) }
fn print_query_error(msg: &str) { let resp = QueryResponse{protocol_version:PROTOCOL_VERSION,ok:false,repo_root:None,query:None,boosts:vec![],exclude_terms:vec![],hits:vec![],count:0,index_freshness:None,warnings:vec![],error:Some(msg.to_string())}; println!("{}", serde_json::to_string(&resp).unwrap()); }
