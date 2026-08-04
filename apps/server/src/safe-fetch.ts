import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent } from "undici";

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

/** Extract the IPv4 address embedded in the low 32 bits of a NAT64 (64:ff9b::/96)
 *  address, in either RFC 6052 dotted-quad form or plain hex-group form. */
function nat64EmbeddedIPv4(rest: string): string | null {
  const dotted = rest.match(/^(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

/** Extract the IPv4 address embedded in an IPv4-mapped IPv6 address (::ffff:0:0/96).
 *  Accepts compressed (`::ffff:…`) and fully-expanded (`0:0:0:0:0:ffff:…`) forms, and
 *  both dotted-quad (`127.0.0.1`) and hex-group (`7f00:1`) suffixes. Returns null when
 *  the address is not IPv4-mapped. */
function ipv4MappedEmbedded(v: string): string | null {
  const rest =
    v.match(/^::ffff:(.+)$/)?.[1] ??
    v.match(/^(?:0:){5}ffff:(.+)$/)?.[1] ??
    null;
  if (!rest) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(rest)) return rest;
  const hex = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

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
    const mapped = ipv4MappedEmbedded(v);
    if (mapped) return isPrivateIp(mapped);
    if (v.startsWith("64:ff9b::")) {
      // NAT64 well-known prefix: embeds an IPv4 address in the low 32 bits.
      const embedded = nat64EmbeddedIPv4(v.slice("64:ff9b::".length));
      if (embedded) return isPrivateIp(embedded);
    }
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

/** Validates rawUrl and, when the target isn't allowed to be private, returns the
 *  resolved+checked addresses so the caller can pin its connection to them (avoiding a
 *  TOCTOU/DNS-rebinding gap between this check and the real connect). Empty array means
 *  "nothing to pin" (allowPrivate). */
async function checkSafeEndpoint(
  rawUrl: string,
  allowPrivate: boolean,
): Promise<{ addresses: string[] }> {
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
  if (allowPrivate) return { addresses: [] };
  // Blocked private/LAN target: the workspace admin can't self-fix this — a host
  // operator must enable private endpoints for the workspace. Say so explicitly.
  const blocked =
    "this workspace cannot reach private/loopback/LAN endpoints — ask the operator to enable private endpoints for this workspace";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost"))
    throw new EndpointError(blocked);
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new EndpointError(blocked);
    return { addresses: [host] };
  }
  const addrs = await lookup(host, { all: true });
  for (const { address } of addrs) {
    if (isPrivateIp(address)) throw new EndpointError(blocked);
  }
  return { addresses: addrs.map((a) => a.address) };
}

/** Throws EndpointError if rawUrl isn't a safe outbound target. */
export async function assertSafeEndpoint(
  rawUrl: string,
  allowPrivate: boolean,
): Promise<void> {
  await checkSafeEndpoint(rawUrl, allowPrivate);
}

/** Default outbound request timeout. Without it a hung upstream (TCP accepted, no
 *  response) would stall the caller indefinitely — the server-side `[timeout:..]` in an
 *  Overpass QL is not a socket timeout. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Redirect hops safeFetch will follow before giving up (matches curl/browser defaults). */
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Headers that authenticate the caller to the host it addressed, and so must not
 * travel past a redirect that leaves that origin: a `302` from a compromised (or
 * plain-`http:`, MITM'd) endpoint to an attacker host would otherwise hand over the
 * agent's API key, a webhook secret, or CalDAV Basic credentials. Mirrors the
 * cross-origin stripping undici and browsers do for `Authorization`/`Cookie`, plus
 * the header names Carbon puts secrets in.
 *
 * The request *body* still follows a 307/308 per spec, so a secret sent in a body
 * (federation's `__link_secret`) is only as safe as the peer origin it was sent to.
 */
const CREDENTIAL_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'x-carbon-secret',
  'x-federation-secret',
];

function stripCredentials(headers: RequestInit["headers"]): Headers {
  const stripped = new Headers(headers ?? {});
  for (const name of CREDENTIAL_HEADERS) stripped.delete(name);
  return stripped;
}

/** A dispatcher whose DNS resolution is pinned to exactly the addresses already
 *  validated by checkSafeEndpoint — so the connection actually made can't differ from
 *  the one that was checked (no re-resolve, no DNS-rebinding window). SNI/Host still use
 *  the original hostname since only the address lookup is overridden. */
function pinnedDispatcher(addresses: string[]): Agent {
  return new Agent({
    connect: {
      lookup: (_hostname, _opts, cb) => {
        cb(
          null,
          addresses.map((address) => ({
            address,
            family: isIP(address) === 6 ? 6 : 4,
          })),
        );
      },
    },
  });
}

/**
 * fetch() that first refuses internal/loopback targets (see assertSafeEndpoint), pins
 * the connection to the addresses it just validated, and applies a socket timeout.
 * Redirects are followed manually (up to MAX_REDIRECTS), re-validating and re-pinning
 * each hop's target — otherwise a public endpoint could 3xx-redirect to a private one
 * (e.g. cloud metadata) and the guard would never see the real destination. Pass
 * `timeoutMs` to override (0 disables). If the caller supplies its own `init.signal` we
 * respect it and skip the internal timeout.
 */
export async function safeFetch(
  url: string,
  allowPrivate: boolean,
  init?: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const signal =
    init?.signal ?? (timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined);
  let current = url;
  let method = init?.method ?? "GET";
  let body = init?.body;
  let headers = init?.headers;
  let origin: string | null = null;
  for (let hop = 0; ; hop++) {
    const { addresses } = await checkSafeEndpoint(current, allowPrivate);
    // Safe to parse: checkSafeEndpoint just did, and threw if it wasn't a URL.
    origin ??= new URL(current).origin;
    const dispatcher = addresses.length ? pinnedDispatcher(addresses) : undefined;
    const res = await fetch(current, {
      ...init,
      method,
      body,
      headers,
      redirect: "manual",
      signal,
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit);
    if (!REDIRECT_STATUSES.has(res.status)) return res;
    const location = res.headers.get("location");
    if (!location) return res;
    if (hop >= MAX_REDIRECTS)
      throw new EndpointError("too many redirects while resolving the endpoint");
    // Per the fetch redirect spec: 303 always downgrades non-GET/HEAD to a bodyless
    // GET; 301/302 do the same but only for POST. 307/308 preserve method and body.
    if (res.status === 303 && method !== "GET" && method !== "HEAD") {
      method = "GET";
      body = undefined;
    } else if ((res.status === 301 || res.status === 302) && method === "POST") {
      method = "GET";
      body = undefined;
    }
    const next = new URL(location, current);
    // Credentials belong to the origin the caller chose. Once the chain leaves it
    // they stop travelling — and they stay gone if a later hop comes back, since
    // `headers` is never restored from `init`.
    if (next.origin !== origin) headers = stripCredentials(headers);
    current = next.toString();
  }
}
