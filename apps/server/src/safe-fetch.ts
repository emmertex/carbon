import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// ----- SSRF guard for admin-supplied endpoints ------------------------------
// Agent endpoints, webhooks, and CalDAV server URLs are all admin-supplied, so a
// malicious/curious tenant admin could point one at internal services or cloud
// metadata (169.254.169.254) and read the reflected response. We therefore block
// private/loopback/link-local targets by default. Self-hosters legitimately point
// at LAN services (e.g. an LLM on 10.x, or a Radicale box), so the caller decides
// per request whether to allow private hosts (`allowPrivate`): single-tenant
// self-host always allows; in multi-tenant mode a host admin opts a workspace in
// (allow_private_endpoints), and ALLOW_PRIVATE_AGENT_ENDPOINTS=1 forces the allow
// globally. See index.ts `agentsAllowPrivate`.

export function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (
      v.startsWith("fe8") ||
      v.startsWith("fe9") ||
      v.startsWith("fea") ||
      v.startsWith("feb")
    )
      return true; // fe80::/10 link-local
    if (v.startsWith("fc") || v.startsWith("fd")) return true; // fc00::/7 ULA
    const m = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/);
    if (m) return isPrivateIp(m[1]);
    return false;
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true; // unparseable → treat unsafe
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata endpoint
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (100.64/10)
  return false;
}

/** A problem the admin can fix from settings; safe to surface to the user. */
export class EndpointError extends Error {}

export async function assertSafeEndpoint(
  rawUrl: string,
  allowPrivate: boolean,
): Promise<void> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new EndpointError("the endpoint URL is not a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new EndpointError(
      "the endpoint URL must start with http:// or https://",
    );
  if (allowPrivate) return;
  // Blocked private/LAN target: the workspace admin can't self-fix this — a host
  // operator must enable private endpoints for the workspace. Say so explicitly.
  const blocked =
    "this workspace cannot reach private/loopback/LAN endpoints — ask the operator to enable private endpoints for this workspace";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost"))
    throw new EndpointError(blocked);
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new EndpointError(blocked);
    return;
  }
  const addrs = await lookup(host, { all: true });
  for (const { address } of addrs) {
    if (isPrivateIp(address)) throw new EndpointError(blocked);
  }
}

/** Default outbound request timeout. Without it a hung upstream (TCP accepted, no
 *  response) would stall the caller indefinitely — the server-side `[timeout:..]` in an
 *  Overpass QL is not a socket timeout. */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * fetch() that first refuses internal/loopback targets (see assertSafeEndpoint) and
 * applies a socket timeout. Pass `timeoutMs` to override (0 disables). If the caller
 * supplies its own `init.signal` we respect it and skip the internal timeout.
 */
export async function safeFetch(
  url: string,
  allowPrivate: boolean,
  init?: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  await assertSafeEndpoint(url, allowPrivate);
  if (init?.signal || timeoutMs <= 0) return fetch(url, init);
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
