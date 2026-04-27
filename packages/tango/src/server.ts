import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cp, lstat, realpath, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dataRoot, projectSlug } from "./paths.js";
import { listMetadata } from "./metadata.js";
import { readMetrics } from "./metrics.js";
import { initialEventOffset, readEvents, type EventReadState } from "./events.js";
import type { AgentMetadata } from "./types.js";
import {
  buildDashboard,
  buildWorkstreams,
  buildWorkstreamDetail,
  buildWorkstreamAgents,
  buildAttention,
  buildArtifacts,
  buildTimeline,
  buildHistory,
} from "./dashboard-api.js";

export interface TangoServerOptions {
  host?: string;
  port?: number;
  token?: string;
  allowPrivateBind?: boolean;
}

export interface ServerDiscovery {
  schemaVersion: 1;
  url: string;
  token: string;
  pid: number;
  startedAt: string;
}

export interface RootSessionRecord {
  schemaVersion: 1;
  rootSessionId: string;
  workstreamId: string;
  kind: "pi" | "cli" | "dashboard" | "restored";
  cwd?: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

export interface ArtifactManifest {
  schemaVersion: 1;
  artifactId: string;
  token: string;
  title?: string;
  sourcePath: string;
  storedPath: string;
  entry: string;
  mime?: string;
  ownerRunDir?: string;
  cwd?: string;
  createdAt: string;
  revokedAt?: string;
  rootSessionId?: string;
  workstreamId?: string;
}

export function serverDir(): string { return join(dataRoot(), "server"); }
export function serverDiscoveryPath(): string { return join(serverDir(), "server.json"); }
export function rootSessionsDir(): string { return join(serverDir(), "root-sessions"); }
export function artifactsDir(): string { return join(dataRoot(), "artifacts"); }

export function readServerDiscovery(): ServerDiscovery | undefined {
  const envUrl = process.env.TANGO_SERVER_URL;
  const envToken = process.env.TANGO_SERVER_TOKEN;
  if (envUrl && envToken) return { schemaVersion: 1, url: envUrl, token: envToken, pid: 0, startedAt: "env" };
  const p = serverDiscoveryPath();
  if (!existsSync(p)) return undefined;
  try { return JSON.parse(readFileSync(p, "utf8")) as ServerDiscovery; } catch { return undefined; }
}

export async function startTangoServer(options: TangoServerOptions = {}): Promise<{ server: Server; shutdown: () => void }> {
  const host = options.host ?? "127.0.0.1";
  if (!isLocalHost(host) && !options.allowPrivateBind) throw new Error("Refusing non-local bind without --allow-private-bind");
  const port = options.port ?? 43117;
  const token = options.token ?? randomToken(24);
  mkdirSync(serverDir(), { recursive: true });
  mkdirSync(rootSessionsDir(), { recursive: true });
  mkdirSync(artifactsDir(), { recursive: true });

  const clients = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    try { await handleRequest(req, res, { host, port, token, clients }); }
    catch (error) { sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }); }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolveListen());
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const discovery: ServerDiscovery = { schemaVersion: 1, url: `http://${host}:${actualPort}`, token, pid: process.pid, startedAt: new Date().toISOString() };
  writeFileSync(serverDiscoveryPath(), `${JSON.stringify(discovery, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(`tango server listening on ${discovery.url}`);
  console.log(`dashboard: ${discovery.url}/?token=${encodeURIComponent(token)}`);
  console.log(`discovery: ${serverDiscoveryPath()}`);

  let eventState: EventReadState = { offset: initialEventOffset(false), carry: "" };
  const interval = setInterval(() => {
    const next = readEvents(eventState);
    eventState = next.state;
    for (const event of next.events) broadcastSse(clients, "event", event);
  }, 1000);

  const shutdown = () => {
    clearInterval(interval);
    for (const client of clients) client.end();
    server.close();
    try {
      const discoveryPath = serverDiscoveryPath();
      const current = JSON.parse(readFileSync(discoveryPath, "utf8")) as ServerDiscovery;
      if (current.pid === discovery.pid && current.url === discovery.url && current.token === discovery.token) rmSync(discoveryPath, { force: true });
    } catch {}
  };
  process.once("SIGINT", () => { shutdown(); process.exit(0); });
  process.once("SIGTERM", () => { shutdown(); process.exit(0); });
  return { server, shutdown };
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: { host: string; port: number; token: string; clients: Set<ServerResponse> }) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  if (req.method === "GET" && url.pathname === "/api/v1/health") return sendJson(res, 200, { ok: true, schemaVersion: 1, pid: process.pid, time: new Date().toISOString() });
  if (req.method === "GET" && url.pathname === "/api/v1/events") return handleSse(req, res, ctx);
  if (url.pathname.startsWith("/a/")) return serveArtifact(url, res);
  if (req.method === "GET" && serveDashboardFile(url, res)) return;
  if (req.method === "GET" && (
    url.pathname === "/" ||
    url.pathname === "/agents" ||
    url.pathname === "/attention" ||
    url.pathname === "/artifacts" ||
    url.pathname === "/timeline" ||
    url.pathname.startsWith("/sessions/")
  )) {
    if (!authorized(req, ctx.token)) return sendJson(res, 401, { ok: false, error: "Unauthorized" });
    if (dashboardSpaAvailable()) {
      return serveDashboardSpa(res);
    }
    return sendHtml(res, dashboardHtml());
  }
  if (!authorized(req, ctx.token)) return sendJson(res, 401, { ok: false, error: "Unauthorized" });
  if (req.method === "GET" && url.pathname === "/api/v1/agents") return sendJson(res, 200, { ok: true, schemaVersion: 1, agents: listAgents(url.searchParams.get("cwd") ?? undefined) });
  if (req.method === "GET" && url.pathname === "/api/v1/root-sessions") return sendJson(res, 200, { ok: true, schemaVersion: 1, rootSessions: listRootSessions() });
  if (req.method === "POST" && url.pathname === "/api/v1/root-sessions") return sendJson(res, 200, { ok: true, schemaVersion: 1, rootSession: await createOrResumeRootSession(await readJsonBody(req)) });
  if (req.method === "GET" && url.pathname === "/api/v1/artifacts") return sendJson(res, 200, { ok: true, schemaVersion: 1, artifacts: listArtifacts() });
  if (req.method === "GET" && url.pathname === "/api/v1/dashboard") return sendJson(res, 200, { ok: true, ...buildDashboard() });
  if (req.method === "GET" && url.pathname === "/api/v1/workstreams") return sendJson(res, 200, { ok: true, ...buildWorkstreams() });
  if (req.method === "GET" && url.pathname.startsWith("/api/v1/workstreams/")) {
    const parts = url.pathname.split("/");
    if (parts.length === 5) {
      const rootSessionId = parts[4];
      const detail = buildWorkstreamDetail(rootSessionId);
      if (!detail) return sendJson(res, 404, { ok: false, error: "Workstream not found" });
      return sendJson(res, 200, { ok: true, ...detail });
    }
    if (parts.length === 6 && parts[5] === "agents") {
      const rootSessionId = parts[4];
      const agents = buildWorkstreamAgents(rootSessionId);
      if (!agents) return sendJson(res, 404, { ok: false, error: "Workstream not found" });
      return sendJson(res, 200, { ok: true, ...agents });
    }
    if (parts.length === 6 && parts[5] === "attention") {
      const rootSessionId = parts[4];
      const rs = listRootSessions().find((r) => r.rootSessionId === rootSessionId);
      if (!rs) return sendJson(res, 404, { ok: false, error: "Workstream not found" });
      return sendJson(res, 200, { ok: true, ...buildAttention({ rootSessionId }) });
    }
    if (parts.length === 6 && parts[5] === "artifacts") {
      const rootSessionId = parts[4];
      const artifacts = buildArtifacts(rootSessionId);
      if (!artifacts) return sendJson(res, 404, { ok: false, error: "Workstream not found" });
      return sendJson(res, 200, { ok: true, ...artifacts });
    }
    if (parts.length === 6 && parts[5] === "timeline") {
      const rootSessionId = parts[4];
      const timeline = buildTimeline(rootSessionId);
      if (!timeline) return sendJson(res, 404, { ok: false, error: "Workstream not found" });
      return sendJson(res, 200, { ok: true, ...timeline });
    }
  }
  if (req.method === "GET" && url.pathname === "/api/v1/attention") return sendJson(res, 200, { ok: true, ...buildAttention() });
  if (req.method === "GET" && url.pathname === "/api/v1/timeline") return sendJson(res, 200, { ok: true, ...buildTimeline() });
  if (req.method === "GET" && url.pathname === "/api/v1/history") return sendJson(res, 200, { ok: true, ...buildHistory() });
  return sendJson(res, 404, { ok: false, error: "Not found" });
}

function handleSse(req: IncomingMessage, res: ServerResponse, ctx: { token: string; clients: Set<ServerResponse> }) {
  if (!authorized(req, ctx.token)) return sendJson(res, 401, { ok: false, error: "Unauthorized" });
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ schemaVersion: 1, time: new Date().toISOString() })}\n\n`);
  ctx.clients.add(res);
  req.on("close", () => ctx.clients.delete(res));
}

