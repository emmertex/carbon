import { Sun, Moon } from 'lucide-react';
import { useStore } from '@/lib/store';
import { DARK_THEMES } from '@/lib/config';

const darkIds = new Set(DARK_THEMES.map((t) => t.id));

/** Quick light/dark toggle. The mode + per-role theme picker lives in Settings. */
export function ThemeToggle() {
  const themeMode = useStore((s) => s.themeMode);
  const lightTheme = useStore((s) => s.lightTheme);
  const darkTheme = useStore((s) => s.darkTheme);
  const setThemeMode = useStore((s) => s.setThemeMode);

  const active =
    themeMode === 'light'
      ? lightTheme
      : themeMode === 'dark'
        ? darkTheme
        : window.matchMedia('(prefers-color-scheme: dark)').matches
          ? darkTheme
          : lightTheme;
  const isDark = darkIds.has(active);

  return (
    <button
      onClick={() => setThemeMode(isDark ? 'light' : 'dark')}
      className="rounded-lg p-2 text-text-muted hover:bg-surface-2 hover:text-text"
      title={isDark ? 'Switch to light' : 'Switch to dark'}
      aria-label="Toggle light/dark"
    >
      {isDark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}
