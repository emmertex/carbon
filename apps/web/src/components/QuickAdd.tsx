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
}: {
  placeholder?: string;
  onCreate: (raw: string) => void;
}) {
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<Status>(null);
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
      const { reply } = await runCommand(raw);
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
      onCreate(raw);
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
      <form
        onSubmit={submit}
        className={cn(
          'relative flex items-center gap-2 rounded-xl border bg-surface px-3 py-2',
          commandMode
            ? 'border-yellow-400 focus-within:border-yellow-500'
            : 'border-border focus-within:border-accent',
        )}
      >
        {pending ? (
          <Loader2 size={18} className="shrink-0 animate-spin text-yellow-500" />
        ) : commandMode ? (
          <Sparkles size={18} className="shrink-0 text-yellow-500" />
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
          placeholder={commandMode ? 'Ask the assistant…' : placeholder}
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
