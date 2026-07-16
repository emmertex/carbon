import { useEffect, useRef, useState } from 'react';
import { Plus, Sparkles, Loader2 } from 'lucide-react';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/cn';
import { firstWordIsCommand } from '@/lib/command';
import { runCommand } from '@/lib/admin';
import { scheduleSync } from '@/lib/sync';
import { useTokenSuggest, SuggestionMenu } from './TokenSuggest';
import { useFeature } from '@/hooks/useFeature';

type Status = { kind: 'pending' | 'reply' | 'error'; text: string } | null;

export function QuickAdd({
  placeholder = 'Add a task…  (#tag @user !priority)',
  onCreate,
  allowNote = false,
  currentProjectId,
}: {
  placeholder?: string;
  onCreate: (raw: string, type: 'task' | 'note') => void;
  /** Show a Task/Note toggle so the box can create a note instead (default off). */
  allowNote?: boolean;
  /** Project page context for NL commands; omitted for global/tag/desktop surfaces. */
  currentProjectId?: string | null;
}) {
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<Status>(null);
  // Creation kind — defaults to task; only surfaced when `allowNote`.
  const [kind, setKind] = useState<'task' | 'note'>('task');
  const inputRef = useRef<HTMLInputElement>(null);
  const suggest = useTokenSuggest({ value, setValue, inputRef });

  // NL command mode: when enabled and the first word matches a keyword, the entry is
  // handled by the LLM instead of creating a plain task. The box turns yellow to show it.
  const nlEnabled = useStore((s) => s.nlEnabled);
  const nlKeywords = useStore((s) => s.nlKeywords);
  const nlFeature = useFeature('nlCommands');
  const commandMode = nlEnabled && nlFeature && firstWordIsCommand(value, nlKeywords);

  // Focus when a global hotkey (`c` / `/`) requests the quick-add bar.
  const focusNonce = useStore((s) => s.quickAddFocusNonce);
  useEffect(() => {
    if (focusNonce > 0) inputRef.current?.focus();
  }, [focusNonce]);

  async function runAsCommand(raw: string) {
    setStatus({ kind: 'pending', text: 'Thinking…' });
    try {
      const { reply } = await runCommand(raw, currentProjectId);
      setStatus({ kind: 'reply', text: reply });
      scheduleSync(); // pull the new/changed items into the local DB
    } catch (e) {
      setStatus({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const raw = value.trim();
    if (!raw || status?.kind === 'pending') return;
    if (commandMode) {
      void runAsCommand(raw);
    } else {
      setStatus(null);
      onCreate(raw, allowNote ? kind : 'task');
    }
    setValue('');
    suggest.reset();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (suggest.onKeyDown(e)) return;
    // menu closed: Enter submits the form normally
  }

  const pending = status?.kind === 'pending';

  return (
    <div className="relative">
      {allowNote && (
        <div className="mb-1.5 inline-flex overflow-hidden rounded-lg border border-border text-xs">
          {(['task', 'note'] as const).map((k, i) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              aria-pressed={kind === k}
              className={cn(
                'px-2.5 py-0.5 font-medium capitalize transition-colors',
                i > 0 && 'border-l border-border',
                kind === k
                  ? 'bg-accent text-accent-fg'
                  : 'text-text-muted hover:bg-surface-2 hover:text-text',
              )}
            >
              {k}
            </button>
          ))}
        </div>
      )}
      <form
        onSubmit={submit}
        className={cn(
          'relative flex items-center gap-2 rounded-xl border bg-surface px-3 py-2',
          commandMode
            ? 'border-warning/70 focus-within:border-warning'
            : 'border-border focus-within:border-accent',
        )}
      >
        {pending ? (
          <Loader2 size={18} className="shrink-0 animate-spin text-warning" />
        ) : commandMode ? (
          <Sparkles size={18} className="shrink-0 text-warning" />
        ) : (
          <Plus size={18} className="shrink-0 text-text-faint" />
        )}
        <input
          ref={inputRef}
          data-testid="quick-add"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            suggest.onValueChange(e.currentTarget);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => suggest.syncCaret(e.currentTarget)}
          onClick={(e) => suggest.syncCaret(e.currentTarget)}
          placeholder={
            commandMode
              ? 'Ask the assistant…'
              : allowNote && kind === 'note'
                ? 'Add a note…'
                : placeholder
          }
          className="min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-text-faint"
        />

        <SuggestionMenu
          open={suggest.open}
          suggestions={suggest.suggestions}
          active={suggest.active}
          trigger={suggest.token?.trigger}
          onChoose={suggest.choose}
        />
      </form>

      {status && status.kind !== 'pending' && (
        <p
          className={cn(
            'mt-1 whitespace-pre-line px-1 text-xs',
            status.kind === 'error' ? 'text-danger' : 'text-text-muted',
          )}
        >
          {status.text}
          <button
            type="button"
            onClick={() => setStatus(null)}
            className="ml-2 text-text-faint underline hover:text-text"
          >
            dismiss
          </button>
        </p>
      )}
    </div>
  );
}
