import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { getProjects } from '@carbon/core';
import { useStore } from '@/lib/store';
import { useQuery } from '@/hooks/useQuery';
import {
  fetchFederationConfig,
  fetchFederationLinks,
  setFederationPolicy as apiSetPolicy,
  addFederationPeer,
  removeFederationPeer,
  revokeFederationLink,
  sendFederationOffer,
  type FederationConfig,
  type FederationPolicy,
  type FederationLinkView,
  type FederationPeer,
  type PeerListType,
} from '@/lib/federation';
import { SettingsSection } from './SettingsSection';
import { Card, Field, inputCls, btnPrimary, btnSecondary, btnIcon, ErrorText } from './controls';
import { useSavedFlash } from './useSavedFlash';
import { cn } from '@/lib/cn';

const POLICY_LABELS: Record<FederationPolicy, { label: string; help: string }> = {
  workspace_only: {
    label: 'Workspace only',
    help: 'No federation. This workspace neither sends nor accepts sharing offers.',
  },
  admin_whitelist: {
    label: 'Admin-approved (Allow List)',
    help: 'Offers are allowed only to and from peers on the Allow List below. Peers on the Deny List are always blocked.',
  },
  user_open: {
    label: 'User-approved (Open)',
    help: 'Any member may send an offer to any address they know, and receive offers from anyone — except peers on the Deny List, which are always blocked.',
  },
};

/** Plain-language line describing the effective host ceiling (Gate 1, read-only). */
function ceilingLine(ceiling: FederationConfig['ceiling']): string {
  switch (ceiling) {
    case 'off':
      return 'Federation is disabled by the server host. No sharing across workspaces is possible.';
    case 'intra_server':
      return 'Cross-server (external) sharing is disabled by the server host. You can only federate with other workspaces on this same server.';
    case 'cross_server':
      return 'The server host permits sharing with workspaces on other Carbon servers.';
  }
}

/**
 * Settings → Federation. Surfaces the backend: the effective host ceiling (read-only),
 * the workspace policy (Gate 2; admin-editable, member read-only), the admin Allow List
 * (under `admin_whitelist`) and Deny List (under BOTH `admin_whitelist` and `user_open`
 * — deny always wins), a send-offer form, and the links list with an admin Revoke. All
 * admin controls gate on the current user's role; the server independently enforces
 * every gate (the UI is a convenience, not the guard).
 */
