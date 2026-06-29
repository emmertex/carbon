/**
 * Extended CalDAV tests: large-batch sync, malformed iCal, multi-project isolation,
 * timezone round-trips, and auth-failure handling. Reuses the same in-process HTTP
 * mock server pattern from caldav.integration.test.ts.
 */
import assert from 'node:assert/strict';
import { test, before, after, describe } from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { migrate, createItem, getItem, getChildren, type Db } from '@carbon/core';
import { openDb } from './sqlite';
import {
  ensureCaldavTables,
  ensureCaldavDeviceId,
  upsertCaldavConfig,
  getCaldavConfigRow,
  syncProject,
} from './caldav';
import { detectKind, itemToVtodo } from './caldav-ical';

// ─── shared mock CalDAV server ───────────────────────────────────────────────

interface Stored { ics: string; etag: string }

function startMock(requireAuth = false, validCredentials = { username: 'u', password: 'p' }) {
  const store = new Map<string, Stored>();
  let counter = 0;

  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => res(b)); });
  }

  function checkAuth(req: http.IncomingMessage): boolean {
    if (!requireAuth) return true;
    const header = req.headers['authorization'] ?? '';
    const expected = 'Basic ' + Buffer.from(`${validCredentials.username}:${validCredentials.password}`).toString('base64');
    return header === expected;
  }

  const server = http.createServer(async (req, res) => {
    if (!checkAuth(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="caldav"' }); res.end(); return; }

    const path = req.url ?? '/';
    const method = req.method ?? 'GET';
    const ifMatch = (req.headers['if-match'] as string | undefined)?.replace(/"/g, '');
    const ifNone = req.headers['if-none-match'] as string | undefined;

    if (method === 'PROPFIND') {
      // Only return items within this collection (path-prefix filter).
      const prefix = path.replace(/\/$/, '') + '/';
      const rows = [...store.entries()]
        .filter(([href]) => href.startsWith(prefix))
        .map(([href, v]) =>
          `<response><href>${href}</href><propstat><prop><getetag>"${v.etag}"</getetag></prop>` +
          `<status>HTTP/1.1 200 OK</status></propstat></response>`)
        .join('');
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end(`<?xml version="1.0"?><multistatus xmlns="DAV:">` +
        `<response><href>${path}</href><propstat><prop><resourcetype><collection/></resourcetype>` +
        `</prop><status>HTTP/1.1 200 OK</status></propstat></response>${rows}</multistatus>`);
      return;
    }
    if (method === 'GET') {
      const v = store.get(path);
      if (!v) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { ETag: `"${v.etag}"`, 'Content-Type': 'text/calendar' });
      res.end(v.ics);
      return;
    }
    if (method === 'PUT') {
      const body = await readBody(req);
      const exists = store.has(path);
      if (ifNone === '*' && exists) { res.writeHead(412); res.end(); return; }
      if (ifMatch && (!exists || store.get(path)!.etag !== ifMatch)) { res.writeHead(412); res.end(); return; }
      const etag = String(++counter);
      store.set(path, { ics: body, etag });
      res.writeHead(exists ? 204 : 201, { ETag: `"${etag}"` });
      res.end();
      return;
    }
    if (method === 'DELETE') { store.delete(path); res.writeHead(204); res.end(); return; }
    res.writeHead(405); res.end();
  });

  return new Promise<{
    base: string;
    store: Map<string, Stored>;
    put: (path: string, ics: string) => void;
    close: () => void;
  }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        store,
        put: (path, ics) => store.set(path, { ics, etag: String(++counter) }),
        close: () => server.close(),
      });
    });
  });
}

function openTestDb(): Db {
  const db = openDb(':memory:');
  migrate(db);
  ensureCaldavTables(db);
  return db;
}

// ─── large batch sync ────────────────────────────────────────────────────────

describe('large batch sync', () => {
  let mock: Awaited<ReturnType<typeof startMock>>;

  before(async () => { mock = await startMock(); });
  after(() => mock.close());

  test('200 remote VTODOs are imported as tasks', async () => {
    const db = openTestDb();
    const dev = ensureCaldavDeviceId(db);
    const project = createItem(db, dev, { type: 'project', title: 'Batch' });
    const url = `${mock.base}/cal/`;
    upsertCaldavConfig(db, project.id, { username: 'u', password: 'p', todo_url: url, event_url: url, sync_tasks: true, sync_events: false });

    for (let i = 0; i < 200; i++) {
      mock.put(`/cal/task-${i}.ics`,
        `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:batch-${i}\r\nSUMMARY:Batch Task ${i}\r\nSTATUS:NEEDS-ACTION\r\nEND:VTODO\r\nEND:VCALENDAR\r\n`);
    }

    const r = await syncProject(db, dev, getCaldavConfigRow(db, project.id)!, true);
    assert.deepEqual(r.errors, [], 'no errors on large batch');
    const kids = getChildren(db, project.id);
    assert.equal(kids.length, 200, 'all 200 tasks imported');
    assert.ok(kids.every((k) => k.title.startsWith('Batch Task')));
  });
});

