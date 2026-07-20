import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

/**
 * When TRUST_PROXY=1, prefer the last X-Forwarded-For hop (the address our reverse
 * proxy appends). Otherwise ignore XFF entirely — clients can prepend arbitrary hops.
 * Default is TCP peer only so per-IP rate limits cannot be bypassed by rotating XFF.
 */
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

/** Header the host dispatcher stamps before forwarding into a tenant app (never trust
 *  a client-supplied value of the same name — always overwrite). */
export const CARBON_REAL_IP_HEADER = 'x-carbon-real-ip';

/**
 * Resolve the client IP for rate limiting.
 * 1. Prefer the TCP remote address from the Node connection.
 * 2. Only if TRUST_PROXY=1, fall back to the last X-Forwarded-For hop.
 * 3. Otherwise 'unknown'.
 */
export function clientIp(c: Context): string {
  try {
    const addr = getConnInfo(c).remote.address;
    if (addr) return addr;
  } catch {
    /* app.fetch() without a Node server adapter — no conninfo */
  }
  if (TRUST_PROXY) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
      const hops = xff.split(',');
      const last = hops[hops.length - 1]?.trim();
      if (last) return last;
    }
  }
  return 'unknown';
}

/** Read the host-stamped real IP inside a tenant sub-app (set by the /api dispatcher). */
export function stampedClientIp(c: Context): string {
  return c.req.header(CARBON_REAL_IP_HEADER)?.trim() || 'unknown';
}
