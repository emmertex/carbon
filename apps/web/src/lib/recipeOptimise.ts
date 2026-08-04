import { getServerConfig, authHeaders } from './config';
import type { CupConvention } from './recipe';

function joinUrl(base: string, path: string): string {
  return base.replace(/\/$/, '') + path;
}

/**
 * Ask the server's NL agent to rewrite a recipe note into something the scaler can
 * read — a real Ingredients section, a Serves line, metric amounts.
 *
 * The result is a *proposal*: the caller previews it and the user decides. Which is
 * why an empty or whitespace-only completion is thrown rather than returned — a
 * truncated or refused generation applied to the note would erase the recipe, and
 * the failure would look exactly like a successful rewrite.
 */
export async function optimiseRecipe(body: string, convention: CupConvention): Promise<string> {
  const cfg = getServerConfig();
  if (!cfg.url) throw new Error('Connect to a server to use the assistant.');
  const res = await fetch(joinUrl(cfg.url, '/api/agent/recipe/optimise'), {
    method: 'POST',
    headers: authHeaders(cfg),
    body: JSON.stringify({ body, convention }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: unknown };
    const code = typeof err.error === 'string' ? err.error : '';
    if (res.status === 503 || code === 'nl_not_configured') {
      throw new Error('Set up the assistant in Settings → Integrations.');
    }
    if (res.status === 413) throw new Error('This note is too long to optimise.');
    // 504 is our own timeout, or a reverse proxy's. Either way the model was probably
    // still working, so say so — "Assistant error" reads as a broken agent and sends
    // people to check a configuration that is fine.
    if (res.status === 504 || code === 'optimise_timeout') {
      throw new Error('The assistant took too long to answer. Try again, or shorten the note.');
    }
    throw new Error(`Assistant error (${res.status}).`);
  }
  const data = (await res.json().catch(() => ({}))) as { text?: unknown };
  const text = typeof data.text === 'string' ? data.text : '';
  if (!text.trim()) throw new Error('The assistant returned nothing — try again.');
  return text;
}