function broadcastSse(clients: Set<ServerResponse>, name: string, payload: unknown) {
  const text = `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) client.write(text);
}

function listAgents(cwd?: string): Array<AgentMetadata & { metrics?: unknown; attachCommand?: string; lookCommand: string; resultCommand: string }> {
  return listMetadata(cwd).map((agent) => {
    const metrics = readMetrics(agent.runDir);
    const prefix = `cd ${shellQuote(agent.cwd)} &&`;
    return {
      ...agent,
      ...(metrics ? { metrics } : {}),
      attachCommand: agent.mode === "interactive" ? `${prefix} tango attach ${shellQuote(agent.name)}` : undefined,
      lookCommand: `${prefix} tango look ${shellQuote(agent.name)} --lines 200`,
      resultCommand: `${prefix} tango result ${shellQuote(agent.name)}`,
    };
  });
}

async function createOrResumeRootSession(input: any): Promise<RootSessionRecord> {
  const now = new Date().toISOString();
  const rootSessionId = safeId(input?.rootSessionId) ?? `sess_${randomToken(8)}`;
  const existingPath = join(rootSessionsDir(), `${rootSessionId}.json`);
  let existing: RootSessionRecord | undefined;
  if (existsSync(existingPath)) existing = JSON.parse(readFileSync(existingPath, "utf8")) as RootSessionRecord;
  const record: RootSessionRecord = {
    schemaVersion: 1,
    rootSessionId,
    workstreamId: safeId(input?.workstreamId) ?? existing?.workstreamId ?? `ws_${randomToken(8)}`,
    kind: input?.kind === "pi" || input?.kind === "dashboard" || input?.kind === "restored" ? input.kind : "cli",
    cwd: typeof input?.cwd === "string" ? resolve(input.cwd) : existing?.cwd,
    title: typeof input?.title === "string" ? input.title : existing?.title,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastSeenAt: now,
  };
  mkdirSync(rootSessionsDir(), { recursive: true });
  await writeFile(existingPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

export function listRootSessions(): RootSessionRecord[] {
  if (!existsSync(rootSessionsDir())) return [];
  return readdirSyncSafe(rootSessionsDir()).filter((name) => name.endsWith(".json")).map((name) => {
    try { return JSON.parse(readFileSync(join(rootSessionsDir(), name), "utf8")) as RootSessionRecord; } catch { return undefined; }
  }).filter((r): r is RootSessionRecord => Boolean(r));
}

export async function publishArtifact(path: string, options: { title?: string; entry?: string; mime?: string; ownerRunDir?: string; cwd?: string; rootSessionId?: string; workstreamId?: string } = {}): Promise<ArtifactManifest & { url?: string }> {
  const sourcePath = resolve(path);
  if (!existsSync(sourcePath)) throw new Error(`Artifact path does not exist: ${sourcePath}`);
  if (isSecretLookingPath(sourcePath)) throw new Error(`Refusing secret-looking artifact path: ${sourcePath}`);
  const sourceLinkStat = await lstat(sourcePath);
  if (sourceLinkStat.isSymbolicLink()) throw new Error(`Refusing symlink artifact path: ${sourcePath}`);
  const sourceReal = await realpath(sourcePath);
  if (isSecretLookingPath(sourceReal)) throw new Error(`Refusing secret-looking artifact path: ${sourceReal}`);
  const artifactId = `art_${randomToken(10)}`;
  const token = randomToken(18);
  const root = join(artifactsDir(), artifactId);
  const content = join(root, "content");
  mkdirSync(content, { recursive: true });
  const st = await lstat(sourceReal);
  if (st.isDirectory()) await cp(sourceReal, content, { recursive: true, force: false, errorOnExist: false, filter: artifactCopyFilter });
  else await cp(sourceReal, join(content, sourceReal.split(sep).pop() ?? "artifact"), { force: false });
  const entry = options.entry ?? (st.isDirectory() ? "index.html" : (sourceReal.split(sep).pop() ?? "artifact"));
  const contentRoot = resolve(content);
  const entryPath = resolve(contentRoot, entry);
  if (!entryPath.startsWith(`${contentRoot}${sep}`) && entryPath !== contentRoot) throw new Error("Artifact entry escapes content directory");
  if (!existsSync(entryPath) || statSync(entryPath).isDirectory()) throw new Error(`Artifact entry does not exist or is not a file: ${entry}`);
  const entryReal = await realpath(entryPath);
  if (!entryReal.startsWith(`${contentRoot}${sep}`) && entryReal !== contentRoot) throw new Error("Artifact entry escapes content directory");
  const manifest: ArtifactManifest = {
    schemaVersion: 1,
    artifactId,
    token,
    title: options.title,
    sourcePath: sourceReal,
    storedPath: content,
    entry,
    mime: options.mime,
    ownerRunDir: options.ownerRunDir,
    cwd: options.cwd,
    rootSessionId: options.rootSessionId ?? (options.ownerRunDir ? undefined : process.env.TANGO_ROOT_SESSION_ID),
    workstreamId: options.workstreamId ?? (options.ownerRunDir ? undefined : process.env.TANGO_WORKSTREAM_ID),
    createdAt: new Date().toISOString(),
  };
  await writeFile(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const discovery = readServerDiscovery();
  return { ...manifest, url: discovery ? `${discovery.url}/a/${artifactId}/${token}/${encodePathSegments(entry)}` : undefined };
}

export function listArtifacts(): ArtifactManifest[] {
  if (!existsSync(artifactsDir())) return [];
  return readdirSyncSafe(artifactsDir()).map((name) => {
    const p = join(artifactsDir(), name, "manifest.json");
    if (!existsSync(p)) return undefined;
    try { return JSON.parse(readFileSync(p, "utf8")) as ArtifactManifest; } catch { return undefined; }
  }).filter((a): a is ArtifactManifest => Boolean(a));
}

export function revokeArtifact(artifactId: string): ArtifactManifest {
  const manifestPath = join(artifactsDir(), artifactId, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`Artifact not found: ${artifactId}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ArtifactManifest;
  manifest.revokedAt = new Date().toISOString();
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

async function serveArtifact(url: URL, res: ServerResponse) {
  const [, , artifactId, token, ...rest] = url.pathname.split("/");
  if (!safeId(artifactId) || !token) return sendJson(res, 404, { ok: false, error: "Artifact not found" });
  let decodedRest: string[];
  try { decodedRest = rest.map((part) => decodeURIComponent(part)); }
  catch { return sendJson(res, 400, { ok: false, error: "Bad artifact path" }); }
  if (decodedRest.some((part) => part === ".." || part === ".")) return sendJson(res, 403, { ok: false, error: "Forbidden" });
  const manifestPath = join(artifactsDir(), artifactId, "manifest.json");
  if (!existsSync(manifestPath)) return sendJson(res, 404, { ok: false, error: "Artifact not found" });
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ArtifactManifest;
  if (manifest.revokedAt) return sendJson(res, 410, { ok: false, error: "Artifact revoked" });
  if (manifest.token !== token) return sendJson(res, 404, { ok: false, error: "Artifact not found" });
  const root = resolve(manifest.storedPath);
  const rootReal = await realpath(root);
  const requestedPath = decodedRest.length > 0 && decodedRest.join("/") ? decodedRest.join("/") : manifest.entry;
  const file = resolve(root, requestedPath);
  if (!file.startsWith(`${root}${sep}`) && file !== root) return sendJson(res, 403, { ok: false, error: "Forbidden" });
  if (!existsSync(file) || statSync(file).isDirectory()) return sendJson(res, 404, { ok: false, error: "Not found" });
  const fileReal = await realpath(file);
  if (!fileReal.startsWith(`${rootReal}${sep}`) && fileReal !== rootReal) return sendJson(res, 403, { ok: false, error: "Forbidden" });
  const contentType = requestedPath === manifest.entry ? (manifest.mime ?? mimeFor(fileReal)) : mimeFor(fileReal);
  res.writeHead(200, { "Content-Type": contentType });
  createReadStream(fileReal).pipe(res);
}

async function artifactCopyFilter(src: string): Promise<boolean> {
  if (isSecretLookingPath(src)) return false;
  const base = src.split(sep).pop() ?? "";
  if (base === ".git" || base === "node_modules") return false;
  return true;
}

function isSecretLookingPath(path: string): boolean {
  return /(^|[/\\])(\.env|id_rsa|id_ed25519|credentials|secrets?|\.ssh)([/\\]|$)/i.test(path);
}

function dashboardDistDir(): string {
  return join(fileURLToPath(import.meta.url), "..", "..", "dashboard", "dist");
}

function dashboardSpaAvailable(): boolean {
  return existsSync(join(dashboardDistDir(), "index.html"));
}

function serveDashboardFile(url: URL, res: ServerResponse): boolean {
  if (url.pathname === "/" || url.pathname === "/index.html") return false;
  const dist = dashboardDistDir();
  const filePath = resolve(dist, "." + url.pathname);
  if (!filePath.startsWith(`${resolve(dist)}${sep}`)) return false;
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) return false;
  res.writeHead(200, { "Content-Type": mimeFor(filePath) });
  createReadStream(filePath).pipe(res);
  return true;
}

