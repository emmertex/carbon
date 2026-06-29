/**
 * Tests for the per-server Telegram bot (telegram.ts): pairing-code create/redeem, the linking
 * FSM, and dispatch into the NL tool-loop. The control DB and a tenant DB are in-memory; the LLM
 * provider is stubbed via globalThis.fetch; the Telegram sender is injected (deps.send) so no
 * network is touched.
 */
import assert from 'node:assert/strict';
import { test, describe, afterEach } from 'node:test';
import { getProjects, getChildren } from '@carbon/core';
import { openControlDb } from './control';
import { createAgent, getAgent, setNlSettings, getAgentUsage } from './agents';
import {
  ensureTelegramTables,
  createTelegramCode,
  redeemTelegramCode,
  getTelegramLinkForUser,
  unlinkTelegramUser,
  handleTelegramUpdate,
  type TelegramDeps,
} from './telegram';
import { makeTestDb, type TestDb } from './test-app';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Scripted OpenAI-shaped chat-completion responses (last repeats), same style as agent-command.test.ts.
function stubLLM(responses: unknown[]) {
  let i = 0;
  globalThis.fetch = (async () => {
    const body = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}
const toolResp = (name: string, args: unknown) => ({
  choices: [
    {
      message: {
        content: '',
        tool_calls: [{ id: `c_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      },
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 4 },
});
const sayResp = (text: string) => ({
  choices: [{ message: { content: text } }],
  usage: { prompt_tokens: 8, completion_tokens: 2 },
});

function makeControlDb() {
  return openControlDb(':memory:');
}

function makeAgentOn(db: TestDb) {
  const a = createAgent(db, {
    name: 'NL',
    username: 'nlbot',
    kind: 'openai',
    endpoint: 'http://llm.test/v1',
    apiKey: 'k',
    model: 'm',
  });
  setNlSettings(db, { agentId: a.id, enabled: true });
  return getAgent(db, a.id)!;
}

/** A fake single-tenant registry: getCtx(null) → the default tenant ctx; anything else → null. */
function makeDeps(opts: {
  controlDb: ReturnType<typeof openControlDb>;
  tenantDb: TestDb;
  deviceId: string;
  baseDomain?: string;
  resolveSubdomain?: (s: string) => string | null;
  sent: Array<{ chatId: string; text: string }>;
}): TelegramDeps {
  const ctx = { id: 'default', subdomain: '', db: opts.tenantDb, serverDeviceId: opts.deviceId } as any;
  return {
    controlDb: opts.controlDb,
    registry: {
      getCtx: (sub: string | null) => (sub === null ? ctx : opts.resolveSubdomain ? ctx : null),
    } as any,
    botToken: 'TESTTOKEN',
    botUsername: 'carbon_test_bot',
    baseDomain: opts.baseDomain,
    resolveSubdomain: opts.resolveSubdomain ?? (() => null),
    allowPrivateFor: () => true,
    send: async (chatId, text) => {
      opts.sent.push({ chatId, text });
    },
  };
}

describe('telegram pairing codes', () => {
  test('create → redeem succeeds once, then is gone', () => {
    const cdb = makeControlDb();
    const { code } = createTelegramCode(cdb, { tenantId: 'default', subdomain: null, userId: 'u1' });
    assert.equal(code.length, 8);
    const r1 = redeemTelegramCode(cdb, code);
    assert.equal(r1.ok, true);
    assert.deepEqual(r1.ok && { t: r1.tenantId, u: r1.userId }, { t: 'default', u: 'u1' });
    // Single-use: a second redemption fails.
    assert.deepEqual(redeemTelegramCode(cdb, code), { ok: false, error: 'bad_code' });
  });

  test('codes are case-insensitive and tolerate spaces/dashes', () => {
    const cdb = makeControlDb();
    const { code } = createTelegramCode(cdb, { tenantId: 'default', subdomain: null, userId: 'u1' });
    const messy = ` ${code.slice(0, 4).toLowerCase()}-${code.slice(4)} `;
    assert.equal(redeemTelegramCode(cdb, messy).ok, true);
  });

  test('creating a new code invalidates the old one', () => {
    const cdb = makeControlDb();
    const first = createTelegramCode(cdb, { tenantId: 'default', subdomain: null, userId: 'u1' }).code;
    createTelegramCode(cdb, { tenantId: 'default', subdomain: null, userId: 'u1' });
    assert.deepEqual(redeemTelegramCode(cdb, first), { ok: false, error: 'bad_code' });
  });

  test('expired code is rejected', () => {
    const cdb = makeControlDb();
    const { code } = createTelegramCode(cdb, { tenantId: 'default', subdomain: null, userId: 'u1' });
    // Force expiry in the past.
    cdb.run('UPDATE telegram_codes SET expires_at = ?', [new Date(Date.now() - 1000).toISOString()]);
    assert.deepEqual(redeemTelegramCode(cdb, code), { ok: false, error: 'expired' });
  });

  test('wrong workspace is rejected and attempts are capped (burns the code)', () => {
    const cdb = makeControlDb();
    const { code } = createTelegramCode(cdb, { tenantId: 't1', subdomain: 'acme', userId: 'u1' });
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(redeemTelegramCode(cdb, code, 'other'), { ok: false, error: 'wrong_workspace' });
    }
    // After CODE_MAX_ATTEMPTS the code is deleted — even the right workspace can't use it now.
    assert.deepEqual(redeemTelegramCode(cdb, code, 'acme'), { ok: false, error: 'bad_code' });
  });

  test('right workspace redeems', () => {
    const cdb = makeControlDb();
    const { code } = createTelegramCode(cdb, { tenantId: 't1', subdomain: 'acme', userId: 'u1' });
    const r = redeemTelegramCode(cdb, code, 'acme');
    assert.equal(r.ok && r.subdomain, 'acme');
  });
});

describe('telegram linking FSM (single-tenant self-host)', () => {
  test('/start → send code → linked; status + unlink work', async () => {
    const cdb = makeControlDb();
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('alice', 'pw');
    const sent: Array<{ chatId: string; text: string }> = [];
    const deps = makeDeps({ controlDb: cdb, tenantDb: db, deviceId, sent });

    await handleTelegramUpdate({ message: { chat: { id: 42 }, text: '/start' } }, deps);
    assert.match(sent.at(-1)!.text, /Settings → Telegram/);

    const { code } = createTelegramCode(cdb, { tenantId: 'default', subdomain: null, userId: uid });
    await handleTelegramUpdate({ message: { chat: { id: 42 }, text: code } }, deps);
    assert.match(sent.at(-1)!.text, /Linked as alice/);

    // The link is now queryable for the Settings readout.
    const link = getTelegramLinkForUser(cdb, 'default', uid);
    assert.equal(link?.username, 'alice');

    // /whoami reflects it; /unlink removes it.
    await handleTelegramUpdate({ message: { chat: { id: 42 }, text: '/whoami' } }, deps);
    assert.match(sent.at(-1)!.text, /linked as alice/i);
    assert.equal(unlinkTelegramUser(cdb, 'default', uid), 1);
    assert.equal(getTelegramLinkForUser(cdb, 'default', uid), null);
  });

  test('bad code gives guidance, does not link', async () => {
    const cdb = makeControlDb();
    const { db, deviceId, addUser } = makeTestDb();
    addUser('alice', 'pw');
    const sent: Array<{ chatId: string; text: string }> = [];
    const deps = makeDeps({ controlDb: cdb, tenantDb: db, deviceId, sent });
    await handleTelegramUpdate({ message: { chat: { id: 7 }, text: '/start' } }, deps);
    await handleTelegramUpdate({ message: { chat: { id: 7 }, text: 'ABCD2345' } }, deps);
    assert.match(sent.at(-1)!.text, /didn't recognise that code/i);
  });
});

describe('telegram linking FSM (multi-tenant)', () => {
  test('/start asks for workspace, then code links', async () => {
    const cdb = makeControlDb();
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('bob', 'pw');
    const sent: Array<{ chatId: string; text: string }> = [];
    const deps = makeDeps({
      controlDb: cdb,
      tenantDb: db,
      deviceId,
      baseDomain: 'carbon.example',
      resolveSubdomain: (s) => (s === 'acme' ? 'acme' : null),
      sent,
    });

    await handleTelegramUpdate({ message: { chat: { id: 9 }, text: '/start' } }, deps);
    assert.match(sent.at(-1)!.text, /Which workspace/i);

    await handleTelegramUpdate({ message: { chat: { id: 9 }, text: 'nope' } }, deps);
    assert.match(sent.at(-1)!.text, /couldn't find a workspace/i);

    await handleTelegramUpdate({ message: { chat: { id: 9 }, text: 'acme' } }, deps);
    assert.match(sent.at(-1)!.text, /send me the code/i);

    const { code } = createTelegramCode(cdb, { tenantId: 'default', subdomain: 'acme', userId: uid });
    await handleTelegramUpdate({ message: { chat: { id: 9 }, text: code } }, deps);
    assert.match(sent.at(-1)!.text, /Linked as bob/);
  });
});

describe('telegram dispatch into the NL loop', () => {
  test('linked chat: "add" runs as the user (creates tasks) and replies conversationally', async () => {
    const cdb = makeControlDb();
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('alice', 'pw');
    makeAgentOn(db);
    const sent: Array<{ chatId: string; text: string }> = [];
    const deps = makeDeps({ controlDb: cdb, tenantDb: db, deviceId, sent });

    // Link first.
    const { code } = createTelegramCode(cdb, { tenantId: 'default', subdomain: null, userId: uid });
    stubLLM([sayResp('linking')]); // not used during linking, but keep fetch stubbed
    await handleTelegramUpdate({ message: { chat: { id: 5 }, text: '/start' } }, deps);
    await handleTelegramUpdate({ message: { chat: { id: 5 }, text: code } }, deps);

    // Now a command: model calls add_tasks, then narrates.
    stubLLM([
      toolResp('add_tasks', { list: 'shopping list', titles: ['milk'] }),
      sayResp('Added milk to your shopping list.'),
    ]);
    await handleTelegramUpdate(
      { message: { chat: { id: 5 }, text: 'add milk to my shopping list' } },
      deps,
    );
    assert.equal(sent.at(-1)!.text, 'Added milk to your shopping list.');

    // Task really created, owned by the user, and billed as telegram_command.
    const proj = getProjects(db).find((p) => p.title === 'shopping list')!;
    assert.equal(getChildren(db, proj.id).filter((t) => t.type === 'task').length, 1);
    assert.equal(getAgentUsage(db).byKind.telegram_command.calls, 1);
  });

  test('linked chat with no agent configured tells the user to set one up', async () => {
    const cdb = makeControlDb();
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('alice', 'pw');
    // NB: no makeAgentOn(db) — NL is not configured.
    const sent: Array<{ chatId: string; text: string }> = [];
    const deps = makeDeps({ controlDb: cdb, tenantDb: db, deviceId, sent });
    const { code } = createTelegramCode(cdb, { tenantId: 'default', subdomain: null, userId: uid });
    await handleTelegramUpdate({ message: { chat: { id: 5 }, text: '/start' } }, deps);
    await handleTelegramUpdate({ message: { chat: { id: 5 }, text: code } }, deps);

    await handleTelegramUpdate({ message: { chat: { id: 5 }, text: 'add milk' } }, deps);
    assert.match(sent.at(-1)!.text, /AI assistant set up|Settings → AI agents/i);
  });

  test('non-text / unknown updates are ignored', async () => {
    const cdb = makeControlDb();
    const { db, deviceId } = makeTestDb();
    const sent: Array<{ chatId: string; text: string }> = [];
    const deps = makeDeps({ controlDb: cdb, tenantDb: db, deviceId, sent });
    await handleTelegramUpdate({ message: { chat: { id: 1 } } }, deps); // no text
    await handleTelegramUpdate({}, deps); // no message
    assert.equal(sent.length, 0);
  });
});

describe('telegram conversation context', () => {
  /** Capture the messages sent to the LLM so we can assert prior turns are replayed. */
  function captureLLM(responses: unknown[]): () => unknown[][] {
    const bodies: unknown[][] = [];
    let i = 0;
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
      const parsed = init?.body ? (JSON.parse(init.body) as { messages?: unknown[] }) : {};
      bodies.push((parsed.messages as unknown[]) ?? []);
      const body = responses[Math.min(i, responses.length - 1)];
      i++;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    return () => bodies;
  }

  async function linkChat(cdb: ReturnType<typeof openControlDb>, deps: TelegramDeps, chatId: number, userId: string) {
    const { code } = createTelegramCode(cdb, { tenantId: 'default', subdomain: null, userId });
    await handleTelegramUpdate({ message: { chat: { id: chatId }, text: '/start' } }, deps);
    await handleTelegramUpdate({ message: { chat: { id: chatId }, text: code } }, deps);
  }

  test('a follow-up sees the previous turn replayed as context', async () => {
    const cdb = makeControlDb();
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('alice', 'pw');
    makeAgentOn(db);
    const sent: Array<{ chatId: string; text: string }> = [];
    const deps = makeDeps({ controlDb: cdb, tenantDb: db, deviceId, sent });
    await linkChat(cdb, deps, 5, uid);

    // Turn 1: a question. Model reads then answers.
    captureLLM([toolResp('items', { list: 'shopping list' }), sayResp('Your shopping list has bread and milk.')]);
    await handleTelegramUpdate({ message: { chat: { id: 5 }, text: "what's on my shopping list?" } }, deps);

    // Turn 2: a follow-up. Assert the first exchange is present in the prompt.
    const seen = captureLLM([
      toolResp('add_tasks', { list: 'shopping list', titles: ['eggs'] }),
      sayResp('Added eggs to your shopping list.'),
    ]);
    await handleTelegramUpdate({ message: { chat: { id: 5 }, text: 'add eggs to it' } }, deps);

    const firstCallMessages = seen()[0] as Array<{ role: string; content: string }>;
    const joined = firstCallMessages.map((m) => `${m.role}:${m.content}`).join('\n');
    assert.match(joined, /what's on my shopping list\?/);
    assert.match(joined, /bread and milk/);
    // The system prompt gained the focus-on-latest hint once history exists.
    assert.match(joined, /Focus on the user's LATEST message/);
    // And the latest message is the final user turn.
    assert.equal(firstCallMessages.at(-1)!.content, 'add eggs to it');
  });

  test('/reset clears the rolling context', async () => {
    const cdb = makeControlDb();
    const { db, deviceId, addUser } = makeTestDb();
    const { id: uid } = addUser('alice', 'pw');
    makeAgentOn(db);
    const sent: Array<{ chatId: string; text: string }> = [];
    const deps = makeDeps({ controlDb: cdb, tenantDb: db, deviceId, sent });
    await linkChat(cdb, deps, 5, uid);

    captureLLM([sayResp('Your shopping list has bread.')]);
    await handleTelegramUpdate({ message: { chat: { id: 5 }, text: "what's on my shopping list?" } }, deps);

    await handleTelegramUpdate({ message: { chat: { id: 5 }, text: '/reset' } }, deps);
    assert.match(sent.at(-1)!.text, /Cleared/i);

    // After reset, the next command carries no prior turns.
    const seen = captureLLM([sayResp('hi')]);
    await handleTelegramUpdate({ message: { chat: { id: 5 }, text: 'what now?' } }, deps);
    const msgs = seen()[0] as Array<{ role: string; content: string }>;
    // Only system + the one user message — no replayed history.
    assert.equal(msgs.filter((m) => m.role === 'user').length, 1);
    assert.equal(msgs.filter((m) => m.role === 'system' && /Focus on the user's LATEST/.test(m.content)).length, 0);
  });
});

describe('ensureTelegramTables is idempotent', () => {
  test('can be called repeatedly', () => {
    const cdb = makeControlDb();
    ensureTelegramTables(cdb);
    ensureTelegramTables(cdb);
    assert.ok(true);
  });
});
