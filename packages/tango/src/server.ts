import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cp, lstat, realpath, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dataRoot, projectSlug } from "./paths.js";
import { listMetadata } from "./metadata.js";
import { readMetrics } from "./metrics.js";
import { initialEventOffset, readEvents, readRecentEvents, type EventReadState } from "./events.js";
import { resolveTarget } from "./targetResolver.js";
import { startAgent } from "./start.js";
import { assessResultDeliverable } from "./result.js";
import { buildRunState, followRun, messageRun, readActivity, reportRun, stopRun } from "./controlPlane.js";
import { markHandled, markSeen } from "./attention.js";
import type { AgentMetadata, RootSessionIdentity } from "./types.js";
import {
  buildDashboard,
  buildOperations,
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
  token?: string;
  pid: number;
  startedAt: string;
}

export interface RootSessionRecord {
  schemaVersion: 1;
  rootSessionId: string;
  workstreamId: string;
  kind: RootSessionIdentity["origin"] | "restored";
  cwd?: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out/i.test(message)) return new HttpError(504, "timeout", message);
  if (/not found/i.test(message)) return new HttpError(404, "not_found", message);
  if (/Cannot transition terminal|immutable|required deliverable|Invalid status|Invalid result|placeholder|suspiciously short|not allowed/i.test(message)) return new HttpError(409, "conflict", message);
  if (/Missing|Invalid|Use either|Target required|Usage:/i.test(message)) return new HttpError(400, "bad_request", message);
  return new HttpError(500, "internal_error", message);
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
  if (envUrl) return { schemaVersion: 1, url: envUrl, ...(envToken ? { token: envToken } : {}), pid: 0, startedAt: "env" };
  const p = serverDiscoveryPath();
  if (!existsSync(p)) return undefined;
  try {
    const discovery = JSON.parse(readFileSync(p, "utf8")) as ServerDiscovery;
    if (!serverDiscoveryPidAlive(discovery.pid)) return undefined;
    return discovery;
  } catch { return undefined; }
}

function serverDiscoveryPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

