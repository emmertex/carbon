import { useEffect, useState } from "react";
import { Sparkles, XCircle } from "lucide-react";
import type { Item } from "@carbon/core";
import { fetchOpenNotices, actOnNotice, type SystemNotice } from "@/lib/notices";
import { syncNow } from "@/lib/sync";
import { cn } from "@/lib/cn";

/**
 * The one renderer keyed on `sys_kind`. When an item is a Carbon-authored system
 * notice (federation offer, billing issue, invoice, …), it renders a distinct
 * "from Carbon" card: a system badge, the read-only title/body, and the action
 * button(s) for its kind.
 *
 * Phase 0 registers only the generic dismiss capability (any kind can be resolved
 * by the user). The `switch (item.sys_kind)` is the seam where Phase 2 adds a
 * `federation_offer` → Approve/Decline branch.
 */
export function SystemNoticeCard({ item }: { item: Item }) {
  const [notice, setNotice] = useState<SystemNotice | null>(null);
  const [busy, setBusy] = useState(false);

  // Resolve the item to its server-side notice row (the actionable truth). The
  // item carries only the marker; the notice id lives server-side.
  useEffect(() => {
    let live = true;
    void fetchOpenNotices().then((list) => {
      if (live) setNotice(list.find((n) => n.item_id === item.id) ?? null);
    });
    return () => {
      live = false;
    };
  }, [item.id]);

  async function act(action: "accept" | "decline" | "dismiss") {
    if (!notice || busy) return;
    setBusy(true);
    try {
      await actOnNotice(notice.id, action);
      // The server tombstones the item (marks it done); pull it so it leaves the Inbox.
      await syncNow();
    } catch {
      setBusy(false);
    }
  }

  if (!item.sys_kind) return null;

  const offer = item.sys_kind === "federation_offer" ? offerDetail(notice) : null;
  // A `federation_declined` notice is purely informational (the offer we sent was
  // turned down): a distinct icon/label, the title/body, and the generic Dismiss.
  const declined = item.sys_kind === "federation_declined";

  return (
    <div className="rounded-lg border border-accent/40 bg-accent-soft p-3">
      <div className="flex items-center gap-1.5 text-xs font-medium text-accent">
        {declined ? <XCircle size={13} /> : <Sparkles size={13} />}
        <span>{declined ? "Share declined" : "from Carbon"}</span>
      </div>
      <div className="mt-2 text-sm font-medium text-text">{item.title || "Untitled"}</div>
      {item.note && (
        <div className="mt-1 whitespace-pre-wrap text-sm text-text-muted">{item.note}</div>
      )}
      {offer && (
        <div className="mt-2 flex flex-wrap gap-1.5 text-xs text-text-muted">
          {offer.from && (
            <span className="rounded bg-surface-2 px-1.5 py-0.5">From {offer.from}</span>
          )}
          {offer.root_label && (
            <span className="rounded bg-surface-2 px-1.5 py-0.5">{offer.root_label}</span>
          )}
          {offer.permission && (
            <span className="rounded bg-surface-2 px-1.5 py-0.5">
              {offer.permission === "write" ? "Can edit" : "Can view"}
            </span>
          )}
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {renderActions(item.sys_kind, act, busy)}
      </div>
    </div>
  );
}

/** The offer detail carried in a `federation_offer` notice's payload (who + what +
 *  permission), so the Inbox card can show it without a second round-trip. */
function offerDetail(
  notice: SystemNotice | null,
): { from?: string; root_label?: string; permission?: string } | null {
  if (!notice?.payload_json) return null;
  try {
    const parsed = JSON.parse(notice.payload_json) as { actions?: Record<string, unknown> };
    const a = parsed.actions ?? {};
    return {
      from: typeof a.from === "string" ? a.from : undefined,
      root_label: typeof a.root_label === "string" ? a.root_label : undefined,
      permission: typeof a.permission === "string" ? a.permission : undefined,
    };
  } catch {
    return null;
  }
}

/** Kind-specific action buttons. A `federation_offer` gets Approve/Decline (Gate 3);
 *  every other kind gets a generic Dismiss. */
function renderActions(
  kind: string,
  act: (action: "accept" | "decline" | "dismiss") => void,
  busy: boolean,
) {
  const dismissBtn = (
    <button
      type="button"
      disabled={busy}
      onClick={() => act("dismiss")}
      className={cn(
        "rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text",
        "hover:bg-surface-2 disabled:opacity-50",
      )}
    >
      Dismiss
    </button>
  );

  switch (kind) {
    case "federation_offer":
      return (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => act("accept")}
            className={cn(
              "rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg",
              "hover:bg-accent-hover disabled:opacity-50",
            )}
          >
            Approve
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => act("decline")}
            className={cn(
              "rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text",
              "hover:bg-surface-2 disabled:opacity-50",
            )}
          >
            Decline
          </button>
        </>
      );
    default:
      return dismissBtn;
  }
}
