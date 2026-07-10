import type { BrowserWorkspaceConfigV1 as C, IngressInspectData } from "./contracts.js";
import { buildTailscaleFunnelStatus, buildTailscaleServeStatus } from "./commands.js";
import { execBounded } from "./process.js";

const warning = "Shared Tailscale Serve state is last-writer-wins. This package never executes apply/remove commands.";
type ObjectValue = Record<string, unknown>;
export interface ParsedServeEndpointV198 { state: "absent" | "exact" | "conflict" | "unavailable"; authority?: string; url?: string; funnelPresent: boolean }
function object(value: unknown): ObjectValue | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined; }
function keysAre(value: ObjectValue, allowed: readonly string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)); }
function endpointAuthorities(web: ObjectValue, port: number): string[] { return Object.keys(web).filter(authority => authority.endsWith(`:${port}`)); }

/** Strictly parses the captured Tailscale 1.98 ipn.ServeConfig projection. */
export function parseServeStatusV198(input: unknown, port: number, target: string): ParsedServeEndpointV198 {
  const root = object(input); if (!root || !keysAre(root, ["TCP", "Web", "AllowFunnel"])) return { state: "unavailable", funnelPresent: false };
  if (Object.keys(root).length === 0) return { state: "absent", funnelPresent: false };
  const tcp = root.TCP === undefined ? {} : object(root.TCP), web = root.Web === undefined ? {} : object(root.Web), allow = root.AllowFunnel === undefined ? {} : object(root.AllowFunnel);
  if (!tcp || !web || !allow) return { state: "unavailable", funnelPresent: false };
  const portKey = String(port), tcpBranch = object(tcp[portKey]), authorities = endpointAuthorities(web, port);
  if (authorities.length > 1) return { state: "conflict", funnelPresent: authorities.some(authority => allow[authority] === true) };
  const authority = authorities[0], funnelPresent = authority ? allow[authority] === true : false;
  if (authority && allow[authority] !== undefined && typeof allow[authority] !== "boolean") return { state: "unavailable", funnelPresent: false };
  if (!tcpBranch && !authority) return { state: "absent", funnelPresent: false };
  if (!tcpBranch || !authority) return { state: "conflict", funnelPresent };
  if (!keysAre(tcpBranch, ["HTTPS"]) || tcpBranch.HTTPS !== true) return { state: "unavailable", funnelPresent };
  const authorityBranch = object(web[authority]);
  if (!authorityBranch || !keysAre(authorityBranch, ["Handlers"])) return { state: "unavailable", funnelPresent };
  const handlers = object(authorityBranch.Handlers);
  if (!handlers || Object.keys(handlers).length !== 1 || !("/" in handlers)) return { state: "conflict", authority, url: `https://${authority}/`, funnelPresent };
  const rootHandler = object(handlers["/"]);
  if (!rootHandler || !keysAre(rootHandler, ["Proxy"]) || typeof rootHandler.Proxy !== "string") return { state: "unavailable", funnelPresent };
  const url = `https://${authority}/`;
  return { state: rootHandler.Proxy === target && !funnelPresent ? "exact" : "conflict", authority, url, funnelPresent };
}

/** Funnel JSON is the same 1.98 ServeConfig projection; only this endpoint's AllowFunnel is relevant. */
export function parseFunnelStatusV198(input: unknown, port: number, expectedAuthority?: string): { state: "absent" | "correlated" | "unavailable"; funnelPresent: boolean } {
  const root = object(input); if (!root || !keysAre(root, ["TCP", "Web", "AllowFunnel"])) return { state: "unavailable", funnelPresent: false };
  if (Object.keys(root).length === 0) return { state: "absent", funnelPresent: false };
  const web = root.Web === undefined ? {} : object(root.Web), allow = root.AllowFunnel === undefined ? {} : object(root.AllowFunnel);
  if (!web || !allow) return { state: "unavailable", funnelPresent: false };
  const authorities = endpointAuthorities(web, port);
  if (authorities.length > 1 || (expectedAuthority && authorities.length === 1 && authorities[0] !== expectedAuthority)) return { state: "unavailable", funnelPresent: false };
  const authority = expectedAuthority ?? authorities[0];
  if (!authority) return { state: "absent", funnelPresent: false };
  const value = allow[authority]; if (value !== undefined && typeof value !== "boolean") return { state: "unavailable", funnelPresent: false };
  return { state: "correlated", funnelPresent: value === true };
}

export async function inspectIngress(c: C): Promise<IngressInspectData> {
  const desired = { httpsPort: c.tailscaleHttpsPort, target: `http://127.0.0.1:${c.listenPort}` as const };
  const base = { desired, funnelPresent: false, warning };
  try {
    const [serveResult, funnelResult] = await Promise.all([execBounded(buildTailscaleServeStatus(c)), execBounded(buildTailscaleFunnelStatus(c))]);
    if (serveResult.code !== 0 || funnelResult.code !== 0) return { ...base, state: "unavailable" };
    const serve = parseServeStatusV198(JSON.parse(serveResult.stdout), desired.httpsPort, desired.target);
    const funnel = parseFunnelStatusV198(JSON.parse(funnelResult.stdout), desired.httpsPort, serve.authority);
    if (serve.state === "unavailable" || funnel.state === "unavailable") return { ...base, state: "unavailable" };
    const funnelPresent = serve.funnelPresent || funnel.funnelPresent;
    const state = funnelPresent ? "conflict" : serve.state;
    return { ...base, funnelPresent, state, ...(serve.url ? { url: serve.url } : {}) };
  } catch { return { ...base, state: "unavailable" }; }
}
