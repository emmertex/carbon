import { getDeviceId } from '@/lib/db';
import { LINKS } from '@/lib/links';
import { SettingsSection } from './SettingsSection';
import { DocLink } from './controls';

export function AboutSection() {
  return (
    <SettingsSection id="about" title="About">
      <p className="text-sm text-text-muted">
        Carbon {__APP_VERSION__}{' '}
        <span className="font-mono text-text-faint">({__GIT_HASH__})</span>
      </p>
      <p className="mt-1 text-xs text-text-faint">Device ID: {getDeviceId()}</p>
      <div className="mt-3">
        <DocLink href={LINKS.docs}>Carbon documentation</DocLink>
      </div>
    </SettingsSection>
  );
}
