import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { useStore } from '@/lib/store';
import { useTokenSuggest, SuggestionMenu } from './TokenSuggest';

export function QuickAdd({
  placeholder = 'Add a task…  (#tag @user !priority)',
  onCreate,
}: {
  placeholder?: string;
  onCreate: (raw: string) => void;
}) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const suggest = useTokenSuggest({ value, setValue, inputRef });

  // Focus when a global hotkey (`c` / `/`) requests the quick-add bar.
  const focusNonce = useStore((s) => s.quickAddFocusNonce);
  useEffect(() => {
    if (focusNonce > 0) inputRef.current?.focus();
  }, [focusNonce]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const raw = value.trim();
    if (!raw) return;
    onCreate(raw);
    setValue('');
    suggest.reset();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (suggest.onKeyDown(e)) return;
    // menu closed: Enter submits the form normally
  }

  return (
    <form
      onSubmit={submit}
      className="relative flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 focus-within:border-accent"
    >
      <Plus size={18} className="shrink-0 text-text-faint" />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          suggest.onValueChange(e.currentTarget);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => suggest.syncCaret(e.currentTarget)}
        onClick={(e) => suggest.syncCaret(e.currentTarget)}
        placeholder={placeholder}
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
  );
}
