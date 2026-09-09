import type { MiddlewareHandler } from 'hono';
import { getItem, type Db } from '@carbon/core';
import type { AuthVars } from './auth';

/** Current ancestry, not a grant-time snapshot: moves and revocation take effect immediately. */
export function withinKeyProjects(db: Db, roots: string[] | null | undefined, id: string): boolean {
  if (roots == null) return true;
  const seen = new Set<string>();
  let current: string | null = id;
  while (current && !seen.has(current)) {
    seen.add(current);
    const item = getItem(db, current);
    if (!item || item.deleted) return false;
    if (roots.includes(current)) return true;
    current = item.parent_id;
  }
  return false;
}

/** Personal keys deliberately expose the documented task REST contract only.
 * Sync, AI, federation, credentials, user settings and administrative surfaces
 * are denied before their handlers can run. Existing integration keys retain
 * their old contract; all scoped keys use this guard. */
export function personalKeyGuard(db: Db): MiddlewareHandler<{ Variables: AuthVars }> {
  return async (c, next) => {
    if (c.get('authMethod') !== 'token') return next();
    const roots = c.get('tokenProjectIds');
    if (!c.get('tokenRestOnly') && roots == null) return next();
    const path = c.req.path.replace(/^\/api/, '');
    const match = /^\/tasks(?:\/([^/]+)(?:\/(complete|comments))?)?$/.exec(path);
    if (!match) return c.json({ error: 'This API key supports the task REST API only.' }, 403);
    const id = match[1] ? decodeURIComponent(match[1]) : null;
    if (id && !withinKeyProjects(db, roots, id)) return c.json({ error: 'outside_key_projects' }, 403);
    if (roots != null && (c.req.method === 'POST' || c.req.method === 'PATCH')) {
      const body = await c.req.json().catch(() => ({}));
      if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'invalid_body' }, 400);
      if (id && roots.includes(id) && match[2] === 'complete') return c.json({ error: 'cannot_complete_key_root' }, 403);
      const destination = id ? body.parent_id : body.project_id;
      if ((!id || 'parent_id' in body) &&
          (typeof destination !== 'string' || !withinKeyProjects(db, roots, destination)))
        return c.json({ error: 'outside_key_projects' }, 403);
      // Moving a scope root would move descendants beyond the key's boundary.
      if (id && roots.includes(id) && 'parent_id' in body)
        return c.json({ error: 'cannot_move_key_root' }, 403);
    }
    return next();
  };
}