export async function startTangoServer(options: TangoServerOptions = {}): Promise<{ server: Server; shutdown: () => void }> {
  const host = options.host ?? "127.0.0.1";
  if (!isLocalHost(host) && !options.allowPrivateBind) throw new Error("Refusing non-local bind without --allow-private-bind");
  const port = options.port ?? 43117;
  const token = options.token;
  mkdirSync(serverDir(), { recursive: true });
  mkdirSync(rootSessionsDir(), { recursive: true });
  mkdirSync(artifactsDir(), { recursive: true });

  const clients = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    try { await handleRequest(req, res, { host, port, token, clients }); }
    catch (error) {
      const mapped = toHttpError(error);
      sendJson(res, mapped.status, { ok: false, error: mapped.message, code: mapped.code });
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolveListen());
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const discovery: ServerDiscovery = { schemaVersion: 1, url: `http://${host}:${actualPort}`, ...(token ? { token } : {}), pid: process.pid, startedAt: new Date().toISOString() };
  writeFileSync(serverDiscoveryPath(), `${JSON.stringify(discovery, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(`tango server listening on ${discovery.url}`);
  console.log(`dashboard: ${discovery.url}`);
  if (token) console.log(`dashboard token: ${token}`);
  console.log(`auth: ${token ? "enabled" : "disabled (use --token TOKEN to enable)"}`);
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

async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: { host: string; port: number; token?: string; clients: Set<ServerResponse> }) {
  applySecurityHeaders(res);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  if ((req.method === "POST" || req.method === "PUT" || req.method === "PATCH") && !bodyWithinLimit(req, 1024 * 1024)) return sendJson(res, 413, { ok: false, error: "Request body too large" });
  if (req.method === "GET" && url.pathname === "/api/v1/health") return sendJson(res, 200, { ok: true, schemaVersion: 1, pid: process.pid, time: new Date().toISOString() });
  if (req.method === "GET" && url.pathname === "/api/v1/events") return handleSse(req, res, ctx);
  if (req.method === "GET" && url.pathname === "/api/v1/subscribe") return handleSse(req, res, ctx);
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
  if (req.method === "GET" && url.pathname === "/api/v1/runs") return sendJson(res, 200, { ok: true, schemaVersion: 1, runs: listAgents(url.searchParams.get("cwd") ?? undefined).map((agent) => buildRunState(agent)) });
  if (req.method === "GET" && url.pathname === "/api/v1/runs/events") return sendJson(res, 200, { ok: true, schemaVersion: 1, ...serverEvents(url) });
  if (req.method === "GET" && url.pathname === "/api/v1/runs/state") return sendJson(res, 200, { ok: true, schemaVersion: 1, state: buildRunState(resolveServerTarget(url)) });
  if (req.method === "GET" && url.pathname === "/api/v1/runs/activity") {
    const meta = resolveServerTarget(url);
    const activity = readActivity(meta, { lines: limitParam(url), raw: url.searchParams.get("raw") === "true", events: url.searchParams.get("events") === "true" });
    return sendJson(res, 200, { ok: true, schemaVersion: 1, agent: meta, output: activity.text, events: activity.events, activity: activity.summary });
  }
  if (req.method === "GET" && url.pathname === "/api/v1/runs/result") {
    const meta = resolveServerTarget(url);
    const assessment = assessResultDeliverable(meta);
    return sendJson(res, 200, { ok: true, schemaVersion: 1, agent: meta, state: buildRunState(meta), result: assessment.result, assessment });
  }
  if (req.method === "POST" && url.pathname === "/api/v1/runs/start") return sendJson(res, 200, { ok: true, schemaVersion: 1, ...(await serverStartRun(await readJsonBody(req))) });
  if (req.method === "POST" && url.pathname === "/api/v1/runs/message") return sendJson(res, 200, { ok: true, schemaVersion: 1, ...(await serverMessageRun(await readJsonBody(req), url)) });
  if (req.method === "POST" && url.pathname === "/api/v1/runs/report") return sendJson(res, 200, { ok: true, schemaVersion: 1, ...(await serverReportRun(await readJsonBody(req))) });
  if (req.method === "POST" && url.pathname === "/api/v1/runs/stop") return sendJson(res, 200, { ok: true, schemaVersion: 1, ...(await serverStopRun(await readJsonBody(req), url)) });
  if (req.method === "POST" && url.pathname === "/api/v1/runs/follow") return sendJson(res, 200, { ok: true, schemaVersion: 1, ...(await serverFollowRun(await readJsonBody(req), url)) });
  if (req.method === "POST" && url.pathname === "/api/v1/runs/attention/ack") return sendJson(res, 200, { ok: true, schemaVersion: 1, ...(await serverAckAttention(await readJsonBody(req), url)) });
  if (req.method === "GET" && url.pathname === "/api/v1/root-sessions") return sendJson(res, 200, { ok: true, schemaVersion: 1, rootSessions: listRootSessions() });
  if (req.method === "POST" && url.pathname === "/api/v1/root-sessions") return sendJson(res, 200, { ok: true, schemaVersion: 1, rootSession: await createOrResumeRootSession(await readJsonBody(req)) });
  if (url.pathname.startsWith("/api/v1/root-sessions/")) return await handleRootSessionApi(req, res, url);
  if (req.method === "GET" && url.pathname === "/api/v1/artifacts") return sendJson(res, 200, { ok: true, schemaVersion: 1, artifacts: listArtifacts() });
  if (req.method === "GET" && url.pathname === "/api/v1/dashboard") return sendJson(res, 200, { ok: true, ...buildDashboard() });
  if (req.method === "GET" && url.pathname === "/api/v1/operations") return sendJson(res, 200, { ok: true, ...buildOperations() });
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
      const timeline = buildTimeline(rootSessionId, { limit: limitParam(url) });
      if (!timeline) return sendJson(res, 404, { ok: false, error: "Workstream not found" });
      return sendJson(res, 200, { ok: true, ...timeline });
    }
  }
  if (req.method === "GET" && url.pathname === "/api/v1/attention") return sendJson(res, 200, { ok: true, ...buildAttention() });
  if (req.method === "GET" && url.pathname === "/api/v1/timeline") return sendJson(res, 200, { ok: true, ...buildTimeline(undefined, { limit: limitParam(url) }) });
  if (req.method === "GET" && url.pathname === "/api/v1/history") return sendJson(res, 200, { ok: true, ...buildHistory() });
  return sendJson(res, 404, { ok: false, error: "Not found" });
}

function handleSse(req: IncomingMessage, res: ServerResponse, ctx: { token?: string; clients: Set<ServerResponse> }) {
  if (!authorized(req, ctx.token)) return sendJson(res, 401, { ok: false, error: "Unauthorized" });
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`retry: 5000\nevent: hello\ndata: ${JSON.stringify({ schemaVersion: 1, time: new Date().toISOString() })}\n\n`);
  const heartbeat = setInterval(() => res.write(`: heartbeat ${new Date().toISOString()}\n\n`), 15000);
  ctx.clients.add(res);
  req.on("close", () => { clearInterval(heartbeat); ctx.clients.delete(res); });
}

function broadcastSse(clients: Set<ServerResponse>, name: string, payload: unknown) {
  const eventId = typeof payload === "object" && payload && "eventId" in payload ? String((payload as any).eventId) : `sse_${Date.now()}`;
  const text = `id: ${eventId}\nevent: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) client.write(text);
}

