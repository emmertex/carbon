import { create } from 'zustand';
import { bumpRevision, currentRevision } from './dbRevision';
import {
  getThemeMode,
  getLightTheme,
  getDarkTheme,
  getAccent,
  getCurrentUser,
  applyTheme,
  getUiPrefs,
  saveUiPrefs,
  type Theme,
  type ThemeMode,
  type Accent,
  type CurrentUser,
  type UiPrefs,
} from './config';
import { notifySettingsChanged } from './settings-events';

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline' | 'disabled';

export interface Toast {
  id: number;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

interface AppState {
  ready: boolean;
  /** Bumped after every mutation/sync so `useQuery` re-runs. */
  dbRevision: number;
  selectedId: string | null;
  /** What the selected id refers to — a task/project item, or a tag. Drives which
   *  detail pane (TaskDetail vs TagDetail) the right column renders. */
  selectedKind: 'item' | 'tag';
  /** Whether the detail pane is *open*. On desktop the docked pane shows whenever
   *  a task is selected; on mobile this gates the overlay (2nd tap opens it). */
  detailOpen: boolean;
  sidebarOpen: boolean;
  /** Collapsed tree nodes (children hidden); persisted across sessions. */
  collapsed: Set<string>;
  /** Expanded subtask rows in flat list views (Today/Flagged/etc). Unlike `collapsed`
   *  these default to *collapsed* — membership means "show this task's subtasks".
   *  Persisted across sessions. */
  expanded: Set<string>;
  themeMode: ThemeMode;
  lightTheme: Theme;
  darkTheme: Theme;
  accent: Accent;
  syncStatus: SyncStatus;
  /** Last sync failure message (for the SyncIndicator tooltip); null when healthy. */
  syncError: string | null;
  lastSyncedAt: number | null;
  currentUser: CurrentUser | null;
  /** The configured server requires a login and we don't have a valid session
   *  (a /api/me returned 401). Drives the sign-in gate. False for local-only
   *  (no server) and open-mode servers. */
  authRequired: boolean;
  /** The user explicitly opened the sign-in flow (the "Login" button in Settings),
   *  independent of `authRequired`. Lets sign-in be reached on demand — e.g. to
   *  attach a native/local-only app to a server — not only after a 401. */
  loginOpen: boolean;
  /** What this origin is, per /api/health: 'single' (self-host, no base domain),
   *  'apex' (the landing/marketing host), 'app' (the dedicated offline/local-only
   *  host), 'tenant' (a real workspace), 'unknown' (a subdomain with no matching
   *  workspace), or null before health resolves. */
  hostRole: 'single' | 'apex' | 'app' | 'tenant' | 'unknown' | null;
  /** Apex domain reported by the server (for "go to my workspace" links). */
  baseDomain: string | null;
  /** Label of the dedicated offline/local-only host (e.g. "app"). */
  appHost: string | null;
  /** Server's package version, from /api/health. Null until health resolves. */
  serverVersion: string | null;
  /** Local-only "use without signing in" choice on the apex landing. */
  localOnly: boolean;
  /** Workspace subscription has lapsed (expired or operator-locked): the app shows a
   *  read-only renew gate. From /api/health `locked`. */
  workspaceLocked: boolean;
  /** ISO timestamp the workspace locks / locked at (for the gate copy). */
  workspaceExpiresAt: string | null;
  /** Gesture / mobile-layout preferences (persisted to localStorage). */
  uiPrefs: UiPrefs;
  /** Incremented to request focusing the quick-add input (keyboard `c` / `/`).
   *  QuickAdd watches this nonce and focuses itself; works regardless of which
   *  screen's QuickAdd is mounted. */
  quickAddFocusNonce: number;
  /** NL-command settings from the server (GET /api/agent/config). Drives the Add box's
   *  keyword detection + yellow border. `nlEnabled` is false until an admin configures an
   *  agent. */
  nlEnabled: boolean;
  nlKeywords: string[];
  /** Depth of the session undo/redo stacks (drives the toolbar buttons). */
  undoCount: number;
  redoCount: number;
  /** Whether this device pushes/pulls UI prefs, view filters, and perspectives to
   *  the server (default on; toggled in Settings → Features). */
  settingsSyncEnabled: boolean;
  /** True once the first sync round has completed (or immediately when local-only),
   *  so the first-load complexity picker doesn't flash before synced prefs arrive. */
  settingsHydrated: boolean;
  /** Transient snackbar (e.g. undoable delete). */
  toast: Toast | null;
  /** Prompt: a task was completed while a different project's session runs. */
  interrupt: { project: string } | null;

