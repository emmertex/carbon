import { LINKS } from '@/lib/links';
import { SettingsSection } from './SettingsSection';
import { DocLink } from './controls';

const DOCS: { href: string; label: string; desc: string }[] = [
  { href: LINKS.hermes, label: 'Hermes integration', desc: 'Drive Carbon from the Hermes agent gateway.' },
  { href: LINKS.agentsApi, label: 'Carbon Agents API', desc: 'Wire AI agents into tasks and the inbox.' },
  { href: LINKS.restApi, label: 'REST API', desc: 'Token-authenticated HTTP access to your data.' },
  { href: LINKS.homeAssistant, label: 'Home Assistant integration', desc: 'Location-aware reminders via HA zones.' },
];

/** Always-visible directory of integration docs (the API/Agent sections below are
 *  admin-only, so these links give everyone a path into the documentation). */
export function IntegrationsDocs() {
  return (
    <SettingsSection
      id="integration-docs"
      title="Integrations"
      description="Connect Carbon to other tools. Full setup guides:"
    >
      <ul className="space-y-2">
        {DOCS.map((d) => (
          <li key={d.href}>
            <DocLink href={d.href}>{d.label}</DocLink>
            <span className="ml-2 text-xs text-text-faint">{d.desc}</span>
          </li>
        ))}
      </ul>
    </SettingsSection>
  );
}
