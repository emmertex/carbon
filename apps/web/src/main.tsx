import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import App from './App';
import { initDb, registerPersistFlush } from './lib/db';
import { useStore } from './lib/store';
import {
  applyTheme,
  getThemeMode,
  getLightTheme,
  getDarkTheme,
  applyAccent,
  getAccent,
} from './lib/config';
import { startSyncLoop, syncNow, fetchIdentity, fetchHostInfo } from './lib/sync';
import { registerSW } from 'virtual:pwa-register';
import './lib/pwa'; // capture the install prompt at startup

registerSW({ immediate: true });
applyTheme(getThemeMode(), getLightTheme(), getDarkTheme());
applyAccent(getAccent());

// Desktop spotlight quick-add window: the Tauri `quick` window loads `?view=quick`
// and renders a minimal capture bar instead of the full app — no DB boot, no sync
// loop — forwarding typed tasks to the main window. The normal web/PWA/Android boot
// path (bootApp, below) is untouched.
if (new URLSearchParams(location.search).get('view') === 'quick') {
  void import('./desktop/QuickAddWindow').then((m) => m.mountQuickAddWindow());
} else {
  bootApp();
}

function bootApp(): void {
  // Perf instrumentation / benchmark mode: dev build + an explicit opt-in flag. The
  // dev-seed helpers include a destructive __carbonReset, so they're gated on this
  // (not merely dev) to keep them out of normal dev sessions.
  const perfActive =
    import.meta.env.DEV &&
    (localStorage.getItem('carbon.perf') === '1' ||
      new URLSearchParams(location.search).has('perf'));
  const e2eActive =
    import.meta.env.DEV &&
    (import.meta.env.VITE_CARBON_E2E === '1' ||
      localStorage.getItem('carbon.e2e') === '1');

  async function boot(): Promise<void> {
    try {
      await initDb();
      registerPersistFlush(); // flush unsaved writes on tab hide/close (no data loss)
      if (perfActive || e2eActive) {
        const { registerDevSeed } = await import('./lib/devSeed');
        registerDevSeed(); // window.__carbonSeed/__carbonReset for perf + e2e
      }
      if (e2eActive) {
        const { registerE2eHooks } = await import('./lib/e2e');
        registerE2eHooks();
      }
      const { initSettingsSync } = await import('./lib/settings-sync');
      initSettingsSync(); // mirror UI prefs / views / perspectives to sync on change
      useStore.getState().setReady(true);
      // Resolve host role first so a tenant host is wired to its origin (and the
      // offline host detached) before we fetch identity / sync.
      await fetchHostInfo();
      void fetchIdentity();
      startSyncLoop();
      void syncNow();
      // Resume foreground geofencing if the user enabled it.
      const { geofencePref, startGeofencing } = await import('./lib/geo');
      if (geofencePref()) void startGeofencing();
      // Resume GPS track recorder if a session is open and the pref is on.
      const { resumeGpsIfNeeded } = await import('./lib/gpsTrack');
      void resumeGpsIfNeeded();
      // Resume local reminders if enabled (native scheduling on Capacitor, else scan).
      const { localRemindersPref, startLocalReminders } = await import('./lib/localReminders');
      if (localRemindersPref()) void startLocalReminders();
    } catch (err) {
      console.error('Failed to initialize Carbon:', err);
    }
  }
  void boot();

  // StrictMode double-invokes render/effects in dev, which doubles render cost and
  // would skew (and slow) the perf benchmark. Skip it only when perf mode is active
  // so render timings reflect a single real render.
  const tree = (
    <BrowserRouter>
      <App />
    </BrowserRouter>
  );

  createRoot(document.getElementById('root')!).render(
    perfActive || e2eActive ? tree : <React.StrictMode>{tree}</React.StrictMode>,
  );
}