export function FederationSection() {
  const currentUser = useStore((s) => s.currentUser);
  const isAdmin = currentUser?.role === 'admin';

  const [config, setConfig] = useState<FederationConfig | null>(null);
  const [links, setLinks] = useState<FederationLinkView[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function reload() {
    try {
      const [cfg, ln] = await Promise.all([fetchFederationConfig(), fetchFederationLinks()]);
      setConfig(cfg);
      setLinks(ln.links);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <SettingsSection
      id="federation"
      testId="settings-federation"
      title="Federation"
      description="Share projects with users in other Carbon workspaces. What's shared is a full read/write subtree — share only what you'd hand the peer's operator."
    >
      {loadError && !config ? (
        <Card className="p-3">
          <ErrorText>Couldn't load federation settings: {loadError}</ErrorText>
        </Card>
      ) : !config ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : (
        <div className="space-y-6">
          <CeilingCard ceiling={config.ceiling} />
          <PolicyCard config={config} isAdmin={isAdmin} onChanged={reload} />
          {/* Allow List: gates who members may reach — only meaningful under
              admin_whitelist. Deny List: always-blocked, so it's shown under BOTH
              federating policies (open + admin), but not under workspace_only. */}
          {config.policy === 'admin_whitelist' && (
            <PeersCard
              listType="allow"
              peers={config.allow}
              isAdmin={isAdmin}
              onChanged={reload}
            />
          )}
          {config.policy !== 'workspace_only' && (
            <PeersCard
              listType="deny"
              peers={config.deny}
              isAdmin={isAdmin}
              onChanged={reload}
            />
          )}
          <OfferCard
            config={config}
            currentUserId={currentUser?.id ?? null}
            onSent={reload}
          />
          <LinksCard links={links} isAdmin={isAdmin} onChanged={reload} />
        </div>
      )}
    </SettingsSection>
  );
}

// ----- host ceiling (read-only) ---------------------------------------------

function CeilingCard({ ceiling }: { ceiling: FederationConfig['ceiling'] }) {
  return (
    <Card
      className={cn(
        'p-3 text-sm',
        ceiling === 'off' && 'border-warning/40 bg-warning/10',
      )}
    >
      <div className="font-medium">Host policy</div>
      <p className="mt-0.5 text-text-muted">{ceilingLine(ceiling)}</p>
    </Card>
  );
}

// ----- workspace policy (Gate 2) --------------------------------------------

function PolicyCard({
  config,
  isAdmin,
  onChanged,
}: {
  config: FederationConfig;
  isAdmin: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const [saved, flash] = useSavedFlash();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const disabled = config.ceiling === 'off';

  async function pick(policy: FederationPolicy) {
    if (!isAdmin || busy || policy === config.policy) return;
    setBusy(true);
    setError(null);
    try {
      await apiSetPolicy(policy);
      await onChanged();
      flash();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-sm font-medium">Workspace sharing policy</span>
        {saved && <span className="text-xs text-accent">Saved</span>}
      </div>
      {!isAdmin && (
        <p className="mb-2 text-xs text-text-faint">Only an admin can change this policy.</p>
      )}
      <div className="space-y-1.5">
        {(Object.keys(POLICY_LABELS) as FederationPolicy[]).map((p) => {
          const active = config.policy === p;
          const meta = POLICY_LABELS[p];
          return (
            <button
              key={p}
              type="button"
              disabled={!isAdmin || busy || disabled}
              onClick={() => void pick(p)}
              className={cn(
                'block w-full rounded-lg border px-3 py-2 text-left',
                active ? 'border-accent bg-accent-soft' : 'border-border',
                isAdmin && !disabled ? 'hover:bg-surface-2' : 'cursor-default',
                (!isAdmin || disabled) && !active && 'opacity-60',
              )}
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <span
                  className={cn(
                    'inline-block h-3.5 w-3.5 rounded-full border',
                    active ? 'border-accent bg-accent' : 'border-border',
                  )}
                />
                {meta.label}
              </div>
              <div className="ml-5 mt-0.5 text-xs text-text-muted">{meta.help}</div>
            </button>
          );
        })}
      </div>
      <ErrorText className="mt-2">{error}</ErrorText>
    </div>
  );
}

// ----- admin Allow List / Deny List -----------------------------------------

/** Per-list user-facing copy. The Allow List gates who members may reach (under the
 *  admin-approved policy); the Deny List always blocks, under every policy. */
const LIST_META: Record<
  PeerListType,
  { title: string; help: string; empty: string; addLabel: string; removeTitle: string }
> = {
  allow: {
    title: 'Allow List',
    help: 'Under the admin-approved policy, offers are only allowed to and from peers on this list.',
    empty: 'No peers on the Allow List yet.',
    addLabel: 'Add to Allow List',
    removeTitle: 'Remove from Allow List',
  },
  deny: {
    title: 'Deny List',
    help: 'Peers on this list are ALWAYS blocked — no offers to or from them, even under the Open policy, and they never appear in the workspace share picker.',
    empty: 'No peers on the Deny List yet.',
    addLabel: 'Add to Deny List',
    removeTitle: 'Remove from Deny List',
  },
};

/** One admin-managed peer list (Allow or Deny). Admins can add/remove; members see it
 *  read-only. Shared by both lists so the add/remove UI lives in exactly one place. */
function PeersCard({
  listType,
  peers,
  isAdmin,
  onChanged,
}: {
  listType: PeerListType;
  peers: FederationPeer[];
  isAdmin: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const meta = LIST_META[listType];
  const [baseUrl, setBaseUrl] = useState('');
  const [subdomain, setSubdomain] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!isAdmin || busy || !baseUrl.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await addFederationPeer({
        base_url: baseUrl.trim(),
        subdomain: subdomain.trim() || undefined,
        label: label.trim() || undefined,
        listType,
      });
      setBaseUrl('');
      setSubdomain('');
      setLabel('');
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!isAdmin || busy) return;
    setBusy(true);
    setError(null);
    try {
      await removeFederationPeer(id);
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-1 text-sm font-medium">{meta.title}</div>
      <p className="mb-2 text-xs text-text-faint">{meta.help}</p>
      <Card className="divide-y divide-border">
        {peers.length === 0 && (
          <div className="px-3 py-2 text-sm text-text-muted">{meta.empty}</div>
        )}
        {peers.map((p) => (
          <div key={p.id} className="flex items-center gap-2 px-3 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{p.label || p.subdomain || p.base_url}</div>
              <div className="truncate text-xs text-text-faint">
                {p.subdomain ? `${p.subdomain} · ` : ''}
                {p.base_url}
              </div>
            </div>
            {isAdmin && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void remove(p.id)}
                className={btnIcon}
                title={meta.removeTitle}
              >
                <Trash2 size={15} />
              </button>
            )}
          </div>
        ))}
      </Card>

      {isAdmin && (
        <div className="mt-3 space-y-2">
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="Base URL / subdomain">
              <input
                className={cn(inputCls, 'w-full')}
                value={baseUrl}
                placeholder="globex"
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </Field>
            <Field label="Subdomain (optional)">
              <input
                className={cn(inputCls, 'w-full')}
                value={subdomain}
                placeholder="globex"
                onChange={(e) => setSubdomain(e.target.value)}
              />
            </Field>
            <Field label="Label (optional)">
              <input
                className={cn(inputCls, 'w-full')}
                value={label}
                placeholder="Globex Corp"
                onChange={(e) => setLabel(e.target.value)}
              />
            </Field>
          </div>
          <button
            type="button"
            disabled={busy || !baseUrl.trim()}
            onClick={() => void add()}
            className={btnSecondary}
          >
            {meta.addLabel}
          </button>
          <ErrorText>{error}</ErrorText>
        </div>
      )}
    </div>
  );
}

// ----- send an offer --------------------------------------------------------

function OfferCard({
  config,
  currentUserId,
  onSent,
}: {
  config: FederationConfig;
  currentUserId: string | null;
  onSent: () => void | Promise<void>;
}) {
  // The user's own top-level projects are the shareable roots (the server also gates
  // this via hasWriteAccess, so listing owned projects is a convenience, not a trust).
  const myProjects =
    useQuery(
      (db) =>
        getProjects(db).filter((p) => !p.deleted && (!currentUserId || p.owner_id === currentUserId)),
      [currentUserId],
    ) ?? [];

  const [to, setTo] = useState('');
  const [rootId, setRootId] = useState('');
  const [permission, setPermission] = useState<'read' | 'write'>('read');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const canSend = config.policy !== 'workspace_only' && config.ceiling !== 'off';

  async function send() {
    if (busy || !to.trim() || !rootId) return;
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      await sendFederationOffer({ to: to.trim(), root_item_id: rootId, permission });
      setOk(`Offer sent to ${to.trim()}.`);
      setTo('');
      setRootId('');
      await onSent();
    } catch (e) {
      // Surface the server's gate-rejection reason verbatim.
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-1 text-sm font-medium">Send a sharing offer</div>
      <p className="mb-2 text-xs text-text-faint">
        Address a user as <code>username@workspace</code>. They approve the offer in their
        Inbox before anything is shared.
      </p>
      {!canSend ? (
        <Card className="p-3 text-sm text-text-muted">
          Sending offers is disabled by the current host or workspace policy.
        </Card>
      ) : (
        <div className="space-y-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Recipient">
              <input
                className={cn(inputCls, 'w-full')}
                value={to}
                placeholder="bob@globex"
                onChange={(e) => setTo(e.target.value)}
              />
            </Field>
            <Field label="Project to share">
              <select
                className={cn(inputCls, 'w-full')}
                value={rootId}
                onChange={(e) => setRootId(e.target.value)}
              >
                <option value="">Select a project…</option>
                {myProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title || 'Untitled'}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Permission">
            <select
              className={cn(inputCls, 'w-full sm:w-48')}
              value={permission}
              onChange={(e) => setPermission(e.target.value === 'write' ? 'write' : 'read')}
            >
              <option value="read">Can view (read-only)</option>
              <option value="write">Can edit (read/write)</option>
            </select>
          </Field>
          <button
            type="button"
            disabled={busy || !to.trim() || !rootId}
            onClick={() => void send()}
            className={btnPrimary}
          >
            Send offer
          </button>
          {ok && <p className="text-sm text-accent">{ok}</p>}
          <ErrorText>{error}</ErrorText>
        </div>
      )}
    </div>
  );
}

// ----- links list -----------------------------------------------------------

const STATUS_STYLE: Record<FederationLinkView['status'], string> = {
  pending: 'bg-warning/15 text-warning',
  active: 'bg-accent-soft text-accent',
  revoked: 'bg-surface-2 text-text-faint',
};

function LinksCard({
  links,
  isAdmin,
  onChanged,
}: {
  links: FederationLinkView[];
  isAdmin: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function revoke(id: string) {
    if (!isAdmin || busy) return;
    setBusy(id);
    setError(null);
    try {
      await revokeFederationLink(id);
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="mb-1 text-sm font-medium">Shared links</div>
      <Card className="divide-y divide-border">
        {links.length === 0 && (
          <div className="px-3 py-2 text-sm text-text-muted">No federation links yet.</div>
        )}
        {links.map((l) => {
          const rootTitles = l.roots
            .map((r) => r.title || r.root_item_id)
            .join(', ');
          return (
            <div key={l.id} className="flex items-start gap-2 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">
                    {l.direction === 'outbound' ? 'Shared out' : 'Shared in'}
                  </span>
                  <span className="font-medium">{l.peer_label}</span>
                  <span className={cn('rounded px-1.5 py-0.5 text-xs', STATUS_STYLE[l.status])}>
                    {l.status}
                  </span>
                </div>
                {rootTitles && (
                  <div className="mt-0.5 truncate text-xs text-text-muted">{rootTitles}</div>
                )}
              </div>
              {isAdmin && l.status !== 'revoked' && (
                <button
                  type="button"
                  disabled={busy === l.id}
                  onClick={() => void revoke(l.id)}
                  className={cn(btnSecondary, 'px-2.5 py-1 text-xs')}
                >
                  Revoke
                </button>
              )}
            </div>
          );
        })}
      </Card>
      <ErrorText className="mt-2">{error}</ErrorText>
    </div>
  );
}
