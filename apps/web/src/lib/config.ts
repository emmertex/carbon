import { isNative } from './platform';
import { notifySettingsChanged } from './settings-events';
import { settingsKey } from './identity';
import {
  DEFAULT_COMPLEXITY,
  DEFAULT_FEATURE_PREFS,
  type Complexity,
  type FeaturePrefs,
} from './features';
import type { CupConvention } from './recipe';

/**
 * How eagerly this device pulls attachment / note-image blobs off the sync server.
 * The three modes differ only in what is fetched *ahead of time*; anything not
 * prefetched still downloads the first time something displays it.
 *
 * 'on-demand'  — prefetch nothing, not even thumbnails. The leanest option: a note
 *   list downloads a thumbnail only as its row scrolls into view.
 * 'thumbnails' — prefetch row thumbnails (kilobytes each), leave full-size images
 *   and attachments to first use. The default: note lists render complete and
 *   offline without pulling a single full-size photo.
 * 'all'        — prefetch every referenced blob on each sync, so notes and
 *   attachments open instantly offline. No pruning; the cache grows with the
 *   workspace.
 *
 * `blobCacheMb` prunes the cache by least-recently-used in the first two modes.
 * Thumbnails are never evicted in any mode — they're what makes a note list render
 * without touching a full-size image, and they cost almost nothing to keep.
 */
export type BlobFetchMode = 'on-demand' | 'thumbnails' | 'all';

export interface ServerConfig {
  url: string;
  username: string;
  /** Transient only — held while signing in, never persisted (exchanged for `token`). */
  password: string;
  /** Opaque session token from /api/login. This, not the password, is what's stored. */
  token: string;
  autoSync: boolean;
  /** Blob caching strategy for this device (see BlobFetchMode). Deliberately
   *  device-local, not a synced UI pref: a phone and a desktop want different
   *  answers. */
  blobFetch: BlobFetchMode;
  /** LRU cache budget in MB, honoured in every mode except 'all'. 0 = never evict. */
  blobCacheMb: number;
}

/** Default cache budget (MB) before least-recently-used blobs are dropped. */
export const DEFAULT_BLOB_CACHE_MB = 250;

const SERVER_KEY = 'carbon.server';

/** The public multi-tenant base domain: hosted workspaces live at
 *  `<workspace>.<PUBLIC_BASE_DOMAIN>`. Used to let native sign-in ask for just a
 *  workspace name (plus an editable domain for self-hosters) instead of a full URL. */
export const PUBLIC_BASE_DOMAIN = 'carbon.etx.sx';

/** Where the hosted Carbon SaaS control plane lives — the base for signup and other
 *  `/host/*` calls on native builds, which are served from localhost (Capacitor) or a
 *  tauri:// origin and so can't derive a useful server from `window.location`. */
export const HOSTED_SERVER_URL = `https://app.${PUBLIC_BASE_DOMAIN}`;

/**
 * The server URL to pre-fill when the user hasn't configured one. Native shells
 * (Tauri / Capacitor) default to the hosted SaaS; a browser PWA defaults to the
 * origin it was served from (a tenant subdomain or self-host serves its own API).
 */
export function defaultServerUrl(): string {
  if (isNative) return HOSTED_SERVER_URL;
  return typeof window !== 'undefined' ? window.location.origin : '';
}

/** Build a server URL from a workspace name + base domain. A blank workspace yields
 *  the bare domain (self-host / single-tenant); otherwise `<workspace>.<domain>`.
 *  Returns '' when the domain is empty. */
export function workspaceUrl(workspace: string, domain: string): string {
  const w = workspace.trim().toLowerCase().replace(/^\/+|\/+$/g, '');
  const d = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/g, '');
  if (!d) return '';
  return `https://${w ? `${w}.` : ''}${d}`;
}

/** Split a configured server URL back into { workspace, domain } so the split
 *  sign-in fields can be re-populated. A host under the public base domain yields
 *  its label as the workspace; any other host is treated as a bare self-host domain. */
