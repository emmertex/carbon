import { useEffect, useMemo, useRef, useState } from 'react';
import { Flag } from 'lucide-react';
import { listTags, listUsers } from '@carbon/core';
import { useQuery } from '@/hooks/useQuery';
import { cn } from '@/lib/cn';
import { TagMark } from './TagMark';

export interface Suggestion {
  /** Token text to insert (e.g. "#groceries", "@bob", "!high"). */
  insert: string;
  label: string;
  hint?: string;
  color?: string;
}

const PRIORITY_OPTIONS = [
  { word: 'high', value: 3 },
  { word: 'medium', value: 2 },
  { word: 'low', value: 1 },
  { word: 'none', value: 0 },
];

/**
 * Inline `#tag`/`@user`/`!priority` autocomplete for any single-line text input.
 * Owns caret/active/suppressed state; the consumer owns the text `value`. Shared
 * by the quick-add box and the outliner's inline edit so both behave identically.
 */
export function useTokenSuggest({
  value,
  setValue,
  inputRef,
}: {
  value: string;
  setValue: (v: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [suppressed, setSuppressed] = useState(false);
  const pendingCaret = useRef<number | null>(null);

  const data = useQuery((db) => ({ tags: listTags(db), users: listUsers(db) }));
  const tags = data?.tags ?? [];
  const users = data?.users ?? [];

  // The token being typed at the caret: a #/@/! word.
  const token = useMemo(() => {
    const before = value.slice(0, caret);
    const m = before.match(/(^|\s)([#@!])(\S*)$/);
    if (!m) return null;
    const trigger = m[2]!;
    const query = m[3]!;
    return { trigger, query, start: caret - (1 + query.length) };
  }, [value, caret]);

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!token) return [];
    const q = token.query.toLowerCase();
    if (token.trigger === '#') {
      const matches = tags.filter((t) => t.name.toLowerCase().includes(q));
      const list: Suggestion[] = matches.map((t) => ({
        insert: `#${t.name}`,
        label: t.name,
        color: t.color ?? undefined,
      }));
      if (q && !tags.some((t) => t.name.toLowerCase() === q)) {
        list.unshift({ insert: `#${token.query}`, label: token.query, hint: 'create tag' });
      }
      return list.slice(0, 8);
    }
    if (token.trigger === '@') {
      return users
        .filter((u) => u.username.toLowerCase().includes(q))
        .slice(0, 8)
        .map((u) => ({
          insert: `@${u.username}`,
          label: u.display_name || u.username,
          hint: u.is_bot ? 'bot · assign + share' : 'assign + share',
          color: u.avatar_color ?? undefined,
        }));
    }
    // '!'
    return PRIORITY_OPTIONS.filter(
      (o) => !q || o.word.startsWith(q) || String(o.value) === q,
    ).map((o) => ({ insert: `!${o.word}`, label: `${o.word} priority`, hint: `!${o.value}` }));
  }, [token, tags, users]);

  const open = !!token && suggestions.length > 0 && !suppressed;

  useEffect(() => setActive(0), [value, caret]);

  // Restore caret position after a programmatic insert.
  useEffect(() => {
    if (pendingCaret.current != null && inputRef.current) {
      inputRef.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  });

  function choose(s: Suggestion) {
    if (!token) return;
    const next = value.slice(0, token.start) + s.insert + ' ' + value.slice(caret);
    const newCaret = token.start + s.insert.length + 1;
    setValue(next);
    setCaret(newCaret);
    pendingCaret.current = newCaret;
    setSuppressed(false);
    inputRef.current?.focus();
  }

  /** Handle menu navigation keys. Returns true if the key was consumed, so the
   *  host input can skip its own handling (form submit, outliner nav, …). */
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): boolean {
    if (!open) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i - 1 + suggestions.length) % suggestions.length);
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      choose(suggestions[active]!);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setSuppressed(true);
      return true;
    }
    return false;
  }

  function syncCaret(el: HTMLInputElement) {
    setCaret(el.selectionStart ?? el.value.length);
  }

  /** Call from the input's onChange (after setValue) to track caret + reopen. */
  function onValueChange(el: HTMLInputElement) {
    setCaret(el.selectionStart ?? el.value.length);
    setSuppressed(false);
  }

  /** Reset caret after the host clears its value (e.g. quick-add submit). */
  function reset() {
    setCaret(0);
  }

  return { token, suggestions, active, open, choose, onKeyDown, syncCaret, onValueChange, reset };
}

/** The dropdown list rendered below a token-suggest input. Render inside a
 *  `relative` positioned wrapper. */
export function SuggestionMenu({
  open,
  suggestions,
  active,
  trigger,
  onChoose,
}: {
  open: boolean;
  suggestions: Suggestion[];
  active: number;
  trigger: string | undefined;
  onChoose: (s: Suggestion) => void;
}) {
  if (!open) return null;
  return (
    <ul className="absolute left-0 top-full z-50 mt-1 w-72 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-lg">
      {suggestions.map((s, i) => (
        <li key={s.insert + i}>
          <button
            type="button"
            // onMouseDown (not click) so it fires before the input blurs
            onMouseDown={(e) => {
              e.preventDefault();
              onChoose(s);
            }}
            className={cn(
              'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm',
              i === active ? 'bg-accent-soft text-accent' : 'hover:bg-surface-2',
            )}
          >
            {trigger === '!' ? (
              <Flag size={13} className="shrink-0" />
            ) : trigger === '#' ? (
              <TagMark color={s.color} className="w-3.5 text-center text-sm" />
            ) : (
              <span
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white"
                style={{ background: s.color || 'var(--text-faint)' }}
              >
                {s.label.charAt(0).toUpperCase()}
              </span>
            )}
            <span className="flex-1 truncate">{s.label}</span>
            {s.hint && <span className="text-xs text-text-faint">{s.hint}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}
