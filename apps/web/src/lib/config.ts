import { isNative } from './platform';
import { notifySettingsChanged } from './settings-events';
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
  localStorage.setItem(SERVER_KEY, JSON.stringify({ ...cfg, password: '' }));
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

const UI_KEY = 'carbon.ui';

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
    const raw = localStorage.getItem(UI_KEY);
    if (!raw) return { ...DEFAULT_UI, rowIcons: { ...DEFAULT_ROW_ICONS } };
    const parsed = JSON.parse(raw) as Partial<UiPrefs>;
    // rowIcons and features are nested, so merge them explicitly to pick up
    // newly-added icons / feature ids without dropping a saved partial.
    return {
      ...DEFAULT_UI,
      ...parsed,
      rowIcons: { ...DEFAULT_ROW_ICONS, ...parsed.rowIcons },
      features: { ...DEFAULT_FEATURE_PREFS, ...parsed.features },
    };
  } catch {
    return { ...DEFAULT_UI, rowIcons: { ...DEFAULT_ROW_ICONS } };
  }
}

export function saveUiPrefs(p: UiPrefs): void {
  localStorage.setItem(UI_KEY, JSON.stringify(p));
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