export function splitServerUrl(url: string): { workspace: string; domain: string } {
  const host = (url || '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/g, '')
    .toLowerCase();
  if (!host) return { workspace: '', domain: PUBLIC_BASE_DOMAIN };
  const suffix = `.${PUBLIC_BASE_DOMAIN}`;
  if (host.endsWith(suffix)) {
    return { workspace: host.slice(0, -suffix.length), domain: PUBLIC_BASE_DOMAIN };
  }
  if (host === PUBLIC_BASE_DOMAIN) return { workspace: '', domain: PUBLIC_BASE_DOMAIN };
  return { workspace: '', domain: host };
}

/** The canonical endpoint key of a server URL ('' when none) — the workspace
 *  part of an identity key, and the namespacing key for all per-workspace
 *  storage (`carbon.wsauth.<ws>`, `carbon.server.<ws>`, A3 identity/store keys).
 *  `splitServerUrl` is the separate display helper for the sign-in UI.
 *
 *  The scheme is PRESERVED when present, so `http://host` and `https://host`
 *  (distinct endpoints/stores) map to distinct keys instead of colliding on the
 *  bare host. A scheme-less URL is unchanged from the legacy behaviour (bare
 *  host:port, trailing-slash-stripped, lowercased) so every existing bare key is
 *  byte-identical. */
export function workspaceHostOf(url: string | undefined | null): string {
  const s = (url || '').trim().toLowerCase();
  const m = s.match(/^(https?):\/\/(.*)$/);
  if (m) {
    // Preserve the scheme; normalize the rest (strip trailing slashes).
    return `${m[1]}://${m[2].replace(/\/+$/, '')}`;
  }
  // No scheme: bare host:port/path — identical to the legacy no-scheme key.
  return s.replace(/\/+$/, '');
}

const DEFAULT_SERVER: ServerConfig = {
  url: '',
  username: '',
  password: '',
  token: '',
  autoSync: true,
  blobFetch: 'thumbnails',
  blobCacheMb: DEFAULT_BLOB_CACHE_MB,
};

export function getServerConfig(): ServerConfig {
  try {
    const raw = localStorage.getItem(SERVER_KEY);
    if (!raw) return { ...DEFAULT_SERVER };
    return { ...DEFAULT_SERVER, ...(JSON.parse(raw) as Partial<ServerConfig>) };
  } catch {
    return { ...DEFAULT_SERVER };
  }
}

export function saveServerConfig(cfg: ServerConfig): void {
  // Never persist the password — it lives only in memory during sign-in and is
  // exchanged for `token`. This guarantees no plaintext credential hits storage.
  const prev = getServerConfig();
  const prevWs = workspaceHostOf(prev.url);
  const newWs = workspaceHostOf(cfg.url);
  let toSave: ServerConfig = { ...cfg, password: '' };
  if (prevWs && prevWs !== newWs) {
    // Snapshot the outgoing workspace's credentials so switching back to it
    // restores its token/username instead of forcing a re-auth.
    localStorage.setItem(`carbon.server.${prevWs}`, JSON.stringify({ ...prev, password: '' }));
  }
  if (newWs && newWs !== prevWs) {
    // Returning to a known workspace: restore its saved credentials when the
    // caller didn't supply their own (the URL field alone doesn't carry them).
    const snap = localStorage.getItem(`carbon.server.${newWs}`);
    if (snap) {
      try {
        const s = JSON.parse(snap) as Partial<ServerConfig>;
        if (!toSave.token && s.token) toSave = { ...toSave, token: s.token };
        if (!toSave.username && s.username) toSave = { ...toSave, username: s.username };
      } catch {
        /* unreadable snapshot — fall through with the fresh config */
      }
    }
  }
  localStorage.setItem(SERVER_KEY, JSON.stringify(toSave));
  if (newWs) localStorage.setItem(`carbon.server.${newWs}`, JSON.stringify(toSave));

  // A URL/host change can change the identity (workspace part). Listeners
  // (sync.ts registers one that re-binds the app) run after the write and are
  // told the old/new workspace so they can ignore saves that don't switch
  // workspaces (e.g. a 401 that only clears the token on the SAME server).
  for (const fn of serverConfigListeners) {
    try {
      fn(prevWs, newWs);
    } catch {
      /* listener errors must never break a config save */
    }
  }
}

const serverConfigListeners = new Set<(prevWs: string, newWs: string) => void>();

/** Register a callback for server-config saves (returns an unregister fn).
 *  Called with the previous and new workspace hosts after each save, so callers
 *  can re-bind the app only when the workspace actually changed. */
export function onServerConfigSaved(fn: (prevWs: string, newWs: string) => void): () => void {
  serverConfigListeners.add(fn);
  return () => {
    serverConfigListeners.delete(fn);
  };
}

// ----- per-workspace auth-state record (SAFE DEFAULT) ------------------------
//
// Mirrors the `carbon.server.<ws>` credential snapshots. Auto-restore on return
// requires a POSITIVE 'in' record (written on explicit sign-in). An 'out'
// record (written on explicit sign-out) OR an ABSENT record — the safe default,
// since a storage clear removes the record — both present the sign-in gate
// instead of auto-restoring. A clear can therefore only ever GATE, never
// produce a false signed-in. See restoreSessionOrGate in sync.ts.

const WS_AUTH_PREFIX = 'carbon.wsauth.';

/** Per-workspace auth-state. 'in' = signed in (may auto-restore), 'out' =
 *  explicitly signed out (gate), null = absent (safe default: gate). */
export type WorkspaceAuthState = 'in' | 'out';

/** Read the per-workspace auth-state record. Returns 'in' / 'out' / null
 *  (absent). A storage clear removes the record → null → gate. */
export function getWorkspaceAuthState(ws: string): WorkspaceAuthState | null {
  if (!ws || ws === 'local') return null;
  try {
    const raw = localStorage.getItem(`${WS_AUTH_PREFIX}${ws}`);
    if (!raw) return null;
    const p = JSON.parse(raw) as { s?: string };
    return p.s === 'in' || p.s === 'out' ? p.s : null;
  } catch {
    return null; // localStorage unavailable (node) or unreadable record
  }
}

/** Write the per-workspace auth-state record: 'in' (signed in), 'out' (signed
 *  out), or null (clear the record → safe default of gate). */
export function setWorkspaceAuthState(ws: string, state: WorkspaceAuthState | null): void {
  if (!ws || ws === 'local') {
    if (state === null) {
      try {
        localStorage.removeItem(`${WS_AUTH_PREFIX}${ws}`);
      } catch {
        /* ignore */
      }
    }
    return;
  }
  try {
    if (state === null) localStorage.removeItem(`${WS_AUTH_PREFIX}${ws}`);
    else localStorage.setItem(`${WS_AUTH_PREFIX}${ws}`, JSON.stringify({ s: state, t: Date.now() }));
  } catch {
    /* localStorage unavailable (node) — nothing to record */
  }
}

/**
 * Clear the saved TOKEN (only) in a workspace's `carbon.server.<ws>` credential
 * snapshot, keeping the username for pre-fill. Called on explicit sign-out so
 * that even if the auth-state record were reset, no surviving credential could
 * be auto-restored. A later re-sign-in re-snapshots it via saveServerConfig.
 */
export function clearWorkspaceSnapshotToken(ws: string): void {
  if (!ws || ws === 'local') return;
  try {
    const raw = localStorage.getItem(`carbon.server.${ws}`);
    if (!raw) return;
    const s = JSON.parse(raw) as Partial<ServerConfig>;
    if (!s.token) return; // nothing to clear
    s.token = '';
    localStorage.setItem(`carbon.server.${ws}`, JSON.stringify(s));
  } catch {
    /* unreadable snapshot — nothing to clear */
  }
}

// ----- UI / gesture preferences --------------------------------------------

export type SwipeLeftAction = 'flag' | 'delete' | 'plan' | 'details';
export type EdgeGestureAction = 'projectRoot' | 'today' | 'inbox' | 'plan';
export type CountScope = 'all' | 'direct';
export type PlanGrouping = 'nested' | 'flat';

/** Which per-row icons/affordances the task rows render. A global view preference
 *  toggled from the View row; Flag and Plan are independent here (no auto-swap). */
export type RowIcon = 'focus' | 'shared' | 'assigned' | 'tags' | 'flag' | 'plan';
export type RowIcons = Record<RowIcon, boolean>;

export interface UiPrefs {
  /** Action for a right-to-left task swipe. Right swipe is always Complete. */
  swipeLeftAction: SwipeLeftAction;
  /** Edge zones drive the panes (and the centre drives task swipes). When off,
   *  task swipes use the full row width and panes open only via the menu. */
  paneGestures: boolean;
  firstTapDetails: boolean;
  /** Action for the right-edge right-to-left swipe. */
  edgeGestureAction: EdgeGestureAction;
  /** What the pie ring and remaining-work counts measure. */
  countScope: CountScope;
  /** Plan view: nest a planned parent's available actions beneath it, or surface
   *  those actions flat (no parent header). */
  planGrouping: PlanGrouping;
  /** Per-row iconography visibility (the View row toggles). */
  rowIcons: RowIcons;
  /** UI complexity: which optional feature surfaces show. A preset, or 'custom' to
   *  honour the per-feature `features` map. */
  complexity: Complexity;
  /** Whether the first-run complexity picker has been answered on this account. */
  complexityChosen: boolean;
  /** Whether the first-run sync-server intro has been dismissed ("Welcome"). Shown
   *  after the complexity picker. */
  welcomed: boolean;
  /** Per-feature desktop/mobile visibility; consulted only when complexity==='custom'. */
  features: FeaturePrefs;
  /** Which measuring-cup standard the recipe view converts against. */
  cupConvention: CupConvention;
}

/** Per-user UI prefs (A3): namespaced by the current identity's user part. */
const UI_KEY = () => settingsKey('carbon.ui');

export const DEFAULT_ROW_ICONS: RowIcons = {
  focus: false,
  shared: true,
  assigned: true,
  tags: true,
  flag: true,
  plan: false,
};

const DEFAULT_UI: UiPrefs = {
  swipeLeftAction: 'plan',
  paneGestures: true,
  firstTapDetails: false,
  edgeGestureAction: 'projectRoot',
  countScope: 'all',
  planGrouping: 'nested',
  rowIcons: { ...DEFAULT_ROW_ICONS },
  complexity: DEFAULT_COMPLEXITY,
  complexityChosen: false,
  welcomed: false,
  features: DEFAULT_FEATURE_PREFS,
  cupConvention: 'au',
};

export function getUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(UI_KEY());
    if (!raw) return { ...DEFAULT_UI, rowIcons: { ...DEFAULT_ROW_ICONS } };
    const { tapOpensDetail, ...parsed } = JSON.parse(raw) as Partial<UiPrefs> & { tapOpensDetail?: boolean };
    // Consolidate the duplicate merge-era setting, preserving either enabled choice.
    // The legacy field is excluded so the next save cannot re-enable it.
    const firstTapDetails = parsed.firstTapDetails === true || tapOpensDetail === true;
    // rowIcons and features are nested, so merge them explicitly to pick up
    // newly-added icons / feature ids without dropping a saved partial.
    return {
      ...DEFAULT_UI,
      ...parsed,
      firstTapDetails,
      rowIcons: { ...DEFAULT_ROW_ICONS, ...parsed.rowIcons },
      features: { ...DEFAULT_FEATURE_PREFS, ...parsed.features },
    };
  } catch {
    return { ...DEFAULT_UI, rowIcons: { ...DEFAULT_ROW_ICONS } };
  }
}