function listAgents(cwd?: string): Array<AgentMetadata & { metrics?: unknown; attachCommand?: string; activityCommand: string; resultCommand: string }> {
  return listMetadata(cwd).map((agent) => {
    const metrics = readMetrics(agent.runDir);
    const prefix = `cd ${shellQuote(agent.cwd)} &&`;
    const activityCommand = `${prefix} tango activity ${shellQuote(agent.name)} --lines 200`;
    return {
      ...agent,
      ...(metrics ? { metrics } : {}),
      attachCommand: agent.mode === "interactive" ? `${prefix} tango attach ${shellQuote(agent.name)}` : undefined,
      activityCommand,
      resultCommand: `${prefix} tango result ${shellQuote(agent.name)}`,
    };
  });
}

function resolveServerTarget(url: URL, body: any = {}): AgentMetadata {
  const name = stringParam(body?.name) ?? url.searchParams.get("name") ?? undefined;
  const runId = stringParam(body?.runId) ?? url.searchParams.get("runId") ?? url.searchParams.get("run-id") ?? undefined;
  const runDir = stringParam(body?.runDir) ?? url.searchParams.get("runDir") ?? url.searchParams.get("run-dir") ?? undefined;
  const cwd = resolve(stringParam(body?.cwd) ?? url.searchParams.get("cwd") ?? process.cwd());
  if (!name && !runId && !runDir) throw new HttpError(400, "bad_request", "Target required: pass name, runId, or runDir.");
  try {
    return resolveTarget({ name, cwd, runId, runDir, env: process.env as any });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found/i.test(message)) throw new HttpError(404, "run_not_found", message);
    if (/ambiguous/i.test(message)) throw new HttpError(409, "ambiguous_target", message);
    throw new HttpError(400, "bad_target", message);
  }
}

async function serverStartRun(input: any): Promise<{ agent: AgentMetadata; command: unknown; state?: unknown }> {
  const result = await startAgent({
    name: requiredString(input?.name, "name"),
    roleName: stringParam(input?.roleName) ?? stringParam(input?.role),
    harness: stringParam(input?.harness),
    mode: stringParam(input?.mode) as any,
    model: stringParam(input?.model),
    thinking: stringParam(input?.thinking) as any,
    effort: stringParam(input?.effort),
    cwd: resolve(requiredString(input?.cwd, "cwd")),
    task: stringParam(input?.task) ?? "",
    clean: input?.clean === true,
    attach: false,
    dryRun: input?.dryRun === true,
    recursive: typeof input?.recursive === "boolean" ? input.recursive : undefined,
    resultRequired: typeof input?.resultRequired === "boolean" ? input.resultRequired : undefined,
    json: true,
  });
  return { agent: result.meta, command: result.command, state: result.meta.runDir ? buildRunState(result.meta) : undefined };
}

async function serverMessageRun(input: any, url: URL): Promise<{ agent: AgentMetadata; state: unknown }> {
  const meta = resolveServerTarget(url, input);
  messageRun(meta, requiredString(input?.message, "message"));
  return { agent: meta, state: buildRunState(meta) };
}

async function serverReportRun(input: any): Promise<{ agent: AgentMetadata; state: unknown }> {
  const runDir = requiredString(input?.runDir ?? process.env.TANGO_RUN_DIR, "runDir");
  const agent = reportRun(runDir, requiredString(input?.state, "state") as any, stringParam(input?.summary) ?? stringParam(input?.message) ?? "", {
    needs: stringParam(input?.needs),
    resultFile: stringParam(input?.resultFile),
    summaryOnly: input?.summaryOnly === true,
  });
  return { agent, state: buildRunState(agent) };
}

async function serverStopRun(input: any, url: URL): Promise<{ agent: AgentMetadata; state: unknown }> {
  const meta = resolveServerTarget(url, input);
  const agent = stopRun(meta);
  return { agent, state: buildRunState(agent) };
}

async function serverFollowRun(input: any, url: URL): Promise<{ agent: AgentMetadata; state: unknown; resultAssessment: unknown; condition: string }> {
  const meta = resolveServerTarget(url, input);
  const until = stringParam(input?.until) ?? url.searchParams.get("until") ?? "terminal";
  if (!["terminal", "result-resolved", "attention"].includes(until)) throw new HttpError(400, "bad_follow_condition", "Invalid follow condition.");
  const timeoutMs = Math.max(0, Number(input?.timeoutMs ?? input?.timeout ?? 0));
  const result = await followRun(meta, until as any, timeoutMs);
  return { ...result, condition: until };
}

