import { useEffect, useState } from 'react';
import { Download, Check } from 'lucide-react';
import { canInstall, isStandalone, onInstallChange, promptInstall } from '@/lib/pwa';
import { LINKS } from '@/lib/links';
import { SettingsSection } from './settings/SettingsSection';
import { DocLink } from './settings/controls';

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
      {/* Only surface the PWA install affordance when we can actually trigger it
          via a button — no manual "open the browser menu" instructions. */}
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
      ) : null}

      <p className="mt-3 text-sm text-text-muted">
        Prefer a native build? Download the latest desktop or Android app from{' '}
        <DocLink href={LINKS.releases}>GitHub releases</DocLink>.
      </p>
    </SettingsSection>
  );
}
