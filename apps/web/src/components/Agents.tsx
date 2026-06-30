import { useEffect, useState } from 'react';
import { Bot, Trash2, Pencil, FlaskConical, Copy, Check } from 'lucide-react';
import {
  adminListAgents,
  adminCreateAgent,
  adminUpdateAgent,
  adminDeleteAgent,
  adminTestAgent,
  type Agent,
  type AgentKind,
} from '@/lib/admin';
import { cn } from '@/lib/cn';
import { SettingsSection } from './settings/SettingsSection';
import {
  ErrorText,
  Card,
  btnPrimary,
  btnSecondary,
  btnIcon,
  inputCls as baseInputCls,
} from './settings/controls';
import { useSavedFlash } from './settings/useSavedFlash';

// These admin forms are full-width; derive from the shared base so the styling
// stays in one place.
const inputCls = cn(baseInputCls, 'w-full');

interface FormState {
  name: string;
  username: string;
  kind: AgentKind;
  endpoint: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
}

const KIND_LABEL: Record<AgentKind, string> = {
  openai: 'OpenAI-compatible (OpenAI / OpenRouter / LM Studio)',
  anthropic: 'Anthropic',
  webhook: 'Agentic webhook (Hermes / OpenClaw)',
};

/** Provider-specific fields, shared by the create and edit forms. */
function AgentFields({
  form,
  set,
  editing,
}: {
  form: FormState;
  set: (patch: Partial<FormState>) => void;
  editing: boolean;
}) {
  const webhook = form.kind === 'webhook';
  return (
    <>
      <label className="block">
        <span className="mb-1 block text-xs text-text-muted">Provider</span>
        <select
          className={inputCls}
          value={form.kind}
          onChange={(e) => set({ kind: e.target.value as AgentKind })}
        >
          <option value="openai">{KIND_LABEL.openai}</option>
          <option value="anthropic">{KIND_LABEL.anthropic}</option>
          <option value="webhook">{KIND_LABEL.webhook}</option>
        </select>
      </label>

      {webhook ? (
        <>
          <label className="block">
            <span className="mb-1 block text-xs text-text-muted">Webhook URL (Carbon calls this on trigger)</span>
            <input
              className={inputCls}
              placeholder="http://hermes.lan:8080/carbon-hook"
              value={form.endpoint}
              onChange={(e) => set({ endpoint: e.target.value })}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-text-muted">
              Shared secret (sent as <code>x-carbon-secret</code>, optional)
            </span>
            <input
              type="password"
              className={inputCls}
              placeholder={editing ? 'leave blank to keep' : ''}
              value={form.apiKey}
              onChange={(e) => set({ apiKey: e.target.value })}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-text-muted">Instructions (sent in payload, optional)</span>
            <textarea
              className={cn(inputCls, 'resize-y')}
              rows={2}
              value={form.systemPrompt}
              onChange={(e) => set({ systemPrompt: e.target.value })}
            />
          </label>
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block text-xs text-text-muted">Model</span>
              <input
                className={inputCls}
                placeholder={form.kind === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-4o-mini'}
                value={form.model}
                onChange={(e) => set({ model: e.target.value })}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-text-muted">API key</span>
              <input
                type="password"
                className={inputCls}
                placeholder={editing ? 'leave blank to keep' : ''}
                value={form.apiKey}
                onChange={(e) => set({ apiKey: e.target.value })}
              />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs text-text-muted">
              Endpoint (base URL exposing /chat/completions — usually ends in /v1)
            </span>
            <input
              className={inputCls}
              placeholder={form.kind === 'anthropic' ? 'https://api.anthropic.com' : 'http://10.2.x.x:1234/v1'}
              value={form.endpoint}
              onChange={(e) => set({ endpoint: e.target.value })}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-text-muted">System prompt</span>
            <textarea
              className={cn(inputCls, 'resize-y')}
              rows={3}
              placeholder="Leave blank to use the built-in default (frames the full task + thread and asks for a one-paragraph reply)."
              value={form.systemPrompt}
              onChange={(e) => set({ systemPrompt: e.target.value })}
            />
          </label>
        </>
      )}
    </>
  );
}

function TokenReveal({ token }: { token: string }) {
  const [copied, flashCopied] = useSavedFlash();
  return (
    <div className="mt-2 rounded-lg border border-accent bg-accent-soft p-3 text-sm">
      <p className="mb-1 font-medium text-accent">
        Agent API token — give this to the framework (with Carbon's URL). Shown once:
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded bg-surface px-2 py-1 text-xs">{token}</code>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(token);
            flashCopied();
          }}
          className="flex items-center gap-1 rounded-lg bg-accent px-2 py-1 text-xs font-medium text-accent-fg"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

const blankForm: FormState = {
  name: '',
  username: '',
  kind: 'openai',
  endpoint: '',
  apiKey: '',
  model: '',
  systemPrompt: '',
};

export function Agents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState<FormState>(blankForm);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<FormState>(blankForm);
  const [tests, setTests] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [testing, setTesting] = useState<string | null>(null);

  async function reload() {
    try {
      setAgents(await adminListAgents());
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    void reload();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreatedToken(null);
    try {
      const { token } = await adminCreateAgent({
        name: createForm.name,
        username: createForm.username,
        kind: createForm.kind,
        endpoint: createForm.endpoint || undefined,
        apiKey: createForm.apiKey || undefined,
        model: createForm.model || undefined,
        systemPrompt: createForm.systemPrompt || undefined,
      });
      if (token) setCreatedToken(token);
      setCreating(false);
      setCreateForm(blankForm);
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }

  function startEdit(a: Agent) {
    setEditId(a.id);
    setEditForm({
      name: a.name,
      username: '',
      kind: a.kind,
      endpoint: a.endpoint ?? '',
      apiKey: '',
      model: a.model ?? '',
      systemPrompt: a.system_prompt ?? '',
    });
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editId) return;
    try {
      await adminUpdateAgent(editId, {
        kind: editForm.kind,
        endpoint: editForm.endpoint,
        model: editForm.model,
        systemPrompt: editForm.systemPrompt,
        ...(editForm.apiKey ? { apiKey: editForm.apiKey } : {}),
      });
      setEditId(null);
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }

  async function test(id: string) {
    setTesting(id);
    setTests((t) => ({ ...t, [id]: { ok: false, message: 'testing…' } }));
    try {
      const r = await adminTestAgent(id);
      setTests((t) => ({ ...t, [id]: r }));
    } catch (e) {
      setTests((t) => ({ ...t, [id]: { ok: false, message: String(e) } }));
    } finally {
      setTesting(null); // never leave the test button stuck spinning (W8)
    }
  }

  return (
    <SettingsSection
      id="agents"
      title="AI agents"
      description={
        <>
          Bot users you can <strong>assign</strong> or <strong>@mention</strong>. Two styles: a{' '}
          <strong>direct LLM</strong> (Carbon calls the model and posts the reply), or an{' '}
          <strong>agentic webhook</strong> (Carbon notifies your framework — Hermes/OpenClaw — which
          acts back via the API with the token issued at creation).
        </>
      }
    >
      <Card className="mb-3 divide-y divide-border">
        {agents.length === 0 && <p className="px-3 py-2 text-sm text-text-faint">No agents yet.</p>}
        {agents.map((a) => (
          <div key={a.id} className="px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Bot size={15} className="text-accent" />
              <span className="font-medium">{a.name}</span>
              <span className="text-xs text-text-faint">
                {a.kind === 'webhook' ? 'webhook' : a.kind}
                {a.model ? ` · ${a.model}` : ''}
              </span>
              <div className="flex-1" />
              <label className="flex items-center gap-1 text-xs text-text-muted">
                <input
                  type="checkbox"
                  checked={a.enabled}
                  onChange={async (e) => {
                    setError(null);
                    try {
                      await adminUpdateAgent(a.id, { enabled: e.target.checked });
                    } catch (err) {
                      setError(String(err));
                    }
                    await reload();
                  }}
                />
                enabled
              </label>
              <button
                onClick={() => test(a.id)}
                disabled={testing === a.id}
                className={cn(btnIcon, 'hover:text-accent')}
                title="Test connection"
              >
                <FlaskConical size={15} />
              </button>
              <button
                onClick={() => (editId === a.id ? setEditId(null) : startEdit(a))}
                className={btnIcon}
                title="Edit"
              >
                <Pencil size={15} />
              </button>
              <button
                onClick={async () => {
                  if (window.confirm(`Delete agent "${a.name}"?`)) {
                    setError(null);
                    try {
                      await adminDeleteAgent(a.id);
                    } catch (err) {
                      setError(String(err));
                    }
                    await reload();
                  }
                }}
                className={cn(btnIcon, 'hover:text-danger')}
                title="Delete"
              >
                <Trash2 size={15} />
              </button>
            </div>
            {tests[a.id] && (
              <p className={cn('mt-1 text-xs', tests[a.id].ok ? 'text-success' : 'text-danger')}>
                {tests[a.id].message}
              </p>
            )}
            {editId === a.id && (
              <form onSubmit={saveEdit} className="mt-2 space-y-2 border-t border-border pt-2">
                <AgentFields form={editForm} set={(p) => setEditForm({ ...editForm, ...p })} editing />
                <div className="flex gap-2">
                  <button className={btnPrimary}>Save</button>
                  <button type="button" onClick={() => setEditId(null)} className={btnSecondary}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        ))}
      </Card>

      {createdToken && <TokenReveal token={createdToken} />}

      {creating ? (
        <form onSubmit={create} className="mt-3 space-y-2 rounded-xl border border-border bg-surface p-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block text-xs text-text-muted">Display name</span>
              <input
                className={inputCls}
                value={createForm.name}
                onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-text-muted">Username (for @mention)</span>
              <input
                className={inputCls}
                value={createForm.username}
                onChange={(e) => setCreateForm({ ...createForm, username: e.target.value })}
              />
            </label>
          </div>
          <AgentFields form={createForm} set={(p) => setCreateForm({ ...createForm, ...p })} editing={false} />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={!createForm.name || !createForm.username}
              className={btnPrimary}
            >
              Create agent
            </button>
            <button type="button" onClick={() => setCreating(false)} className={btnSecondary}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          onClick={() => {
            setCreating(true);
            setCreatedToken(null);
          }}
          className={cn(btnPrimary, 'mt-3')}
        >
          <Bot size={15} /> Add agent
        </button>
      )}

      <ErrorText className="mt-2">{error}</ErrorText>
    </SettingsSection>
  );
}