  setReady: (v: boolean) => void;
  setCurrentUser: (u: CurrentUser | null) => void;
  setAuthRequired: (v: boolean) => void;
  /** Open the sign-in flow on demand. */
  openLogin: () => void;
  /** Dismiss the sign-in flow and clear any pending auth requirement, dropping back
   *  to the app (local-only). The user can always back out of signing in. */
  closeLogin: () => void;
  setHostInfo: (info: {
    role: AppState['hostRole'];
    baseDomain: string | null;
    appHost: string | null;
    version?: string | null;
  }) => void;
  setWorkspaceLock: (locked: boolean, expiresAt: string | null) => void;
  setLocalOnly: (v: boolean) => void;
  bump: () => void;
  select: (id: string | null, kind?: 'item' | 'tag') => void;
  openDetail: () => void;
  closeDetail: () => void;
  setSidebarOpen: (v: boolean) => void;
  focusQuickAdd: () => void;
  toggleCollapsed: (id: string) => void;
  toggleExpanded: (id: string) => void;
  /** Collapse/expand every given id at once (the tree's "Collapse All"/"Expand
   *  All"). Scoped to the passed ids so other containers' collapse state is
   *  left untouched. */
  collapseAll: (ids: string[]) => void;
  expandAll: (ids: string[]) => void;
  setThemeMode: (m: ThemeMode) => void;
  setLightTheme: (t: Theme) => void;
  setDarkTheme: (t: Theme) => void;
  setAccent: (a: Accent) => void;
  setSyncStatus: (s: SyncStatus) => void;
  setSyncError: (msg: string | null) => void;
  setLastSyncedAt: (t: number) => void;
  setUiPrefs: (patch: Partial<UiPrefs>) => void;
  setSettingsSyncEnabled: (v: boolean) => void;
  setSettingsHydrated: (v: boolean) => void;
  setUndoCounts: (undo: number, redo: number) => void;
  showToast: (t: Omit<Toast, 'id'>) => void;
  dismissToast: () => void;
  setInterrupt: (v: { project: string } | null) => void;
  setNlConfig: (c: { enabled: boolean; keywords: string[] }) => void;
}

const COLLAPSE_KEY = 'carbon.collapsed';
const EXPAND_KEY = 'carbon.expanded';
function loadIdSet(key: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) || '[]') as string[]);
  } catch {
    return new Set();
  }
}

