import { useEffect, useState } from "react";
import { Globe } from "lucide-react";
import type { Permission } from "@carbon/core";
import { cn } from "@/lib/cn";
import {
  fetchFederationConfig,
  fetchFederationLinks,
  fetchPeerStatus,
  fetchDirectory,
  sendFederationOffer,
  canFederate,
  offerablePeerSubdomains,
  type FederationConfig,
  type FederationDirectoryUser,
} from "@/lib/federation";

const inputCls =
  "w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent";

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1 block text-xs font-medium text-text-muted">
      {children}
    </span>
  );
}

/** A same-host, mutually-whitelisted peer whose roster we can show. */
interface PickerPeer {
  subdomain: string;
  label: string;
  users: FederationDirectoryUser[];
}

/** A peer we already share with (from `/links`) but have no roster for — offers go
 *  out by manual `username@subdomain` address. `label` is the peer's display label. */
interface LinkPeer {
  label: string;
}

/**
 * In-dialog "Share with a workspace" affordance for the currently-open item
 * (federation root). Only renders once we've confirmed the workspace can federate
 * (`policy !== 'workspace_only'` and `ceiling !== 'off'`). Within it:
 *  - a mutually-whitelisted same-host peer shows a user picker (avatar + address);
 *  - a peer we already link with, or a raw `username@subdomain`, uses manual entry.
 * Cold peers (no link, not mutual) are intentionally not offer-able here — those live
 * in Settings → Federation. The server independently enforces every gate on submit;
 * this UI is a convenience and never the authority.
 */
export function WorkspaceShare({
  rootItemId,
  rootTitle,
}: {
  rootItemId: string;
  rootTitle: string | null;
}) {
  const [config, setConfig] = useState<FederationConfig | null>(null);
  const [pickerPeers, setPickerPeers] = useState<PickerPeer[]>([]);
  const [linkPeers, setLinkPeers] = useState<LinkPeer[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Load federation capability + offer-able peers once. `peer-status`/`directory`
  // decide which same-host peers are mutual (→ picker); `/links` supplies peers we
  // already share with (→ manual entry). Any failure just leaves the affordance in
  // manual-only mode — never a hard error in the task dialog.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let cfg: FederationConfig;
      try {
        cfg = await fetchFederationConfig();
      } catch {
        if (!cancelled) setLoaded(true);
        return;
      }
      if (cancelled) return;
      setConfig(cfg);

      // Gate the whole affordance on the workspace being able to federate at all.
      if (!canFederate(cfg)) {
        setLoaded(true);
        return;
      }

      // Candidate same-host peers come from the admin allow-list (they carry a clean
      // subdomain). For each, confirm mutual + pull the roster for the picker.
      const labelBySub = new Map(
        cfg.allow.filter((p) => p.subdomain).map((p) => [p.subdomain as string, p.label]),
      );
      const pickers: PickerPeer[] = [];
      await Promise.all(
        offerablePeerSubdomains(cfg).map(async (sub) => {
          try {
            const status = await fetchPeerStatus(sub);
            if (!status.mutual) return;
            const dir = await fetchDirectory(sub);
            if (dir.users.length > 0)
              pickers.push({
                subdomain: sub,
                label: labelBySub.get(sub) || sub,
                users: dir.users,
              });
          } catch {
            /* not mutual / not same-host / cross-server — skip this peer */
          }
        }),
      );

      // Peers we already have a link with — offer-able via manual address even
      // without a roster. De-dupe against the picker peers by label.
      let linkLabels: string[] = [];
      try {
        const { links } = await fetchFederationLinks();
        linkLabels = [...new Set(links.map((l) => l.peer_label))];
      } catch {
        /* links unavailable — manual entry still works */
      }

      if (cancelled) return;
      const pickerLabels = new Set(pickers.map((p) => p.label));
      setPickerPeers(pickers);
      setLinkPeers(
        linkLabels
          .filter((l) => !pickerLabels.has(l))
          .map((label) => ({ label })),
      );
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Hide entirely until we know the workspace can federate — avoids a dead-end.
  if (!loaded || !config || !canFederate(config)) return null;

  return (
    <div className="mt-3 border-t border-border pt-3">
      <Label>
        <span className="inline-flex items-center gap-1">
          <Globe size={12} /> Share with a workspace
        </span>
      </Label>
      <p className="mb-2 text-xs text-text-faint">
        Offer{" "}
        {rootTitle ? (
          <span className="font-medium text-text-muted">{rootTitle}</span>
        ) : (
          "this item"
        )}{" "}
        to someone in another Carbon workspace. They approve it in their Inbox
        before anything is shared.
      </p>
      <OfferForm
        rootItemId={rootItemId}
        pickerPeers={pickerPeers}
        linkPeers={linkPeers}
      />
    </div>
  );
}

function OfferForm({
  rootItemId,
  pickerPeers,
  linkPeers,
}: {
  rootItemId: string;
  pickerPeers: PickerPeer[];
  linkPeers: LinkPeer[];
}) {
  // Recipient is either a roster pick (address auto-filled) or a manual address.
  // Selecting a directory user fills `to`; the manual field is always available so a
  // raw `username@subdomain` (or a link-peer address) can be typed directly.
  const [to, setTo] = useState("");
  const [permission, setPermission] = useState<Permission>("read");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function send() {
    const addr = to.trim();
    if (busy || !addr) return;
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      await sendFederationOffer({ to: addr, root_item_id: rootItemId, permission });
      setOk(`Offer sent to ${addr} — they'll get an approval task.`);
      setTo("");
    } catch (e) {
      // Surface the server's gate-rejection reason verbatim.
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const hasPickers = pickerPeers.length > 0;

  return (
    <div className="space-y-2">
      {hasPickers &&
        pickerPeers.map((peer) => (
          <div key={peer.subdomain}>
            <Label>{peer.label}</Label>
            <div className="flex flex-wrap gap-1.5">
              {peer.users.map((u) => {
                const active = to === u.address;
                return (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => {
                      setTo(u.address);
                      setOk(null);
                      setError(null);
                    }}
                    title={u.address}
                    className={cn(
                      "flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs",
                      active
                        ? "border-accent bg-accent-soft text-accent"
                        : "border-border text-text-muted hover:bg-surface-2",
                    )}
                  >
                    <span
                      className="flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-semibold text-white"
                      style={{ background: u.avatar_color || "var(--accent)" }}
                    >
                      {(u.display_name || u.username).charAt(0).toUpperCase()}
                    </span>
                    {u.display_name || u.username}
                    <span className="text-text-faint">@{peer.subdomain}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}

      <div>
        <Label>
          {hasPickers ? "Or enter an address" : "Recipient"}
        </Label>
        <input
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            setOk(null);
            setError(null);
          }}
          placeholder="bob@globex"
          className={inputCls}
        />
        {linkPeers.length > 0 && (
          <p className="mt-1 text-xs text-text-faint">
            You already share with{" "}
            {linkPeers.map((p) => p.label).join(", ")}.
          </p>
        )}
      </div>

      <div>
        <Label>Permission</Label>
        <select
          value={permission}
          onChange={(e) =>
            setPermission(e.target.value === "write" ? "write" : "read")
          }
          className={cn(inputCls, "sm:w-48")}
        >
          <option value="read">Can view (read-only)</option>
          <option value="write">Can edit (read/write)</option>
        </select>
      </div>

      <button
        type="button"
        disabled={busy || !to.trim()}
        onClick={() => void send()}
        className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
      >
        Send offer
      </button>
      {ok && <p className="text-sm text-accent">{ok}</p>}
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
