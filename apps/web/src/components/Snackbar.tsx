import { useEffect } from 'react';
import { useStore } from '@/lib/store';

const AUTO_DISMISS_MS = 5000;

/** Bottom-centre transient toast with an optional action (e.g. Undo a delete).
 *  Auto-dismisses; re-arms whenever a new toast (new id) appears. */
export function Snackbar() {
  const toast = useStore((s) => s.toast);
  const dismiss = useStore((s) => s.dismissToast);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(dismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [toast?.id, dismiss]);

  if (!toast) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[100] flex justify-center px-4">
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-auto flex items-center gap-4 rounded-xl bg-text px-4 py-2.5 text-sm text-bg shadow-2xl"
      >
        <span>{toast.message}</span>
        {toast.actionLabel && (
          <button
            onClick={() => {
              toast.onAction?.();
              dismiss();
            }}
            className="font-semibold text-accent hover:underline"
          >
            {toast.actionLabel}
          </button>
        )}
      </div>
    </div>
  );
}
