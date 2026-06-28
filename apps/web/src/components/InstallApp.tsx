import { useEffect, useState } from 'react';
import { Download, Check, Share } from 'lucide-react';
import { canInstall, isStandalone, isIos, onInstallChange, promptInstall } from '@/lib/pwa';
import { SettingsSection } from './settings/SettingsSection';

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

  async function install() {
    const outcome = await promptInstall();
    if (outcome === 'accepted') setInstalled(true);
  }

  return (
    <SettingsSection id="install" title="Install app">
      {installed ? (
        <p className="flex items-center gap-2 text-sm text-success">
          <Check size={16} />
          Carbon is installed on this device.
        </p>
      ) : installable ? (
        <>
          <p className="mb-3 text-sm text-text-muted">
            Add Carbon to your home screen for a full-screen, offline-ready app.
          </p>
          <button
            onClick={install}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:bg-accent-hover"
          >
            <Download size={16} />
            Install Carbon
          </button>
        </>
      ) : isIos() ? (
        <p className="flex flex-wrap items-center gap-1.5 text-sm text-text-muted">
          To install on iPhone/iPad: tap the <Share size={15} className="inline text-accent" />{' '}
          <strong>Share</strong> button in Safari, then{' '}
          <strong>Add to Home&nbsp;Screen</strong>.
        </p>
      ) : (
        <p className="text-sm text-text-muted">
          Open Carbon in Chrome, Edge, or another supporting browser, then use the browser menu
          (⋮) → <strong>Install app</strong> / <strong>Add to Home screen</strong>. Installing needs
          an <code>https://</code> address.
        </p>
      )}
    </SettingsSection>
  );
}
