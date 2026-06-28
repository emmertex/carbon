import {
  applyAccent,
  THEME_MODES,
  LIGHT_THEMES,
  DARK_THEMES,
  ACCENTS,
  type Accent,
} from '@/lib/config';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/cn';
import { SettingsSection } from './SettingsSection';
import { ThemeChip } from './controls';

export function AppearanceSection() {
  const themeMode = useStore((s) => s.themeMode);
  const lightTheme = useStore((s) => s.lightTheme);
  const darkTheme = useStore((s) => s.darkTheme);
  const setThemeMode = useStore((s) => s.setThemeMode);
  const setLightTheme = useStore((s) => s.setLightTheme);
  const setDarkTheme = useStore((s) => s.setDarkTheme);
  const accent = useStore((s) => s.accent);
  const setAccent = useStore((s) => s.setAccent);

  function chooseAccent(a: Accent) {
    setAccent(a);
    applyAccent(a);
  }

  return (
    <SettingsSection id="appearance" title="Appearance">
      <span className="mb-1 block text-sm font-medium">Mode</span>
      <div className="mb-4 flex flex-wrap gap-2">
        {THEME_MODES.map((m) => (
          <ThemeChip
            key={m.id}
            label={m.label}
            active={themeMode === m.id}
            onClick={() => setThemeMode(m.id)}
          />
        ))}
      </div>

      <div className="mb-4 grid gap-4 sm:grid-cols-2">
        <div>
          <span className="mb-1 block text-sm font-medium">Light theme</span>
          <div className="flex flex-wrap gap-2">
            {LIGHT_THEMES.map((t) => (
              <ThemeChip
                key={t.id}
                label={t.label}
                active={lightTheme === t.id}
                onClick={() => setLightTheme(t.id)}
              />
            ))}
          </div>
        </div>
        <div>
          <span className="mb-1 block text-sm font-medium">Dark theme</span>
          <div className="flex flex-wrap gap-2">
            {DARK_THEMES.map((t) => (
              <ThemeChip
                key={t.id}
                label={t.label}
                active={darkTheme === t.id}
                onClick={() => setDarkTheme(t.id)}
              />
            ))}
          </div>
        </div>
      </div>

      <span className="mb-1 block text-sm font-medium">Accent</span>
      <div className="flex flex-wrap gap-2">
        {ACCENTS.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => chooseAccent(a.id)}
            title={a.id}
            aria-label={`Accent: ${a.id}`}
            className={cn(
              'h-7 w-7 rounded-full border transition-transform hover:scale-110',
              accent === a.id ? 'border-text ring-2 ring-text/30' : 'border-border',
            )}
            style={{ background: a.color }}
          />
        ))}
      </div>
    </SettingsSection>
  );
}
