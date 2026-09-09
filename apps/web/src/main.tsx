// Public pages and local entry are resolved before importing the app/database.
import { isNative } from './lib/platform';

async function enter(): Promise<void> {
  // An installed older service worker may supply the app shell at the apex root.
  // Resolve that cached entry before importing SQLite or the app. Native/quick-add
  // entries and offline launches retain their existing boot path.
  if (
    !isNative &&
    ['/', '/index.html'].includes(location.pathname) &&
    new URLSearchParams(location.search).get('view') !== 'quick'
  ) {
    try {
      const response = await fetch('/api/health', { signal: AbortSignal.timeout(1500) });
      if (response.ok && (await response.json()).role === 'apex') {
        location.replace('/landing');
        return;
      }
    } catch {
      /* Offline or standalone preview: start the app normally. */
    }
  }
  if (!isNative && ['/signup', '/privacy'].includes(location.pathname)) {
    await import('./public-entry');
    return;
  }
  if (!isNative && location.pathname === '/local') {
    const { getServerConfig, saveServerConfig, saveCurrentUser } = await import('./lib/config');
    saveServerConfig({
      ...getServerConfig(),
      url: '',
      username: '',
      password: '',
      token: '',
    });
    saveCurrentUser(null);
    localStorage.setItem('carbon.localOnly', '1');
    history.replaceState(null, '', '/today');
  }
  await import('./boot');
}
void enter().catch((error) => {
  console.error('Unable to start Carbon:', error);
  document.getElementById('root')!.textContent =
    'Carbon could not start. Check that browser storage is available, then reload.';
});
