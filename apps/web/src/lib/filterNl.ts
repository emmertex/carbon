import { getServerConfig, authHeaders, localTimezone } from './config';
import { validateFilterExpr, type FilterExpr } from './filter-expr';

function joinUrl(base: string, path: string): string {
  return base.replace(/\/$/, '') + path;
}

/** Ask the server's NL agent to turn a natural-language description into an advanced
 *  filter expression. Validates the returned JSON before handing it back. */
export async function buildFilterFromNl(text: string): Promise<FilterExpr> {
  const cfg = getServerConfig();
  if (!cfg.url) throw new Error('Connect to a server to use the assistant.');
  const res = await fetch(joinUrl(cfg.url, '/api/agent/filter'), {
    method: 'POST',
    headers: authHeaders(cfg),
    body: JSON.stringify({ text, timezone: localTimezone() }),
  });
  if (res.status === 400 || res.status === 404) {
    throw new Error('The assistant isn’t configured. Ask an admin to set up an NL agent.');
  }
  if (!res.ok) throw new Error(`Assistant error (${res.status}).`);
  const data = (await res.json()) as { expr?: unknown; error?: string };
  if (data.error) throw new Error(data.error);
  const expr = validateFilterExpr(data.expr);
  if (!expr) throw new Error('Couldn’t understand that — try rephrasing.');
  return expr;
}
