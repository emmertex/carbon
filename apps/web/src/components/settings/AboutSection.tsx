import { useEffect, useState } from 'react';
import { LINKS } from '@/lib/links';
import { isCapacitor, isTauri } from '@/lib/platform';
import { useStore } from '@/lib/store';
import { checkForUpdate, type UpdateInfo } from '@/lib/updateCheck';
import { checkTauriUpdate, type TauriUpdate } from '@/lib/tauriUpdater';
import { SettingsSection } from './SettingsSection';
import { DocLink, btnSecondary } from './controls';

export function AboutSection() {
  const serverVersion = useStore((s) => s.serverVersion);
  const [androidUpdate, setAndroidUpdate] = useState<UpdateInfo | null>(null);
  const [tauriUpdate, setTauriUpdate] = useState<TauriUpdate | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  useEffect(() => {
    if (isCapacitor) checkForUpdate(__APP_VERSION__).then(setAndroidUpdate);
    if (isTauri) checkTauriUpdate().then(setTauriUpdate);
  }, []);

  async function installTauriUpdate() {
    if (!tauriUpdate) return;
    setInstalling(true);
    setInstallError(null);
    try {
      await tauriUpdate.install();
      // install() relaunches the app on success — nothing left to do here.
    } catch {
      setInstallError('Update failed to install. Try again later.');
      setInstalling(false);
    }
  }

  return (
    <SettingsSection id="about" title="About">
      <p className="text-sm text-text-muted">
        App version: {__APP_VERSION__}{' '}
        <span className="font-mono text-text-faint">({__GIT_HASH__})</span>
      </p>
      <p className="mt-1 text-sm text-text-muted">Server version: {serverVersion ?? '—'}</p>
      {androidUpdate && (
        <p className="mt-1 text-sm text-accent">
          <DocLink href={androidUpdate.url}>Update available: v{androidUpdate.version}</DocLink>
        </p>
      )}
      {tauriUpdate && (
        <div className="mt-2">
          <button onClick={installTauriUpdate} disabled={installing} className={btnSecondary}>
            {installing
              ? 'Installing…'
              : `Update to v${tauriUpdate.version} and restart`}
          </button>
          {installError && <p className="mt-1 text-sm text-danger">{installError}</p>}
        </div>
      )}
      <div className="mt-3 space-y-1.5">
        <div>
          <DocLink href={LINKS.docs}>Carbon documentation</DocLink>
        </div>
        <div>
          <DocLink href={LINKS.openSource}>Thanks to the following OSS Projects</DocLink>
        </div>
      </div>
      <p className="mt-4 text-sm text-text-muted">
        <a
          href={LINKS.emmertex}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline"
        >
          Emmertex P/L
        </a>
      </p>
    </SettingsSection>
  );
}
