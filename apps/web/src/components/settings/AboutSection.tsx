import { getDeviceId } from '@/lib/db';
import { SettingsSection } from './SettingsSection';

export function AboutSection() {
  return (
    <SettingsSection id="about" title="About">
      <p className="text-sm text-text-muted">
        Carbon {__APP_VERSION__}{' '}
        <span className="font-mono text-text-faint">({__GIT_HASH__})</span>
      </p>
      <p className="mt-1 text-xs text-text-faint">Device ID: {getDeviceId()}</p>
    </SettingsSection>
  );
}