function serveDashboardSpa(res: ServerResponse): void {
  const dist = dashboardDistDir();
  const htmlPath = join(dist, "index.html");
  if (!existsSync(htmlPath)) {
    sendHtml(res, dashboardHtml());
    return;
  }
  sendHtml(res, readFileSync(htmlPath, "utf8"));
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(`${JSON.stringify(body)}\n`);
}

function sendHtml(res: ServerResponse, html: string) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function dashboardHtml(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tango Dashboard</title>
  <style>
    body { font: 14px/1.4 system-ui, sans-serif; margin: 24px; background: #0f1115; color: #e8e8e8; }
    a { color: #8ab4ff; } nav a { margin-right: 12px; }
    section { margin-top: 24px; }
    .card { border: 1px solid #303544; border-radius: 8px; padding: 12px; margin: 10px 0; background: #171a21; }
    .muted { color: #a0a6b3; } .status { font-weight: 700; }
    code { background: #242936; padding: 2px 4px; border-radius: 4px; }
    button { margin-left: 8px; }
  </style>
</head>
<body>
  <h1>Tango Dashboard</h1>
  <nav><a href="/agents">Agents</a><a href="/attention">Attention</a><a href="/artifacts">Artifacts</a><a href="/timeline">Timeline</a></nav>
  <p class="muted">Prototype dashboard. Token is kept in the local URL query for v1 testing.</p>
  <section><h2>Agents</h2><div id="agents">Loading...</div></section>
  <section><h2>Attention</h2><div id="attention">Loading...</div></section>
  <section><h2>Artifacts</h2><div id="artifacts">Loading...</div></section>
  <section><h2>Timeline</h2><div id="timeline">Loading...</div></section>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
const auth = token ? '?token=' + encodeURIComponent(token) : '';
function esc(s) { return String(s ?? '').replace(/[&<>\"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c])); }
function copy(text) { navigator.clipboard.writeText(text); }
function encodePathSegments(path) { return String(path ?? '').split('/').map(segment => encodeURIComponent(segment)).join('/'); }
async function load() {
  const agentsRes = await fetch('/api/v1/agents' + auth);
  const agentsJson = await agentsRes.json();
  const agents = agentsJson.agents || [];
  document.getElementById('agents').innerHTML = agents.length ? agents.map(a =>
    '<div class="card">' +
      '<div><span class="status">' + esc(a.status) + '</span> <b>' + esc(a.name) + '</b> <span class="muted">' + esc(a.role || '-') + ' ' + esc(a.mode) + '/' + esc(a.harness) + '</span></div>' +
      '<div class="muted">' + esc(a.cwd) + '</div>' +
      '<div>' + esc(a.summary || a.task || '') + '</div>' +
      (a.attachCommand ? '<div><code>' + esc(a.attachCommand) + '</code><button onclick="copy(this.previousElementSibling.textContent)">copy attach</button></div>' : '') +
      '<div><code>' + esc(a.lookCommand) + '</code><button onclick="copy(this.previousElementSibling.textContent)">copy look</button></div>' +
    '</div>').join('') : '<p class="muted">No agents.</p>';
  const attention = agents.filter(a => ['blocked','error'].includes(a.status) || a.needs);
  document.getElementById('attention').innerHTML = attention.length ? attention.map(a => '<div class="card"><b>' + esc(a.name) + '</b> ' + esc(a.status) + ' ' + esc(a.needs || '') + '<br>' + esc(a.summary || '') + '</div>').join('') : '<p class="muted">No attention items.</p>';
  const artifactsRes = await fetch('/api/v1/artifacts' + auth);
  const artifactsJson = await artifactsRes.json();
  const artifacts = artifactsJson.artifacts || [];
  document.getElementById('artifacts').innerHTML = artifacts.length ? artifacts.map(a => {
    const href = '/a/' + encodeURIComponent(a.artifactId) + '/' + encodeURIComponent(a.token) + '/' + encodePathSegments(a.entry);
    return '<div class="card"><b>' + esc(a.title || a.artifactId) + '</b> <span class="muted">' + (a.revokedAt ? 'revoked' : 'active') + '</span><br><a href="' + href + '" target="_blank">open</a> <code>' + esc(href) + '</code></div>';
  }).join('') : '<p class="muted">No artifacts.</p>';
  const timelineRes = await fetch('/api/v1/timeline' + auth);
  const timelineJson = await timelineRes.json();
  const events = timelineJson.events || [];
  document.getElementById('timeline').innerHTML = events.length ? events.slice(-50).map(e =>
    '<div class="card"><span class="muted">' + esc(e.time) + '</span> <b>' + esc(e.agent) + '</b> ' + esc(e.status || e.type) + '<br>' + esc(e.summary || '') + '</div>'
  ).join('') : '<p class="muted">No timeline events.</p>';
}
load();
const es = token ? new EventSource('/api/v1/events' + auth) : null;
if (es) es.addEventListener('event', () => load());
</script>
</body>
</html>`;
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text.trim() ? JSON.parse(text) : {};
}

function authorized(req: IncomingMessage, token: string): boolean {
  const auth = req.headers.authorization;
  if (auth === `Bearer ${token}`) return true;
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  return url.searchParams.get("token") === token;
}

function isLocalHost(host: string): boolean { return host === "127.0.0.1" || host === "localhost" || host === "::1"; }
function randomToken(bytes: number): string { return randomBytes(bytes).toString("base64url"); }
function safeId(value: unknown): string | undefined { return typeof value === "string" && value !== "." && value !== ".." && /^[a-zA-Z0-9_.-]+$/.test(value) ? value : undefined; }
function readdirSyncSafe(path: string): string[] { try { return readdirSync(path); } catch { return []; } }
function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
function encodePathSegments(path: string): string {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}
function mimeFor(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".html" || ext === ".htm") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}
