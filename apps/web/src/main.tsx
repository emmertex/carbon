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

// Perf instrumentation / benchmark mode: dev build + an explicit opt-in flag. The
// dev-seed helpers include a destructive __carbonReset, so they're gated on this
// (not merely dev) to keep them out of normal dev sessions.
const perfActive =
  import.meta.env.DEV &&
  (localStorage.getItem('carbon.perf') === '1' ||
    new URLSearchParams(location.search).has('perf'));

async function boot(): Promise<void> {
  try {
    await initDb();
    registerPersistFlush(); // flush unsaved writes on tab hide/close (no data loss)
    if (perfActive) {
      const { registerDevSeed } = await import('./lib/devSeed');
      registerDevSeed(); // window.__carbonSeed/__carbonReset for the perf benchmark
    }
    useStore.getState().setReady(true);
    // Resolve host role first so a tenant host is wired to its origin (and the
    // offline host detached) before we fetch identity / sync.
    await fetchHostInfo();
    void fetchIdentity();
    startSyncLoop();
    void syncNow();
    // Resume foreground geofencing if the user enabled it.
    const { geofencePref, startGeofencing } = await import('./lib/geo');
    if (geofencePref()) startGeofencing();
    // Resume foreground local reminders if enabled.
    const { localRemindersPref, startLocalReminders } = await import('./lib/localReminders');
    if (localRemindersPref()) startLocalReminders();
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
  perfActive ? tree : <React.StrictMode>{tree}</React.StrictMode>,
);
