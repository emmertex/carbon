import { useEffect, useState } from 'react';
import { Sparkles, X, RotateCcw } from 'lucide-react';
import {
  adminListAgents,
  adminGetNlSettings,
  adminSetNlSettings,
  adminGetNlUsage,
  type Agent,
  type UsageTotals,
} from '@/lib/admin';
import { loadNlConfig } from '@/lib/sync';
import { cn } from '@/lib/cn';
import { SettingsSection } from './settings/SettingsSection';
import { ErrorText, SettingsToggle, btnPrimary, inputCls } from './settings/controls';
import { useSavedFlash } from './settings/useSavedFlash';

const DEFAULT_KEYWORDS = ['can', 'add', 'remind', 'check off', 'mark off', 'mark as'];

export function NlCommands() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [agentId, setAgentId] = useState<string>('');
  const [keywords, setKeywords] = useState<string[]>(DEFAULT_KEYWORDS);
  const [newKw, setNewKw] = useState('');
  const [usage, setUsage] = useState<UsageTotals | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, flashSaved] = useSavedFlash();

  // Only direct-LLM agents can run commands (a webhook can't be called in a loop).
  const llmAgents = agents.filter((a) => a.kind !== 'webhook');

  async function reload() {
    try {
      const [ags, settings, u] = await Promise.all([
        adminListAgents(),
        adminGetNlSettings(),
        adminGetNlUsage().catch(() => null),
      ]);
      setAgents(ags);
      setEnabled(settings.enabled);
      setAgentId(settings.agent_id ?? '');
      setKeywords(settings.keywords.length ? settings.keywords : DEFAULT_KEYWORDS);
      setUsage(u?.byKind?.nl_command ?? { calls: 0, input_tokens: 0, output_tokens: 0 });
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    void reload();
  }, []);

  function addKeyword() {
    const k = newKw.trim().toLowerCase();
    if (k && !keywords.includes(k)) setKeywords([...keywords, k]);
    setNewKw('');
  }

  async function save() {
    setError(null);
    try {
      await adminSetNlSettings({ enabled, agent_id: agentId || null, keywords });
      await loadNlConfig(); // refresh this client's Add box immediately
      flashSaved();
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <SettingsSection
      id="nl-commands"
      title="Natural-language commands"
      description={
        <>
          Let the <strong>Add task</strong> box understand plain language. When an entry starts with a
          keyword below, it's handled by an AI agent (add tasks, check things off, ask what's on a list)
          instead of creating a literal task — and the box turns yellow to show it. Pick one of your{' '}
          <strong>AI agents</strong> (above) to run it.
        </>
      }
    >
      <div className="space-y-4">
        <SettingsToggle
          label="Enable natural-language commands"
          checked={enabled}
          onChange={setEnabled}
        />

        <label className="block">
          <span className="mb-1 block text-xs text-text-muted">Agent that runs commands</span>
          <select
            className={cn(inputCls, 'w-full')}
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
          >
            <option value="">— select an agent —</option>
            {llmAgents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.model ? ` · ${a.model}` : ''}
              </option>
            ))}
          </select>
          {enabled && !agentId && (
            <span className="mt-1 block text-xs text-danger">
              Select an agent — commands stay off until one is chosen.
            </span>
          )}
          {llmAgents.length === 0 && (
            <span className="mt-1 block text-xs text-text-faint">
              No direct-LLM agents yet — add an OpenAI/Anthropic agent above first.
            </span>
          )}
        </label>

        <div>
          <span className="mb-1 flex items-center gap-2 text-xs text-text-muted">
            Trigger keywords (first word, case-insensitive)
            <button
              type="button"
              onClick={() => setKeywords(DEFAULT_KEYWORDS)}
              className="flex items-center gap-1 text-text-faint hover:text-text"
              title="Reset to defaults"
            >
              <RotateCcw size={12} /> reset
            </button>
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            {keywords.map((k) => (
              <span
                key={k}
                className="flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs"
              >
                {k}
                <button
                  type="button"
                  onClick={() => setKeywords(keywords.filter((x) => x !== k))}
                  className="text-text-faint hover:text-danger"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
            <input
              className={cn(inputCls, 'w-28 py-0.5')}
              placeholder="add keyword…"
              value={newKw}
              onChange={(e) => setNewKw(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addKeyword();
                }
              }}
            />
          </div>
        </div>

        {usage && (
          <div className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-text-muted">
            <div className="mb-1 flex items-center gap-1.5 font-medium text-text">
              <Sparkles size={13} className="text-warning" /> Token usage (commands)
            </div>
            {usage.calls} command{usage.calls === 1 ? '' : 's'} · {usage.input_tokens.toLocaleString()} in ·{' '}
            {usage.output_tokens.toLocaleString()} out
          </div>
        )}

        <div className="flex items-center gap-3">
          <button onClick={save} className={btnPrimary}>
            Save
          </button>
          {saved && <span className="text-xs text-success">Saved</span>}
        </div>

        <ErrorText>{error}</ErrorText>
      </div>
    </SettingsSection>
  );
}
