// ----- CORS (A2) -------------------------------------------------------------
// The host app mounts one explicit `cors()` config on /api/* and /host/*. Built here
// (not inline in index.ts) so the semantics are unit-testable without importing the
// entry module (which opens real data dirs at load).
//
// Rules:
// - allowHeaders is NON-EMPTY and fixed. The browser only ever sends Content-Type and
//   Authorization on our API (authHeaders in apps/web/src/lib/config.ts; no custom
//   headers in the web client or external integrations). Setting it also keeps the
//   cors middleware from ever reading the attacker-controlled
//   Access-Control-Request-Headers header — the parse the GHSA-8j4g-w8fx-2239 ReDoS
//   ran on when allowHeaders was the empty default. (hono >= 4.12.34 also ships the
//   fixed middleware; see docs/internal/a2/dependency-audit.md.)
// - allowMethods: the verbs the API actually serves.
// - maxAge: cache preflights for an hour.
// - origins: the CORS_ORIGINS allowlist when non-empty. When empty: a single-tenant
//   self-host (no BASE_DOMAIN) keeps the '*' wildcard — auth is a header, never
//   cookies, so a wildcard carries no CSRF surface and the native shells usually hit
//   the same origin anyway. A hosted multi-tenant apex (BASE_DOMAIN set) DENIES
//   cross-origin: an empty allowlist means the middleware sets no
//   Access-Control-Allow-Origin, so no other site's page can read a tenant's API.
import { cors } from "hono/cors";
import type { MiddlewareHandler } from "hono";

export const CORS_ALLOW_HEADERS = ["content-type", "authorization"];
export const CORS_ALLOW_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
];
export const CORS_MAX_AGE = 3600;

/** Origin option for `cors()`: explicit list; else deny (apex) or '*' (single). */
export function corsOriginOption(opts: {
  origins: string[];
  baseDomain: boolean;
}): string | string[] {
  if (opts.origins.length) return opts.origins;
  return opts.baseDomain ? [] : "*";
}

export function buildCorsMw(opts: {
  origins: string[];
  baseDomain: boolean;
}): MiddlewareHandler {
  return cors({
    origin: corsOriginOption(opts),
    allowHeaders: CORS_ALLOW_HEADERS,
    allowMethods: CORS_ALLOW_METHODS,
    maxAge: CORS_MAX_AGE,
  });
}
