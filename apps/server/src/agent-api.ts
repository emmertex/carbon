/**
 * Natural-language agent API — `/api/agent/*`.
 *
 * Thin HTTP layer over `createAgentOps` (see ./agent-ops): each route unwraps the request,
 * calls the matching in-process operation, and maps its `OpResult` onto a JSON response. The
 * same ops back the in-app command tool-loop (./agent-command), so both surfaces behave
 * identically. See ./agent-ops for the design notes (minimal-by-default, per-item write gate,
 * matched/unmatched envelopes).
 */
import type { Hono, Context } from 'hono';
import { requireScope, type AuthVars } from './auth';
import { createAgentOps, type AgentApiDeps, type OpResult, type ListRef } from './agent-ops';

export type { AgentApiDeps } from './agent-ops';

type Env = { Variables: AuthVars };
type App = Hono<Env>;

/** Register all `/api/agent/*` routes on the given Hono app. */
export function registerAgentApi(api: App, deps: AgentApiDeps): void {
  const ops = createAgentOps(deps);

  // Marshal an OpResult onto the Hono response.
  const send = (c: Context<Env>, r: OpResult<unknown>) =>
    c.json(r.ok ? (r.data as object) : { error: r.error }, r.status as 200);

  api.get('/agent/lists', requireScope('tasks:read'), (c) =>
    send(c, ops.lists(c.get('userId'), { detail: c.req.query('detail') === '1' })),
  );

  api.get('/agent/tags', requireScope('tasks:read'), (c) =>
    send(c, ops.tags(c.get('userId'), { detail: c.req.query('detail') === '1' })),
  );

  api.get('/agent/items', requireScope('tasks:read'), (c) =>
    send(
      c,
      ops.items(c.get('userId'), {
        list: c.req.query('list') ?? undefined,
        tag: c.req.query('tag') ?? undefined,
        q: c.req.query('q') ?? undefined,
        status: c.req.query('status') ?? undefined,
        type: c.req.query('type') ?? undefined,
        limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
        detail: c.req.query('detail') === '1',
      }),
    ),
  );

  // Note-content search: matches against items.note (not just title), returning snippets.
  api.get('/agent/notes/search', requireScope('tasks:read'), (c) =>
    send(
      c,
      ops.searchNotes(c.get('userId'), {
        q: c.req.query('q') ?? undefined,
        list: c.req.query('list') ?? undefined,
        tag: c.req.query('tag') ?? undefined,
        type: c.req.query('type') ?? undefined,
        include_done:
          c.req.query('include_done') == null
            ? undefined
            : c.req.query('include_done') === '1',
        limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
      }),
    ),
  );

  api.get('/agent/items/:id', requireScope('tasks:read'), (c) =>
    send(c, ops.item(c.get('userId'), c.req.param('id'))),
  );

  // POST (not GET) so a multi-word `q` doesn't fight querystring encoding.
  api.post('/agent/resolve', requireScope('tasks:read'), async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as {
      kind?: string;
      q?: string;
      list?: ListRef;
      limit?: number;
    };
    return send(c, ops.resolve(c.get('userId'), b));
  });

  api.post('/agent/tasks/batch', requireScope('inbox:write'), async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Parameters<typeof ops.addTasks>[1];
    return send(c, ops.addTasks(c.get('userId'), b));
  });

  api.post('/agent/tasks/complete', requireScope('tasks:write'), async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Parameters<typeof ops.complete>[1];
    return send(c, ops.complete(c.get('userId'), b));
  });

  api.post('/agent/tasks/update', requireScope('tasks:write'), async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Parameters<typeof ops.update>[1];
    return send(c, ops.update(c.get('userId'), b));
  });

  api.post('/agent/tasks/tag', requireScope('tasks:write'), async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Parameters<typeof ops.tagItems>[1];
    return send(c, ops.tagItems(c.get('userId'), b));
  });

  api.post('/agent/tags/geo', requireScope('tasks:write'), async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Parameters<typeof ops.tagGeo>[1];
    return send(c, await ops.tagGeo(c.get('userId'), b));
  });

  // The assignable/shareable roster (real users).
  api.get('/agent/users', requireScope('tasks:read'), (c) => send(c, ops.users(c.get('userId'))));

  api.post('/agent/tasks/share', requireScope('tasks:write'), async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Parameters<typeof ops.share>[1];
    return send(c, ops.share(c.get('userId'), b));
  });

  api.post('/agent/tasks/assign', requireScope('tasks:write'), async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Parameters<typeof ops.assign>[1];
    return send(c, ops.assign(c.get('userId'), b));
  });

  api.post('/agent/timer/start', requireScope('tasks:write'), async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Parameters<typeof ops.startTimer>[1];
    return send(c, ops.startTimer(c.get('userId'), b));
  });

  api.post('/agent/timer/stop', requireScope('tasks:write'), (c) => send(c, ops.stopTimer(c.get('userId'))));

  // Read-only place lookup: returns nearby candidates for the location editor. No mutation,
  // so tasks:read; browser sessions pass requireScope automatically.
  api.post('/agent/geocode', requireScope('tasks:read'), async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Parameters<typeof ops.geocodeSearch>[1];
    return send(c, await ops.geocodeSearch(c.get('userId'), b));
  });

  api.get('/agent/nearby', requireScope('tasks:read'), async (c) => {
    const lat = Number(c.req.query('lat'));
    const lng = Number(c.req.query('lng'));
    return send(
      c,
      await ops.nearby(c.get('userId'), {
        tag: c.req.query('tag') ?? undefined,
        zone: c.req.query('zone') ?? undefined,
        lat: Number.isFinite(lat) ? lat : undefined,
        lng: Number.isFinite(lng) ? lng : undefined,
        near_name: c.req.query('near_name') ?? undefined,
      }),
    );
  });
}
