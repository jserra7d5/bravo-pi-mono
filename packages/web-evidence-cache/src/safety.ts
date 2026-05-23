import dns from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { toolExecutionError } from "./errors.js";

const METADATA_HOSTS = new Set(["169.254.169.254", "metadata.google.internal"]);

export function canonicalizeUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch (cause) {
    throw toolExecutionError(`Invalid URL: ${input}`, "Pass a valid absolute http(s) URL or a web_search result alias/ID.", cause);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw toolExecutionError(`Blocked unsupported URL protocol: ${url.protocol}`, "Use only http:// or https:// URLs.");
  }
  if (url.username || url.password) {
    throw toolExecutionError("Blocked URL with embedded credentials.", "Remove credentials from the URL before fetching.");
  }
  url.hash = "";
  return url.toString();
}

function hostLooksLocal(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost") || METADATA_HOSTS.has(h);
}

function isBlockedIp(address: string): boolean {
  if (address === "169.254.169.254") return true;
  const parsed = ipaddr.parse(address);
  const range = parsed.range();
  return range !== "unicast";
}

export async function assertSafeUrl(input: string): Promise<string> {
  const canonical = canonicalizeUrl(input);
  const url = new URL(canonical);
  if (hostLooksLocal(url.hostname)) {
    throw toolExecutionError(`Blocked local or metadata hostname: ${url.hostname}`, "Use a public web URL.");
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  } catch (cause) {
    throw toolExecutionError(`Could not resolve host: ${url.hostname}`, "Check the URL host and retry.", cause);
  }
  if (!addresses.length) {
    throw toolExecutionError(`Could not resolve host: ${url.hostname}`, "Check the URL host and retry.");
  }
  for (const { address } of addresses) {
    if (isBlockedIp(address)) {
      throw toolExecutionError(`Blocked private or non-public network target: ${url.hostname} resolved to ${address}`, "Use a public web URL.");
    }
  }
  return canonical;
}

export async function assertSafeRedirect(fromUrl: string, location: string): Promise<string> {
  const next = new URL(location, fromUrl).toString();
  return assertSafeUrl(next);
}

export const testInternals = { isBlockedIp, hostLooksLocal };
