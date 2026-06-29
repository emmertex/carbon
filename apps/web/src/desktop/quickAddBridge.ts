import { useEffect } from 'react';
import { isTauri } from '@/lib/platform';
import { mutate } from '@/lib/mutate';
import { createFromQuickAdd } from '@/lib/quickadd';
import { getCurrentUserId, useStore } from '@/lib/store';
import { firstWordIsCommand } from '@/lib/command';
import { runCommand } from '@/lib/admin';
import { scheduleSync } from '@/lib/sync';

/**
 * Main-window half of the desktop quick-add bridge. The spotlight quick-add window
 * does not own a database — it forwards the typed text here via a Tauri event, and
 * the main window (the single DB owner) acts on it through the same paths the in-app
 * quick-add bar uses:
 *   - if NL commands are enabled and the first word is a keyword → run it through the
 *     LLM (`runCommand`), then sync the synced-down items (mirrors QuickAdd.tsx);
 *   - otherwise create a literal task via `createFromQuickAdd` + `mutate`.
 * Either way the result is reported in the main window's toast.
 *
 * No-op on web and Capacitor: the Tauri event API is only imported when running
 * inside the desktop shell, so the web/Android bundles never touch it.
 */
export function useDesktopQuickAddBridge(): void {
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    function handle(text: string): void {
      const { nlEnabled, nlKeywords, showToast } = useStore.getState();
      if (nlEnabled && firstWordIsCommand(text, nlKeywords)) {
        showToast({ message: 'Thinking…' });
        void runCommand(text)
          .then(({ reply }) => {
            showToast({ message: reply });
            scheduleSync(); // pull the new/changed items into the local DB
          })
          .catch((e: unknown) => {
            showToast({ message: e instanceof Error ? e.message : String(e) });
          });
        return;
      }
      const item = mutate(
        (db, dev) => createFromQuickAdd(db, dev, text, { ownerId: getCurrentUserId() }),
        'create',
      );
      showToast({ message: `Added “${item.title}”` });
    }

    void (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const un = await listen<{ text?: string }>('quick:create', (event) => {
        const text = (event.payload?.text ?? '').trim();
        if (text) handle(text);
      });
      if (cancelled) un();
      else unlisten = un;
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
