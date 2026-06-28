export interface ServerConfig {
  url: string;
  username: string;
  /** Transient only — held while signing in, never persisted (exchanged for `token`). */
  password: string;
  /** Opaque session token from /api/login. This, not the password, is what's stored. */
  token: string;
  autoSync: boolean;
}

const SERVER_KEY = 'carbon.server';

const DEFAULT_SERVER: ServerConfig = {
  url: '',
  username: '',
  password: '',
  token: '',
  autoSync: true,
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
}

const UI_KEY = 'carbon.ui';

const DEFAULT_UI: UiPrefs = {
  swipeLeftAction: 'plan',
  paneGestures: true,
  edgeGestureAction: 'projectRoot',
  countScope: 'all',
  planGrouping: 'nested',
};

export function getUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(UI_KEY);
    if (!raw) return { ...DEFAULT_UI };
    return { ...DEFAULT_UI, ...(JSON.parse(raw) as Partial<UiPrefs>) };
  } catch {
    return { ...DEFAULT_UI };
  }
}

export function saveUiPrefs(p: UiPrefs): void {
  localStorage.setItem(UI_KEY, JSON.stringify(p));
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
export type Theme = 'light' | 'dark' | 'epaper' | 'gruvbox';
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
];
export const DARK_THEMES: { id: Theme; label: string }[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'gruvbox', label: 'Gruvbox' },
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

const isLight = (t: string | null): t is Theme => t === 'light' || t === 'epaper';
const isDarkTheme = (t: string | null): t is Theme => t === 'dark' || t === 'gruvbox';

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
export function isDarkActive(): boolean {
  return isDarkTheme(getActiveTheme());
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