export function saveUiPrefs(p: UiPrefs): void {
  localStorage.setItem(UI_KEY(), JSON.stringify(p));
  notifySettingsChanged('ui');
}

export interface CurrentUser {
  id: string;
  username: string;
  display_name: string | null;
  role: 'admin' | 'member';
  is_bot: boolean;
  avatar_color: string | null;
  avatar_initial?: string | null;
  plan_startup_min?: number | null;
  plan_default_estimate_min?: number | null;
  ha_person?: string | null;
  /** True when the server has no accounts and is running open (no login). */
  open?: boolean;
}

const USER_KEY = 'carbon.user';

export function getCurrentUser(): CurrentUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as CurrentUser) : null;
  } catch {
    return null;
  }
}

export function saveCurrentUser(user: CurrentUser | null): void {
  if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
  else localStorage.removeItem(USER_KEY);
}

/** The device's IANA zone (e.g. "Australia/Melbourne"), sent with NL requests so the
 *  server's LLM prompt resolves "tomorrow night" against the user's local clock. */
export function localTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

export function authHeaders(cfg: ServerConfig): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.token) {
    headers.Authorization = 'Bearer ' + cfg.token;
  } else if (cfg.username && cfg.password) {
    // Basic only during the brief sign-in window before a token is obtained.
    headers.Authorization = 'Basic ' + btoa(`${cfg.username}:${cfg.password}`);
  }
  return headers;
}