function serverEvents(url: URL): { events: unknown[]; errors: string[]; truncated: boolean; cursor: string } {
  const limit = limitParam(url);
  const recent = readRecentEvents(limit, 1024 * 1024);
  return { ...recent, cursor: String(Date.now()) };
}

async function serverAckAttention(input: any, url: URL): Promise<{ record?: unknown; state: "seen" | "handled" }> {
  const meta = resolveServerTarget(url, input);
  const eventId = requiredString(input?.eventId, "eventId");
  const recipient = {
    runId: stringParam(input?.recipientRunId),
    runDir: stringParam(input?.recipientRunDir),
    rootSessionId: stringParam(input?.recipientRootSessionId),
  };
  const state = input?.state === "handled" ? "handled" : "seen";
  const record = state === "handled" ? markHandled(recipient, meta.runDir, eventId) : markSeen(recipient, meta.runDir, eventId);
  return { record, state };
}

async function handleRootSessionApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  const parts = url.pathname.split("/");
  const rootSessionId = decodeURIComponent(parts[4] ?? "");
  if (!safeId(rootSessionId)) return sendJson(res, 400, { ok: false, error: "Invalid root session id" });
  const record = listRootSessions().find((r) => r.rootSessionId === rootSessionId);
  if (req.method === "GET" && parts.length === 5) {
    if (!record) return sendJson(res, 404, { ok: false, error: "Root session not found" });
    return sendJson(res, 200, { ok: true, schemaVersion: 1, rootSession: record });
  }
  if (req.method === "POST" && parts.length === 6 && parts[5] === "resume") {
    const input = await readJsonBody(req);
    return sendJson(res, 200, { ok: true, schemaVersion: 1, rootSession: await createOrResumeRootSession({ ...input, rootSessionId }) });
  }
  if (req.method === "GET" && parts.length === 6 && parts[5] === "runs") {
    if (!record) return sendJson(res, 404, { ok: false, error: "Root session not found" });
    const runs = listMetadata(undefined)
      .filter((agent) => agent.rootSessionId === rootSessionId || agent.workstreamId === record.workstreamId)
      .map((agent) => buildRunState(agent));
    return sendJson(res, 200, { ok: true, schemaVersion: 1, runs });
  }
  if (req.method === "GET" && parts.length === 6 && parts[5] === "events") {
    if (!record) return sendJson(res, 404, { ok: false, error: "Root session not found" });
    const recent = readRecentEvents(limitParam(url), 1024 * 1024);
    const events = recent.events.filter((event) => event.rootSessionId === rootSessionId || event.workstreamId === record.workstreamId);
    return sendJson(res, 200, { ok: true, schemaVersion: 1, events, errors: recent.errors, truncated: recent.truncated, cursor: String(Date.now()) });
  }
  return sendJson(res, 404, { ok: false, error: "Not found" });
}

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.length) throw new HttpError(400, "missing_field", `Missing required field: ${name}`);
  return value;
}

function isRootSessionKind(value: unknown): value is RootSessionRecord["kind"] {
  return typeof value === "string" && ["pi", "claude", "gemini", "generic", "cli", "dashboard", "sdk", "restored"].includes(value);
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
    kind: isRootSessionKind(input?.kind) ? input.kind : (isRootSessionKind(input?.origin) ? input.origin : "cli"),
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
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
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
  <p class="muted">Prototype dashboard. Prefer Authorization: Bearer tokens; query tokens remain for local compatibility.</p>
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
      '<div><code>' + esc(a.activityCommand) + '</code><button onclick="copy(this.previousElementSibling.textContent)">copy activity</button></div>' +
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
const es = new EventSource('/api/v1/events' + auth);
es.addEventListener('event', () => load());
</script>
</body>
</html>`;
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > 1024 * 1024) throw new Error("Request body too large");
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.trim() ? JSON.parse(text) : {};
}

function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

function bodyWithinLimit(req: IncomingMessage, maxBytes: number): boolean {
  const length = req.headers["content-length"];
  if (typeof length !== "string") return true;
  const bytes = Number(length);
  return Number.isFinite(bytes) && bytes <= maxBytes;
}

function limitParam(url: URL): number | undefined {
  const raw = url.searchParams.get("limit");
  if (!raw) return undefined;
  if (!/^\d+$/.test(raw)) throw new Error("Invalid limit: expected a positive integer.");
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1 || n > 1000) throw new Error("Invalid limit: expected 1-1000.");
  return n;
}

function authorized(req: IncomingMessage, token?: string): boolean {
  if (!token) return true;
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
