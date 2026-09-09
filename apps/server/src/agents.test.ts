import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { makeTestDb } from './test-app';
import {
  ensureAgentTables,
  ensureAgentUsageTables,
  createAgent,
  getAgent,
  listAgents,
  updateAgent,
  deleteAgent,
  getAgentForUser,
  getNlSettings,
  setNlSettings,
  recordAgentUsage,
  getAgentUsage,
  isTimeoutError,
  formatNow,
} from './agents';

describe('ensureAgentTables', () => {
  test('creates the agents table', () => {
    const { db } = makeTestDb();
    ensureAgentTables(db);
    const row = db.get('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'agents\'');
    assert.ok(row);
  });
});

describe('ensureAgentUsageTables', () => {
  test('creates the agent_usage table', () => {
    const { db } = makeTestDb();
    ensureAgentUsageTables(db);
    const row = db.get('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'agent_usage\'');
    assert.ok(row);
  });
});

describe('createAgent', () => {
  test('creates an agent and its bot user', () => {
    const { db } = makeTestDb();
    const agent = createAgent(db, { name: 'Test Agent', username: 'test-agent', kind: 'openai', model: 'gpt-4' });
    assert.ok(agent.id);
    assert.equal(agent.name, 'Test Agent');
    assert.equal(agent.kind, 'openai');
    assert.equal(agent.model, 'gpt-4');
    assert.equal(agent.enabled, true);
  });
});

describe('getAgent', () => {
  test('returns agent by id', () => {
    const { db } = makeTestDb();
    const created = createAgent(db, { name: 'Agent', username: 'agent', kind: 'openai' });
    const agent = getAgent(db, created.id);
    assert.equal(agent?.id, created.id);
  });

  test('returns undefined for unknown id', () => {
    const { db } = makeTestDb();
    assert.equal(getAgent(db, 'nonexistent'), undefined);
  });
});

describe('listAgents', () => {
  test('returns all agents without api_key', () => {
    const { db } = makeTestDb();
    createAgent(db, { name: 'A1', username: 'a1', kind: 'openai', apiKey: 'secret1' });
    createAgent(db, { name: 'A2', username: 'a2', kind: 'openai', apiKey: 'secret2' });
    const agents = listAgents(db);
    assert.equal(agents.length, 2);
    // api_key should not be exposed
    assert.equal('api_key' in agents[0], false);
  });
});

describe('updateAgent', () => {
  test('updates agent fields', () => {
    const { db } = makeTestDb();
    const agent = createAgent(db, { name: 'Original', username: 'agent', kind: 'openai' });
    updateAgent(db, agent.id, { model: 'gpt-5', enabled: false });
    const updated = getAgent(db, agent.id);
    assert.equal(updated?.model, 'gpt-5');
    assert.equal(updated?.enabled, false);
  });
});

describe('deleteAgent', () => {
  test('deletes agent and its usage records', () => {
    const { db } = makeTestDb();
    const agent = createAgent(db, { name: 'To delete', username: 'del-agent', kind: 'openai' });
    recordAgentUsage(db, agent.id, { input: 10, output: 5 }, 'gpt-4', 'nl_command');
    deleteAgent(db, agent.id);
    assert.equal(getAgent(db, agent.id), undefined);
    const usage = db.all('SELECT * FROM agent_usage WHERE agent_id = ?', [agent.id]);
    assert.equal(usage.length, 0);
  });
});

describe('getAgentForUser', () => {
  test('returns enabled agent for user', () => {
    const { db } = makeTestDb();
    const agent = createAgent(db, { name: 'Bot', username: 'bot-user', kind: 'openai' });
    const found = getAgentForUser(db, agent.user_id);
    assert.equal(found?.id, agent.id);
  });
});

describe('getNlSettings / setNlSettings', () => {
  test('defaults', () => {
    const { db } = makeTestDb();
    const settings = getNlSettings(db);
    assert.equal(settings.agentId, null);
    assert.ok(Array.isArray(settings.keywords));
    assert.equal(settings.enabled, false);
  });

  test('set agent id', () => {
    const { db } = makeTestDb();
    setNlSettings(db, { agentId: 'agent-123', enabled: true });
    const settings = getNlSettings(db);
    assert.equal(settings.agentId, 'agent-123');
    assert.equal(settings.enabled, true);
  });
});

describe('recordAgentUsage / getAgentUsage', () => {
  test('records and retrieves usage', () => {
    const { db } = makeTestDb();
    const agent = createAgent(db, { name: 'Usage Agent', username: 'usage-agent', kind: 'openai' });
    recordAgentUsage(db, agent.id, { input: 100, output: 50 }, 'gpt-4', 'nl_command');
    recordAgentUsage(db, agent.id, { input: 200, output: 100 }, 'gpt-4', 'comment_reply');
    const usage = getAgentUsage(db);
    assert.equal(usage.total.calls, 2);
    assert.equal(usage.total.input_tokens, 300);
    assert.equal(usage.total.output_tokens, 150);
  });
});

describe('isTimeoutError', () => {
  test('identifies timeout errors', () => {
    const timeoutErr = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    assert.equal(isTimeoutError(timeoutErr), true);
  });

  test('regular errors are not timeouts', () => {
    assert.equal(isTimeoutError(new Error('some error')), false);
  });
});

describe('formatNow', () => {
  test('returns a formatted time string', () => {
    const result = formatNow(new Date());
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });
});
