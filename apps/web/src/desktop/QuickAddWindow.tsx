import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Plus } from 'lucide-react';
import { listTags, listUsers } from '@carbon/core';
import { loadSnapshot } from '@/lib/db';
import '../index.css';

// ---------------------------------------------------------------------------
// Desktop spotlight quick-add window.
//
// This is a *minimal* React app that the Tauri `quick` window loads via
// `index.html?view=quick`. It deliberately does NOT boot the full app — no live
// DB, no sync loop. For autocomplete it opens a read-only snapshot of the
// persisted database; on submit it forwards the raw text to the main window
// (the single DB owner) over a Tauri event and hides itself.
// ---------------------------------------------------------------------------

const PRIORITY_SUGGESTIONS = ['high', 'med', 'low', 'none'];
const MAX_SUGGESTIONS = 6;
const ROW_HEIGHT = 40;
const BASE_HEIGHT = 72;

type Suggestion = { value: string; label: string };

async function hideSelf() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().hide();
}

async function resizeSelf(rows: number) {
  const [{ getCurrentWindow }, { LogicalSize }] = await Promise.all([
    import('@tauri-apps/api/window'),
    import('@tauri-apps/api/dpi'),
  ]);
  const height = BASE_HEIGHT + Math.min(rows, MAX_SUGGESTIONS) * ROW_HEIGHT;
  await getCurrentWindow().setSize(new LogicalSize(600, height));
}

/** The `#tag` / `@user` / `!priority` token immediately left of the caret, if any. */
function activeToken(value: string, caret: number) {
  const upto = value.slice(0, caret);
  const m = upto.match(/(?:^|\s)([#@!])(\S*)$/);
  if (!m) return null;
  const query = m[2] ?? '';
  return { trigger: m[1]!, query, start: caret - query.length - 1 };
}

function QuickAddWindow() {
  const [value, setValue] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [users, setUsers] = useState<string[]>([]);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load tags/users from a read-only snapshot for autocomplete. Re-run whenever
  // the window is shown so suggestions reflect recent edits made in the main app.
  const refreshSnapshot = useCallback(async () => {
    const snap = await loadSnapshot();
    if (!snap) return;
    setTags(listTags(snap).map((t) => t.name));
    setUsers(listUsers(snap).map((u) => u.username));
  }, []);

  useEffect(() => {
    void refreshSnapshot();
    inputRef.current?.focus();

    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const un = await listen('quick:show', () => {
        void refreshSnapshot();
        inputRef.current?.focus();
        inputRef.current?.select();
      });
      if (cancelled) un();
      else unlisten = un;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [refreshSnapshot]);

  const token = activeToken(value, caret);
  const suggestions = useMemo<Suggestion[]>(() => {
    if (!token) return [];
    const q = token.query.toLowerCase();
    const pick = (pool: string[], prefix: string) =>
      pool
        .filter((n) => n.toLowerCase().startsWith(q))
        .slice(0, MAX_SUGGESTIONS)
        .map((n) => ({ value: prefix + n, label: prefix + n }));
    if (token.trigger === '#') return pick(tags, '#');
    if (token.trigger === '@') return pick(users, '@');
    return pick(PRIORITY_SUGGESTIONS, '!');
  }, [token, tags, users]);

  // Keep the active row in range and the window sized to the visible suggestions.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, suggestions.length - 1)));
    void resizeSelf(suggestions.length);
  }, [suggestions.length]);

  function accept(s: Suggestion) {
    if (!token) return;
    const next = value.slice(0, token.start) + s.value + ' ' + value.slice(caret);
    const pos = token.start + s.value.length + 1;
    setValue(next);
    setCaret(pos);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(pos, pos);
    });
  }

  async function submit() {
    const text = value.trim();
    if (text) {
      const { emit } = await import('@tauri-apps/api/event');
      await emit('quick:create', { text });
    }
    setValue('');
    setCaret(0);
    await hideSelf();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      setValue('');
      void hideSelf();
      return;
    }
    if (suggestions.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => (a + 1) % suggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => (a - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        accept(suggestions[active]!);
        return;
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      void submit();
    }
  }

  function syncCaret(el: HTMLInputElement) {
    setCaret(el.selectionStart ?? el.value.length);
  }

  return (
    <div className="flex h-screen w-screen flex-col bg-bg text-text">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex items-center gap-2 border-b border-border px-4 py-3"
      >
        <Plus size={18} className="shrink-0 text-text-faint" />
        <input
          ref={inputRef}
          autoFocus
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            syncCaret(e.currentTarget);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => syncCaret(e.currentTarget)}
          onClick={(e) => syncCaret(e.currentTarget)}
          placeholder="Quick add a task…  (#tag @user !priority)"
          className="min-w-0 flex-1 bg-transparent text-base text-text outline-none placeholder:text-text-faint"
        />
      </form>

      {suggestions.length > 0 && (
        <ul className="flex-1 overflow-y-auto py-1">
          {suggestions.map((s, i) => (
            <li key={s.value}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(s);
                }}
                onMouseEnter={() => setActive(i)}
                className={`flex w-full items-center px-4 text-sm ${
                  i === active ? 'bg-surface-2 text-text' : 'text-text-muted'
                }`}
                style={{ height: ROW_HEIGHT }}
              >
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Mount the spotlight quick-add UI in place of the full app. Called from main.tsx
 *  when the window URL carries `?view=quick`. */
export function mountQuickAddWindow(): void {
  const root = document.getElementById('root');
  if (!root) return;
  createRoot(root).render(
    <StrictMode>
      <QuickAddWindow />
    </StrictMode>,
  );
}
