import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader2, X } from 'lucide-react';
import { optimiseRecipe } from '@/lib/recipeOptimise';
import type { CupConvention } from '@/lib/recipe';
import { ErrorText, btnPrimary, btnSecondary } from './ui/controls';

function Pane({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <span className="mb-1 text-xs font-medium text-text-muted">{title}</span>
      <div className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface-2 p-2 font-mono text-xs text-text">
        {children}
      </div>
    </div>
  );
}

/**
 * Before/after preview of an agent rewrite.
 *
 * The request runs here rather than in the caller so that nothing outside this
 * dialog ever holds the rewritten text: cancelling (Cancel, Escape, scrim) leaves
 * the stored note byte-identical, and `onReplace` is the single, explicit way out.
 */
export function OptimisePreview({
  body,
  convention,
  onCancel,
  onReplace,
}: {
  /** The stored, unscaled markdown — never a scaled render. */
  body: string;
  convention: CupConvention;
  onCancel: () => void;
  onReplace: (next: string) => void;
}) {
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const loading = result === null && error === null;

  useEffect(() => {
    let alive = true;
    setResult(null);
    setError(null);
    void optimiseRecipe(body, convention).then(
      (text) => {
        if (alive) setResult(text);
      },
      (e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : 'Couldn’t optimise this recipe.');
      },
    );
    return () => {
      alive = false;
    };
  }, [body, convention, attempt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  // Standard dialog behaviour: closing shouldn't strand focus on a removed element.
  // Captured during the first render, while the trigger button still has focus.
  const previouslyFocused = useRef<HTMLElement | null>(
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  );
  useEffect(() => {
    const prev = previouslyFocused.current;
    return () => prev?.focus?.();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="optimise-preview-title"
        className="flex h-[85vh] w-full max-w-4xl flex-col rounded-2xl border border-border bg-bg p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <span id="optimise-preview-title" className="text-sm font-medium text-text-muted">
            Optimise recipe
          </span>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="rounded-lg p-1.5 text-text-muted hover:bg-surface-2 hover:text-text"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 sm:flex-row">
          <Pane title="Current">{body}</Pane>
          <Pane title="Optimised">
            {loading ? (
              <span className="flex items-center gap-2 text-text-faint">
                <Loader2 size={13} className="animate-spin" /> Asking the assistant…
              </span>
            ) : (
              (result ?? <span className="text-text-faint">—</span>)
            )}
          </Pane>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          <ErrorText className="mr-auto text-xs">{error}</ErrorText>
          <button type="button" onClick={onCancel} className={btnSecondary}>
            Cancel
          </button>
          {error && (
            <button
              type="button"
              onClick={() => setAttempt((a) => a + 1)}
              className={btnSecondary}
            >
              Try again
            </button>
          )}
          <button
            type="button"
            disabled={result === null}
            onClick={() => result !== null && onReplace(result)}
            className={btnPrimary}
          >
            {loading && <Loader2 size={15} className="animate-spin" />}
            Replace note
          </button>
        </div>
      </div>
    </div>
  );
}