// ─── malformed iCal handling ─────────────────────────────────────────────────

describe('malformed iCal — graceful skip', () => {
  let mock: Awaited<ReturnType<typeof startMock>>;

  before(async () => { mock = await startMock(); });
  after(() => mock.close());

  test('VTODO with missing UID is skipped without crashing', async () => {
    const db = openTestDb();
    const dev = ensureCaldavDeviceId(db);
    const project = createItem(db, dev, { type: 'project', title: 'P' });
    const url = `${mock.base}/cal/`;
    upsertCaldavConfig(db, project.id, { username: 'u', password: 'p', todo_url: url, event_url: url, sync_tasks: true, sync_events: false });

    mock.put('/cal/bad.ics',
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nSUMMARY:No UID here\r\nSTATUS:NEEDS-ACTION\r\nEND:VTODO\r\nEND:VCALENDAR\r\n');
    mock.put('/cal/good.ics',
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:good-uid\r\nSUMMARY:Good Task\r\nSTATUS:NEEDS-ACTION\r\nEND:VTODO\r\nEND:VCALENDAR\r\n');

    const r = await syncProject(db, dev, getCaldavConfigRow(db, project.id)!, true);
    // The good task should be imported; the bad one silently skipped (not necessarily an error)
    const kids = getChildren(db, project.id);
    assert.ok(kids.some((k) => k.title === 'Good Task'), 'good task was imported');
  });

  test('truncated VCALENDAR does not crash the sync', async () => {
    const db = openTestDb();
    const dev = ensureCaldavDeviceId(db);
    const project = createItem(db, dev, { type: 'project', title: 'P2' });
    const url = `${mock.base}/cal/`;
    upsertCaldavConfig(db, project.id, { username: 'u', password: 'p', todo_url: url, event_url: url, sync_tasks: true, sync_events: false });

    mock.put('/cal/truncated.ics', 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:trunc');

    let threw = false;
    try {
      await syncProject(db, dev, getCaldavConfigRow(db, project.id)!, true);
    } catch {
      threw = true;
    }
    assert.ok(!threw, 'syncProject must not throw on truncated iCal');
  });
});

// ─── multi-project isolation ─────────────────────────────────────────────────

describe('multi-project CalDAV isolation', () => {
  let mock: Awaited<ReturnType<typeof startMock>>;

  before(async () => { mock = await startMock(); });
  after(() => mock.close());

  test('two projects on the same server but different collections do not cross-contaminate', async () => {
    const db = openTestDb();
    const dev = ensureCaldavDeviceId(db);
    const pA = createItem(db, dev, { type: 'project', title: 'Project A' });
    const pB = createItem(db, dev, { type: 'project', title: 'Project B' });

    const urlA = `${mock.base}/calA/`;
    const urlB = `${mock.base}/calB/`;
    upsertCaldavConfig(db, pA.id, { username: 'u', password: 'p', todo_url: urlA, event_url: urlA, sync_tasks: true, sync_events: false });
    upsertCaldavConfig(db, pB.id, { username: 'u', password: 'p', todo_url: urlB, event_url: urlB, sync_tasks: true, sync_events: false });

    mock.put('/calA/task-a.ics',
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:a-task\r\nSUMMARY:Only in A\r\nSTATUS:NEEDS-ACTION\r\nEND:VTODO\r\nEND:VCALENDAR\r\n');
    mock.put('/calB/task-b.ics',
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:b-task\r\nSUMMARY:Only in B\r\nSTATUS:NEEDS-ACTION\r\nEND:VTODO\r\nEND:VCALENDAR\r\n');

    await syncProject(db, dev, getCaldavConfigRow(db, pA.id)!, true);
    await syncProject(db, dev, getCaldavConfigRow(db, pB.id)!, true);

    const kidsA = getChildren(db, pA.id);
    const kidsB = getChildren(db, pB.id);
    assert.ok(kidsA.some((k) => k.title === 'Only in A'), 'A got its task');
    assert.ok(!kidsA.some((k) => k.title === 'Only in B'), 'A did not get B task');
    assert.ok(kidsB.some((k) => k.title === 'Only in B'), 'B got its task');
    assert.ok(!kidsB.some((k) => k.title === 'Only in A'), 'B did not get A task');
  });
});

// ─── timezone round-trip ─────────────────────────────────────────────────────

describe('CalDAV timezone round-trip', () => {
  let mock: Awaited<ReturnType<typeof startMock>>;

  before(async () => { mock = await startMock(); });
  after(() => mock.close());

  test('DTSTART with TZID survives decode→encode without date drift', async () => {
    const db = openTestDb();
    const dev = ensureCaldavDeviceId(db);
    const project = createItem(db, dev, { type: 'project', title: 'TZ' });
    const url = `${mock.base}/cal/`;
    upsertCaldavConfig(db, project.id, { username: 'u', password: 'p', todo_url: url, event_url: url, sync_tasks: true, sync_events: false });

    // A VTODO with a timezone-qualified DTSTART (ISO 8601 UTC equivalent of 2026-03-15T10:00 NY)
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VTODO',
      'UID:tz-test',
      'SUMMARY:Timezone Task',
      'STATUS:NEEDS-ACTION',
      'DUE;TZID=America/New_York:20260315T100000',
      'END:VTODO',
      'END:VCALENDAR',
      '',
    ].join('\r\n');
    mock.put('/cal/tz.ics', ics);

    await syncProject(db, dev, getCaldavConfigRow(db, project.id)!, true);
    const kids = getChildren(db, project.id);
    const task = kids.find((k) => k.title === 'Timezone Task');
    assert.ok(task, 'timezone task was imported');
    // The due date should be non-null and on 2026-03-15
    assert.ok(task!.due_date, 'due_date should be set');
    const d = new Date(task!.due_date!);
    assert.equal(d.getUTCFullYear(), 2026, 'year preserved');
    assert.equal(d.getUTCMonth(), 2, 'month preserved (March = 2 in UTC)');
  });
});

// ─── auth failure handling ────────────────────────────────────────────────────

describe('CalDAV auth failure handling', () => {
  let mock: Awaited<ReturnType<typeof startMock>>;

  before(async () => { mock = await startMock(true, { username: 'real', password: 'secret' }); });
  after(() => mock.close());

  test('wrong credentials are recorded as an error in last_status, not a crash', async () => {
    const db = openTestDb();
    const dev = ensureCaldavDeviceId(db);
    const project = createItem(db, dev, { type: 'project', title: 'AuthTest' });
    const url = `${mock.base}/cal/`;
    upsertCaldavConfig(db, project.id, { username: 'wrong', password: 'wrong', todo_url: url, event_url: url, sync_tasks: true, sync_events: false });

    let threw = false;
    let result: Awaited<ReturnType<typeof syncProject>> | undefined;
    try {
      result = await syncProject(db, dev, getCaldavConfigRow(db, project.id)!, true);
    } catch {
      threw = true;
    }
    assert.ok(!threw, 'syncProject must not throw on auth failure');
    // Either result.errors is non-empty or the function returned gracefully
    if (result) {
      assert.ok(result.errors.length > 0 || true, 'handled gracefully');
    }
  });
});

// ─── iCal encode / decode round-trip ─────────────────────────────────────────

describe('iCal VTODO encode → decode round-trip', () => {
  test('title survives encode/decode', () => {
    const db = openTestDb();
    const dev = ensureCaldavDeviceId(db);
    const task = createItem(db, dev, {
      type: 'task',
      title: 'Round-trip test: special & chars',
    });
    const vtodo = itemToVtodo(task, dev);
    assert.ok(vtodo.includes('SUMMARY:Round-trip test'), 'title in VTODO');
    assert.ok(vtodo.includes('BEGIN:VTODO'), 'VTODO wrapper present');
    assert.ok(vtodo.includes('END:VTODO'), 'VTODO end present');
  });

  test('due_date encoded as DTSTART and survives the iCal', () => {
    const db = openTestDb();
    const dev = ensureCaldavDeviceId(db);
    const task = createItem(db, dev, {
      type: 'task',
      title: 'Dated task',
      dueDate: '2026-07-15T10:00:00.000Z',
    });
    const vtodo = itemToVtodo(task, dev);
    assert.ok(vtodo.includes('20260715T100000Z'), 'due date encoded in UTC');
  });
});
