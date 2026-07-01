import { useState } from 'react';
import { Sparkles, Loader2 } from 'lucide-react';
import { buildFilterFromNl } from '@/lib/filterNl';
import type { FilterExpr } from '@/lib/filter-expr';

/** Natural-language → advanced filter. The result is loaded into the builder for
 *  the user to review and tweak before it applies. */
export function NlFilterBox({ onResult }: { onResult: (e: FilterExpr) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    const q = text.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    try {
      onResult(await buildFilterFromNl(q));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-1.5">
        <Sparkles size={13} className="shrink-0 text-accent" />
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void run();
            }
          }}
          placeholder="Describe a filter… e.g. due within 2 days or flagged, not on hold"
          className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-xs outline-none focus:border-accent"
        />
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy}
          className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-surface-2 disabled:opacity-50"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : 'Build'}
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}
