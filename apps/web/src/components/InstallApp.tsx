import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { canInstall, isStandalone, onInstallChange, promptInstall } from '@/lib/pwa';
import { isNative } from '@/lib/platform';
import { LINKS } from '@/lib/links';
import { SettingsSection } from './settings/SettingsSection';
import { DocLink, btnPrimary } from './settings/controls';

export function InstallApp() {
  const [installable, setInstallable] = useState(canInstall());
  const [installed, setInstalled] = useState(isStandalone());

  useEffect(
    () =>
      onInstallChange(() => {
        setInstallable(canInstall());
        setInstalled(isStandalone());
      }),
    [],
  );

  // Only meaningful in a browser tab. Native shells (Tauri/Capacitor) and an
  // already-installed PWA (standalone display-mode) are themselves the install —
  // there's nothing to offer, so the section disappears entirely.
  if (isNative || installed) return null;

  async function install() {
    const outcome = await promptInstall();
    if (outcome === 'accepted') setInstalled(true);
  }

  return (
    <SettingsSection id="install" title="Install app">
      {/* Only surface the PWA install affordance when we can actually trigger it
          via a button — no manual "open the browser menu" instructions. */}
      {installable && (
        <>
          <p className="mb-3 text-sm text-text-muted">
            Add Carbon to your home screen for a full-screen, offline-ready app.
          </p>
          <button onClick={install} className={btnPrimary}>
            <Download size={16} />
            Install Carbon
          </button>
        </>
      )}

      <p className="mt-3 text-sm text-text-muted">Prefer a native build? Get Carbon from:</p>
      <div className="mt-2 space-y-1.5">
        <div>
          <DocLink href={LINKS.playStore}>Google Play Store</DocLink>
        </div>
        <div>
          <DocLink href={LINKS.website}>Carbon website</DocLink>
        </div>
        <div>
          <DocLink href={LINKS.github}>GitHub</DocLink>
        </div>
      </div>
    </SettingsSection>
  );
}
