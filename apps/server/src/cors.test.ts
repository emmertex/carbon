// A2 — explicit CORS config. Three semantics under test:
//  1. single-tenant self-host (no BASE_DOMAIN, no CORS_ORIGINS): '*' wildcard
//     (header auth, no cookies → no CSRF surface).
//  2. BASE_DOMAIN apex with no CORS_ORIGINS: cross-origin DENIED — no
//     Access-Control-Allow-Origin is ever emitted.
//  3. explicit CORS_ORIGINS: only listed origins are honored.
// And across all of them: the preflight response never reflects the attacker
// controlled Access-Control-Request-Headers — with a fixed non-empty allowHeaders
// the middleware stops reading that header entirely, which is what closes the
// GHSA-8j4g-w8fx-2239 ReDoS surface (a long whitespace run in the header must not
// change the response, and must not burn CPU).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { buildCorsMw, CORS_ALLOW_HEADERS } from "./cors";

function appWith(mw: ReturnType<typeof buildCorsMw>): Hono {
  const app = new Hono();
  app.use("/api/*", mw);
  app.get("/api/health", (c) => c.json({ ok: true }));
  return app;
}

async function preflight(
  app: Hono,
  origin: string,
  extra?: Record<string, string>,
) {
  return app.request("/api/health", {
    method: "OPTIONS",
    headers: { origin, "access-control-request-method": "POST", ...extra },
  });
}

test("single-tenant self-host keeps the header-auth wildcard", async () => {
  const app = appWith(buildCorsMw({ origins: [], baseDomain: false }));
  const res = await preflight(app, "http://evil.example");
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  // allowHeaders is the fixed list — never the request's.
  assert.equal(
    res.headers.get("access-control-allow-headers"),
    CORS_ALLOW_HEADERS.join(","),
  );
  assert.match(res.headers.get("access-control-allow-methods") ?? "", /POST/);
  assert.equal(res.headers.get("access-control-max-age"), "3600");
});

test("BASE_DOMAIN apex denies cross-origin when CORS_ORIGINS is empty", async () => {
  const app = appWith(buildCorsMw({ origins: [], baseDomain: true }));
  const pre = await preflight(app, "http://evil.example");
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), null);
  // A real (non-preflight) cross-origin request also gets no ACAO.
  const get = await app.request("/api/health", {
    headers: { origin: "http://evil.example" },
  });
  assert.equal(get.headers.get("access-control-allow-origin"), null);
});

test("explicit CORS_ORIGINS honors only the listed origins", async () => {
  const origins = ["tauri://localhost", "http://localhost:3042"];
  const app = appWith(buildCorsMw({ origins, baseDomain: true }));
  const good = await preflight(app, origins[0]);
  assert.equal(good.headers.get("access-control-allow-origin"), origins[0]);
  const bad = await preflight(app, "http://evil.example");
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
});

test("preflight never reflects Access-Control-Request-Headers (ReDoS surface closed)", async () => {
  const app = appWith(buildCorsMw({ origins: [], baseDomain: false }));
  // A long whitespace run without delimiters — the quadratic-parse trigger from
  // the advisory. Bounded well under any header-size limit.
  const longRun = "content-type" + " ".repeat(4000);
  const t0 = process.uptime();
  const res = await preflight(app, "http://example.com", {
    "access-control-request-headers": longRun,
  });
  const dtMs = (process.uptime() - t0) * 1000;
  assert.equal(res.status, 204);
  assert.equal(
    res.headers.get("access-control-allow-headers"),
    CORS_ALLOW_HEADERS.join(","),
    "response must carry the fixed list, not the request header",
  );
  // Linear-time handling: the 4KB header must not cost more than a few ms.
  assert.ok(dtMs < 100, `preflight took ${dtMs.toFixed(1)}ms`);
});

test("CalDAV settings PUT preflight advertises the actual route method", async () => {
  const app = appWith(
    buildCorsMw({ origins: ["https://client.example"], baseDomain: true }),
  );
  app.put("/api/projects/:id/caldav", (c) => c.json({ ok: true }));
  const res = await app.request("/api/projects/p/caldav", {
    method: "OPTIONS",
    headers: {
      origin: "https://client.example",
      "access-control-request-method": "PUT",
      "access-control-request-headers": "authorization,content-type",
    },
  });
  assert.equal(res.status, 204);
  assert.ok(
    res.headers.get("access-control-allow-methods")?.split(",").includes("PUT"),
  );
});