export const useStore = create<AppState>((set, get) => ({
  ready: false,
  dbRevision: currentRevision(),
  selectedId: null,
  selectedKind: 'item',
  detailOpen: false,
  sidebarOpen: false,
  collapsed: loadIdSet(COLLAPSE_KEY),
  expanded: loadIdSet(EXPAND_KEY),
  themeMode: getThemeMode(),
  lightTheme: getLightTheme(),
  darkTheme: getDarkTheme(),
  accent: getAccent(),
  syncStatus: 'idle',
  syncError: null,
  lastSyncedAt: null,
  currentUser: getCurrentUser(),
  authRequired: false,
  loginOpen: false,
  hostRole: null,
  baseDomain: null,
  appHost: null,
  serverVersion: null,
  localOnly: localStorage.getItem('carbon.localOnly') === '1',
  workspaceLocked: false,
  workspaceExpiresAt: null,
  uiPrefs: getUiPrefs(),
  settingsSyncEnabled: localStorage.getItem('carbon.settingsSync') !== '0',
  settingsHydrated: false,
  undoCount: 0,
  redoCount: 0,
  quickAddFocusNonce: 0,
  nlEnabled: false,
  nlKeywords: ['can', 'add', 'remind', 'check off', 'mark off', 'mark as'],
  toast: null,
  interrupt: null,

  setReady: (v) => set({ ready: v }),
  setCurrentUser: (u) => set({ currentUser: u }),
  setAuthRequired: (v) => set({ authRequired: v }),
  openLogin: () => set({ loginOpen: true }),
  closeLogin: () => set({ loginOpen: false, authRequired: false }),
  setHostInfo: (info) =>
    set({
      hostRole: info.role,
      baseDomain: info.baseDomain,
      appHost: info.appHost,
      serverVersion: info.version ?? get().serverVersion,
    }),
  setWorkspaceLock: (locked, expiresAt) =>
    set({ workspaceLocked: locked, workspaceExpiresAt: expiresAt }),
  setLocalOnly: (v) => {
    localStorage.setItem('carbon.localOnly', v ? '1' : '0');
    set({ localOnly: v });
  },
  bump: () => set(() => ({ dbRevision: bumpRevision() })),
  // Panes are mutually exclusive on compact screens: opening one closes the other.
  // Selecting does NOT auto-open the overlay (mobile needs a 2nd tap); the docked
  // desktop pane shows on selectedId regardless of detailOpen.
  select: (id, kind = 'item') =>
    set(
      id
        ? { selectedId: id, selectedKind: kind, sidebarOpen: false }
        : { selectedId: null, detailOpen: false },
    ),
  openDetail: () => set({ detailOpen: true }),
  closeDetail: () => set({ detailOpen: false }),
  setSidebarOpen: (v) =>
    set(v ? { sidebarOpen: true, selectedId: null, detailOpen: false } : { sidebarOpen: false }),
  focusQuickAdd: () => set((s) => ({ quickAddFocusNonce: s.quickAddFocusNonce + 1 })),
  toggleCollapsed: (id) =>
    set((s) => {
      const next = new Set(s.collapsed);
      next.has(id) ? next.delete(id) : next.add(id);
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]));
      notifySettingsChanged('ui');
      return { collapsed: next };
    }),
  toggleExpanded: (id) =>
    set((s) => {
      const next = new Set(s.expanded);
      next.has(id) ? next.delete(id) : next.add(id);
      localStorage.setItem(EXPAND_KEY, JSON.stringify([...next]));
      notifySettingsChanged('ui');
      return { expanded: next };
    }),
  collapseAll: (ids) =>
    set((s) => {
      const next = new Set(s.collapsed);
      for (const id of ids) next.add(id);
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]));
      notifySettingsChanged('ui');
      return { collapsed: next };
    }),
  expandAll: (ids) =>
    set((s) => {
      const next = new Set(s.collapsed);
      for (const id of ids) next.delete(id);
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]));
      notifySettingsChanged('ui');
      return { collapsed: next };
    }),
  // Each theme control re-applies the full (mode, light, dark) triple to the DOM.
  setThemeMode: (m) => {
    const s = get();
    applyTheme(m, s.lightTheme, s.darkTheme);
    set({ themeMode: m });
  },
  setLightTheme: (t) => {
    const s = get();
    applyTheme(s.themeMode, t, s.darkTheme);
    set({ lightTheme: t });
  },
  setDarkTheme: (t) => {
    const s = get();
    applyTheme(s.themeMode, s.lightTheme, t);
    set({ darkTheme: t });
  },
  setAccent: (a) => set({ accent: a }),
  setSyncStatus: (s) => set({ syncStatus: s, ...(s === 'idle' ? { syncError: null } : {}) }),
  setSyncError: (msg) => set({ syncError: msg }),
  setLastSyncedAt: (t) => set({ lastSyncedAt: t }),
  setUiPrefs: (patch) =>
    set((s) => {
      const next = { ...s.uiPrefs, ...patch };
      saveUiPrefs(next);
      return { uiPrefs: next };
    }),
  setSettingsSyncEnabled: (v) => set({ settingsSyncEnabled: v }),
  setSettingsHydrated: (v) => set({ settingsHydrated: v }),
  setUndoCounts: (undo, redo) => set({ undoCount: undo, redoCount: redo }),
  showToast: (t) => set((s) => ({ toast: { ...t, id: (s.toast?.id ?? 0) + 1 } })),
  dismissToast: () => set({ toast: null }),
  setInterrupt: (v) => set({ interrupt: v }),
  setNlConfig: (c) => set({ nlEnabled: c.enabled, nlKeywords: c.keywords }),
}));

export function getCurrentUserId(): string | null {
  return useStore.getState().currentUser?.id ?? null;
}