// ----- theme ----------------------------------------------------------------

/** A concrete palette applied via `data-theme`. */
export type Theme =
  | 'light'
  | 'dark'
  | 'epaper'
  | 'gruvbox'
  | 'gruvboxlight'
  | 'ayu'
  | 'nord'
  | 'nordlight'
  | 'catppuccin'
  | 'catppuccinlight';
/** How the active palette is chosen. The light/dark *roles* are user-assignable. */
export type ThemeMode = 'system' | 'light' | 'dark';
export type Accent =
  | 'indigo'
  | 'blue'
  | 'violet'
  | 'teal'
  | 'green'
  | 'amber'
  | 'rose'
  | 'aqua'
  | 'orange';

const MODE_KEY = 'carbon.themeMode';
const LIGHT_KEY = 'carbon.lightTheme';
const DARK_KEY = 'carbon.darkTheme';
const LEGACY_THEME_KEY = 'carbon.theme';
const ACCENT_KEY = 'carbon.accent';

export const LIGHT_THEMES: { id: Theme; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'epaper', label: 'ePaper' },
  { id: 'gruvboxlight', label: 'Gruvbox Light' },
  { id: 'nordlight', label: 'Nord Light' },
  { id: 'catppuccinlight', label: 'Catppuccin Light' },
];
export const DARK_THEMES: { id: Theme; label: string }[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'gruvbox', label: 'Gruvbox' },
  { id: 'ayu', label: 'Ayu Dark' },
  { id: 'nord', label: 'Nord' },
  { id: 'catppuccin', label: 'Catppuccin' },
];
export const THEME_MODES: { id: ThemeMode; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

export const ACCENTS: { id: Accent; color: string }[] = [
  { id: 'indigo', color: '#6366f1' },
  { id: 'blue', color: '#2563eb' },
  { id: 'violet', color: '#7c3aed' },
  { id: 'teal', color: '#0d9488' },
  { id: 'green', color: '#16a34a' },
  { id: 'amber', color: '#d97706' },
  { id: 'rose', color: '#e11d48' },
  { id: 'aqua', color: '#689d6a' }, // gruvbox aqua
  { id: 'orange', color: '#d65d0e' }, // gruvbox orange
];

const isLight = (t: string | null): t is Theme =>
  t === 'light' ||
  t === 'epaper' ||
  t === 'gruvboxlight' ||
  t === 'nordlight' ||
  t === 'catppuccinlight';
const isDarkTheme = (t: string | null): t is Theme =>
  t === 'dark' || t === 'gruvbox' || t === 'ayu' || t === 'nord' || t === 'catppuccin';

export function getThemeMode(): ThemeMode {
  const m = localStorage.getItem(MODE_KEY);
  if (m === 'system' || m === 'light' || m === 'dark') return m;
  const legacy = localStorage.getItem(LEGACY_THEME_KEY); // migrate single-theme setups
  if (isLight(legacy)) return 'light';
  if (isDarkTheme(legacy)) return 'dark';
  return 'system';
}
export function getLightTheme(): Theme {
  const t = localStorage.getItem(LIGHT_KEY);
  if (isLight(t)) return t;
  return localStorage.getItem(LEGACY_THEME_KEY) === 'epaper' ? 'epaper' : 'light';
}
export function getDarkTheme(): Theme {
  const t = localStorage.getItem(DARK_KEY);
  if (isDarkTheme(t)) return t;
  return localStorage.getItem(LEGACY_THEME_KEY) === 'gruvbox' ? 'gruvbox' : 'dark';
}
export function getAccent(): Accent {
  const a = localStorage.getItem(ACCENT_KEY) as Accent;
  return ACCENTS.some((x) => x.id === a) ? a : 'indigo';
}

function resolveTheme(mode: ThemeMode, light: Theme, dark: Theme): Theme {
  if (mode === 'light') return light;
  if (mode === 'dark') return dark;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? dark : light;
}

/** The palette currently shown, resolving System against the OS preference. */
export function getActiveTheme(): Theme {
  return resolveTheme(getThemeMode(), getLightTheme(), getDarkTheme());
}

export function applyTheme(mode: ThemeMode, light: Theme, dark: Theme): void {
  localStorage.setItem(MODE_KEY, mode);
  localStorage.setItem(LIGHT_KEY, light);
  localStorage.setItem(DARK_KEY, dark);
  localStorage.removeItem(LEGACY_THEME_KEY);
  document.documentElement.dataset.theme = resolveTheme(mode, light, dark);
}
export function applyAccent(accent: Accent): void {
  localStorage.setItem(ACCENT_KEY, accent);
  document.documentElement.dataset.accent = accent;
}
