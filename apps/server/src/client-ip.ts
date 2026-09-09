import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { isIP } from 'node:net';

/**
 * Client-IP resolution for rate limiting / lockout (A2).
 *
 * Default (TRUST_PROXY unset): the TCP peer only. Clients can prepend arbitrary
 * X-Forwarded-For hops, so without a trusted proxy in front, XFF is never read —
 * per-IP limits cannot be bypassed by rotating XFF.
 *
 * TRUST_PROXY=1 — the server sits behind a reverse proxy that appends the address
 * it observed to the XFF chain. Two modes:
 *
 *  - TRUST_PROXY_CIDRS set (comma-separated IPv4 CIDRs or IPs of the proxy fronting
 *    the server): nginx-style walk. Each proxy appends its observed upstream, so the
 *    rightmost XFF entry is either the real client (exactly one proxy) or the
 *    innermost proxy (a chain). Walk right-to-left skipping entries inside the
 *    trusted CIDRs; the first non-trusted entry is the client. If the TCP peer is
 *    not itself a trusted proxy, the whole XFF is client-contaminated — return the
 *    TCP peer. If every entry is trusted (pathological), return the TCP peer.
 *
 *  - TRUST_PROXY_CIDRS unset (legacy default): take the last XFF hop. Correct ONLY
 *    when exactly one trusted proxy fronts the server and appends the real client —
 *    with a proxy chain the last hop is the innermost proxy, not the client, so
 *    per-IP limits degrade to per-proxy limits. A one-time warning is logged
 *    telling the operator to set TRUST_PROXY_CIDRS in that case.
 *
 * When the proxy appends nothing (no XFF at all), the only unspoofable address is
 * the proxy's own TCP peer — return it.
 *
 * Env is read per call (not at module load) so tests can switch modes.
 */

let warnedLegacy = false;

/** Header the host dispatcher stamps before forwarding into a tenant app (never trust
 *  a client-supplied value of the same name — always overwrite). */
export const CARBON_REAL_IP_HEADER = 'x-carbon-real-ip';

function ipv4ToLong(ip: string): number | null {
  if (isIP(ip) !== 4) return null;
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

/** True when `ip` is inside any of the CIDRs (IPv4 `a.b.c.d[/n]`; a bare address is
 *  an exact match; non-IPv4 entries are compared exactly — no IPv6 CIDR math). */
export function ipInAnyCidr(ip: string, cidrs: string[]): boolean {
  const n = ipv4ToLong(ip);
  if (n === null) return cidrs.some((c) => c === ip);
  return cidrs.some((c) => {
    const [addr, bits] = c.split('/');
    const base = ipv4ToLong(addr);
    if (base === null) return false;
    if (bits === undefined) return n === base;
    const b = Number(bits);
    if (!Number.isInteger(b) || b < 0 || b > 32) return false;
    const mask = b === 0 ? 0 : (0xffffffff << (32 - b)) >>> 0;
    return (n & mask) === (base & mask);
  });
}

/**
 * Pure XFF resolution (exported for tests; no conninfo). `peer` is the TCP remote
 * address, `xff` the raw header (may be undefined), `cidrs` the trusted proxy CIDRs:
 *  - empty `cidrs` → last hop (single-trusted-proxy assumption — the caller,
 *    clientIp(), decides whether that mode is active and warns once);
 *  - non-empty `cidrs` → the trusted walk above (peer must itself be trusted).
 */
export function xffClientIp(peer: string, xff: string | undefined, cidrs: string[] = []): string {
  const hops = (xff ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  if (!hops.length) return peer;
  if (!cidrs.length) return hops[hops.length - 1];
  if (!ipInAnyCidr(peer, cidrs)) return peer;
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!ipInAnyCidr(hops[i], cidrs)) return hops[i];
  }
  return peer;
}

function trustedCidrs(): string[] {
  return (process.env.TRUST_PROXY_CIDRS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve the client IP for rate limiting.
 * 1. TCP remote address (unspoofable) — always available from a Node server.
 * 2. TRUST_PROXY=1 + TRUST_PROXY_CIDRS: right-to-left XFF walk skipping trusted hops.
 * 3. TRUST_PROXY=1, no CIDRs: last XFF hop (single-trusted-proxy assumption).
 * 4. No proxy / no XFF: the TCP peer (or 'unknown' when there is no conninfo, e.g.
 *    `app.fetch()` in tests without a Node server adapter).
 */
export function clientIp(c: Context): string {
  let peer = 'unknown';
  try {
    const addr = getConnInfo(c).remote.address;
    if (addr) peer = addr;
  } catch {
    /* app.fetch() without a Node server adapter — no conninfo */
  }
  if (process.env.TRUST_PROXY !== '1') return peer;
  if (!trustedCidrs().length && !warnedLegacy) {
    warnedLegacy = true;
    console.warn(
      '[carbon] WARNING: TRUST_PROXY=1 without TRUST_PROXY_CIDRS — taking the last ' +
        'X-Forwarded-For hop, which is correct only when EXACTLY ONE trusted proxy ' +
        'fronts the server. With a proxy chain the last hop is the innermost proxy, ' +
        'not the client. Set TRUST_PROXY_CIDRS to the proxy CIDRs to enable the ' +
        'right-to-left trusted walk.',
    );
  }
  return xffClientIp(peer, c.req.header('x-forwarded-for'), trustedCidrs());
}

/** Read the host-stamped real IP inside a tenant sub-app (set by the /api dispatcher). */
export function stampedClientIp(c: Context): string {
  return c.req.header(CARBON_REAL_IP_HEADER)?.trim() || 'unknown';
}
