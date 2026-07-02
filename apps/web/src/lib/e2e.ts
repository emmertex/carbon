/**
 * E2E test hooks — registered only when VITE_CARBON_E2E=1 (Playwright webServer).
 * Exposes readiness for waitForApp and optional in-app reset via devSeed.
 */
import { useStore } from './store';
import { getDb } from './db';

export function registerE2eHooks(): void {
  if (typeof window === 'undefined') return;
  const api = {
    get ready() {
      return useStore.getState().ready;
    },
    async reset(): Promise<void> {
      const { registerDevSeed } = await import('./devSeed');
      registerDevSeed();
      await (window as unknown as { __carbonReset?: () => Promise<void> }).__carbonReset?.();
    },
    async importDbBase64(b64: string): Promise<void> {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const { importDb } = await import('./db');
      await importDb(bin);
    },
    async inspectBackupJson(json: string): Promise<{
      userCount: number;
      titles: string[];
      opTitles: string[];
      itemCount: number;
      opCount: number;
    }> {
      const file = new File([json], 'backup.json', { type: 'application/json' });
      const { inspectBackup } = await import('./backup');
      const parsed = await inspectBackup(file);
      const { openSnapshot } = await import('./db');
      const snap = await openSnapshot(parsed.dbBytes);
      const opTitles = snap
        .all<{ fields: string }>('SELECT fields FROM ops')
        .map((r) => {
          try {
            return JSON.parse(r.fields).title as string | undefined;
          } catch {
            return undefined;
          }
        })
        .filter((t): t is string => Boolean(t));
      return {
        userCount: parsed.users.length,
        titles: snap
          .all<{ title: string }>('SELECT title FROM items WHERE deleted = 0')
          .map((r) => r.title),
        opTitles,
        itemCount: snap.get<{ c: number }>('SELECT COUNT(*) AS c FROM items')?.c ?? 0,
        opCount: snap.get<{ c: number }>('SELECT COUNT(*) AS c FROM ops')?.c ?? 0,
      };
    },
    /** Read-only SQL escape hatch for spec debugging/assertions (dev-gated). */
    inspect(sql: string): unknown[] {
      return getDb().all(sql);
    },
    liveTaskCount(): number {
      return getDb().get<{ c: number }>('SELECT COUNT(*) AS c FROM items WHERE deleted = 0')?.c ?? 0;
    },
    liveDbCounts(): { items: number; ops: number } {
      const db = getDb();
      return {
        items: db.get<{ c: number }>('SELECT COUNT(*) AS c FROM items')?.c ?? 0,
        ops: db.get<{ c: number }>('SELECT COUNT(*) AS c FROM ops')?.c ?? 0,
      };
    },
  };
  (window as unknown as { __carbonE2e: typeof api }).__carbonE2e = api;
}
