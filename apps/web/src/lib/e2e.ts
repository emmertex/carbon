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
    async seedReorderTasks(count: number): Promise<string[]> {
      const { createItem } = await import('@carbon/core');
      const { getDeviceId, persist } = await import('./db');
      const ids: string[] = [];
      for (let i = 0; i < Math.min(count, 500); i++)
        ids.push(createItem(getDb(), getDeviceId(), { title: `Reorder ${i}`, ownerId: useStore.getState().currentUser?.id ?? null }).id);
      useStore.getState().bump();
      await persist();
      return ids;
    },
    async seedReviewProject(withTasks: boolean): Promise<string> {
      const { createItem, updateItem } = await import('@carbon/core');
      const { getDeviceId, persist } = await import('./db');
      const db = getDb();
      const dev = getDeviceId();
      const project = createItem(db, dev, { type: 'project', title: 'Review fixture', ownerId: useStore.getState().currentUser?.id ?? null });
      updateItem(db, dev, project.id, { reviewed_at: '2020-01-01T00:00:00.000Z', review_interval: 1 });
      if (withTasks) {
        const root = createItem(db, dev, { title: 'Root review task', parentId: project.id, note: 'Review context notes', dueDate: '2030-01-01T12:00:00.000Z' });
        const child = createItem(db, dev, { title: 'Nested review task', parentId: root.id });
        createItem(db, dev, { title: 'Grandchild review task', parentId: child.id });
      }
      useStore.getState().bump();
      await persist();
      return project.id;
    },
    firstTapDetails(value: boolean): void { useStore.getState().setUiPrefs({ firstTapDetails: value }); },
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
