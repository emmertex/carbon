import { SettingsSection } from './settings/SettingsSection';
import { BillingPanel } from './BillingPanel';

/** Workspace admin: subscription status + manage (subscribe / renew / cancel). */
export function Subscription() {
  return (
    <SettingsSection id="subscription" title="Subscription">
      <BillingPanel />
    </SettingsSection>
  );
}
