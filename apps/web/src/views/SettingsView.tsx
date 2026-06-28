import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { getServerConfig, saveServerConfig, type ServerConfig } from '@/lib/config';
import { useStore } from '@/lib/store';
import { AdminUsers } from '@/components/AdminUsers';
import { Subscription } from '@/components/Subscription';
import { ApiTokens } from '@/components/ApiTokens';
import { Agents } from '@/components/Agents';
import { Reminders } from '@/components/Reminders';
import { HaPerson } from '@/components/HaPerson';
import { Profile } from '@/components/Profile';
import { PlanningSettings } from '@/components/PlanningSettings';
import { InstallApp } from '@/components/InstallApp';
import { DataBackup } from '@/components/DataBackup';
import { AppearanceSection } from '@/components/settings/AppearanceSection';
import { GesturesSection } from '@/components/settings/GesturesSection';
import { SyncSection } from '@/components/settings/SyncSection';
import { AboutSection } from '@/components/settings/AboutSection';
import { SettingsNav, useActiveGroup, type NavGroup } from '@/components/settings/SettingsNav';

const GROUPS: NavGroup[] = [
  { id: 'general', label: 'General' },
  { id: 'account', label: 'Account' },
  { id: 'sync', label: 'Sync' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'admin', label: 'Workspace admin' },
  { id: 'about', label: 'About' },
];

/** Gating context evaluated per render and passed to each section's `show`. */
interface SettingsCtx {
  signedIn: boolean;
  isAdmin: boolean;
  hasServer: boolean;
}

interface SectionDef {
  id: string;
  group: string;
  show: (c: SettingsCtx) => boolean;
  render: () => ReactNode;
}

export function SettingsView() {
  const [cfg, setCfg] = useState<ServerConfig>(getServerConfig());
  const currentUser = useStore((s) => s.currentUser);

  // Default the server URL to the domain Carbon is served from (if it's a Carbon
  // server), so most users never have to type it.
  useEffect(() => {
    // The dedicated offline host is intentionally serverless — never auto-attach.
    if (useStore.getState().hostRole === 'app') return;
    let active = true;
    fetch(`${window.location.origin}/api/health`)
      .then((r) => {
        if (active && r.ok && !getServerConfig().url) update({ url: window.location.origin });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  function update(patch: Partial<ServerConfig>) {
    const next = { ...cfg, ...patch };
    setCfg(next);
    saveServerConfig(next);
  }

  const ctx: SettingsCtx = {
    signedIn: !!currentUser && !currentUser.open,
    isAdmin: currentUser?.role === 'admin',
    hasServer: !!cfg.url,
  };

  // One declarative list: ordering, grouping, and visibility all live here.
  const SECTIONS: SectionDef[] = [
    { id: 'appearance', group: 'general', show: () => true, render: () => <AppearanceSection /> },
    { id: 'gestures', group: 'general', show: () => true, render: () => <GesturesSection /> },
    { id: 'install', group: 'general', show: () => true, render: () => <InstallApp /> },
    { id: 'profile', group: 'account', show: (c) => c.signedIn, render: () => <Profile /> },
    { id: 'planning', group: 'account', show: (c) => c.signedIn, render: () => <PlanningSettings /> },
    { id: 'data', group: 'account', show: () => true, render: () => <DataBackup /> },
    { id: 'sync', group: 'sync', show: () => true, render: () => <SyncSection cfg={cfg} update={update} /> },
    { id: 'reminders', group: 'notifications', show: () => true, render: () => <Reminders /> },
    { id: 'ha-person', group: 'notifications', show: (c) => c.signedIn && c.hasServer, render: () => <HaPerson /> },
    { id: 'api-tokens', group: 'integrations', show: (c) => c.isAdmin && c.hasServer, render: () => <ApiTokens /> },
    { id: 'agents', group: 'integrations', show: (c) => c.isAdmin && c.hasServer, render: () => <Agents /> },
    { id: 'users', group: 'admin', show: (c) => c.isAdmin && c.hasServer, render: () => <AdminUsers /> },
    { id: 'subscription', group: 'admin', show: (c) => c.isAdmin && c.hasServer, render: () => <Subscription /> },
    { id: 'about', group: 'about', show: () => true, render: () => <AboutSection /> },
  ];

  const visible = SECTIONS.filter((s) => s.show(ctx));
  const groups = GROUPS.filter((g) => visible.some((s) => s.group === g.id));
  const active = useActiveGroup(groups.map((g) => g.id));

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <h1 className="mb-6 text-2xl font-bold tracking-tight">Settings</h1>
      <div className="lg:grid lg:grid-cols-[9rem_1fr] lg:gap-10">
        <SettingsNav groups={groups} active={active} />
        <div className="min-w-0 space-y-10">
          {groups.map((g) => {
            const secs = visible.filter((s) => s.group === g.id);
            return (
              <div key={g.id} id={`group-${g.id}`} data-group={g.id} className="scroll-mt-6 space-y-8">
                {/* Single-section groups let the section's own heading stand in. */}
                {secs.length > 1 && (
                  <h2 className="text-lg font-semibold tracking-tight">{g.label}</h2>
                )}
                {secs.map((s) => (
                  <div key={s.id}>{s.render()}</div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
