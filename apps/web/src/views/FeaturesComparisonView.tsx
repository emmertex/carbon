import { useNavigate } from "react-router-dom";
import { ArrowLeft, Check, Minus } from "lucide-react";

/**
 * Honest breakdown of what works in local-only mode versus what needs a sync
 * server (self-hosted or the hosted offering). Linked from the apex landing
 * page so prospective users can see exactly where the server line falls — and
 * why, since "offline-first" should not hide which features depend on a server.
 */

type Row = {
  feature: string;
  detail: string;
  local: boolean;
  server: boolean;
  /** Why a server is needed, shown only for server-dependent rows. */
  why?: string;
};

type Group = { title: string; rows: Row[] };

const GROUPS: Group[] = [
  {
    title: "Core task management",
    rows: [
      {
        feature: "Full GTD workflow",
        detail: "Today, Inbox, Projects, focus areas, perspectives, forecast, review.",
        local: true,
        server: true,
      },
      {
        feature: "Time tracking",
        detail: "Track time against any task and project, with reports.",
        local: true,
        server: true,
      },
      {
        feature: "Tags, filtering & search",
        detail: "Organise and slice your task list however you like.",
        local: true,
        server: true,
      },
      {
        feature: "Local reminders & notifications",
        detail: "Due-date and scheduled reminders fire on the device that set them.",
        local: true,
        server: true,
      },
      {
        feature: "Desktop quick-add",
        detail: "Global hotkey and tray spotlight capture on Linux, Windows and Mac.",
        local: true,
        server: true,
      },
      {
        feature: "Full export & import",
        detail: "One-click backup of the entire database plus attachments, and merge-import.",
        local: true,
        server: true,
      },
    ],
  },
  {
    title: "Sync & multi-device",
    rows: [
      {
        feature: "Multi-device sync",
        detail: "Keep the same tasks in sync across phone, desktop and web.",
        local: false,
        server: true,
        why: "Each device keeps its own local database. A sync server is the relay that moves changes between them — without one there is nothing to sync to.",
      },
      {
        feature: "Accounts & sign-in",
        detail: "Hosted or self-hosted workspaces addressed by their own subdomain.",
        local: false,
        server: true,
        why: "Accounts, sessions and workspace addressing all live on the server. Local-only mode has no account by design — your data simply stays on the device.",
      },
      {
        feature: "Attachments across devices",
        detail: "Files you attach are available on every signed-in device.",
        local: false,
        server: true,
        why: "Local-only attachments live in that device's storage. Sharing them across devices needs the server's content-addressed, access-checked blob storage.",
      },
      {
        feature: "Push notifications across devices",
        detail: "Reminders delivered even when the app isn't open on a device.",
        local: false,
        server: true,
        why: "Cross-device push is dispatched by the server through Web Push / FCM. With no server there is nothing to send a push from.",
      },
    ],
  },
  {
    title: "Collaboration & sharing",
    rows: [
      {
        feature: "Share within a workspace",
        detail: "Share projects and items with other members of your workspace.",
        local: false,
        server: true,
        why: "Sharing is a server-side authorization decision — who can see and edit what. There are no other members to share with on a single local device.",
      },
      {
        feature: "Share across workspaces",
        detail: "Share projects between workspaces, with federation on the roadmap.",
        local: false,
        server: true,
        why: "Cross-workspace sharing connects separate server-hosted workspaces. It has no meaning without a server hosting those workspaces.",
      },
    ],
  },
  {
    title: "Automation & AI",
    rows: [
      {
        feature: "In-app natural-language capture",
        detail: 'Type "remind me to get milk at Coles" and let the agent file it.',
        local: false,
        server: true,
        why: "The language agent runs server-side so your API keys and prompts stay off the client. Without a server the in-app agent has nowhere to run.",
      },
      {
        feature: "Agent API (Telegram, Hermes, bots)",
        detail: "Add and manage tasks from external bots via scoped API tokens.",
        local: false,
        server: true,
        why: "External bots reach Carbon over the server's REST API using scoped tokens. A local-only device exposes no endpoint for them to call.",
      },
      {
        feature: "Location-aware reminders",
        detail: '"Nearest Coles"-style reminders that geofence to the closest match.',
        local: false,
        server: true,
        why: "Each device shares its location as a source the server reconciles, so a reminder can target the nearest match across devices. That cross-device location matching needs the server.",
      },
    ],
  },
];

function Cell({ on }: { on: boolean }) {
  return on ? (
    <Check size={18} className="mx-auto text-green-500" aria-label="Available" />
  ) : (
    <Minus size={18} className="mx-auto text-text-faint" aria-label="Needs sync server" />
  );
}

export function FeaturesComparisonView() {
  const navigate = useNavigate();
  const serverRows = GROUPS.flatMap((g) => g.rows).filter((r) => r.why);

  return (
    <div className="mx-auto max-w-4xl px-6 py-12 sm:py-16">
      <button
        onClick={() => navigate("/")}
        className="mb-8 inline-flex items-center gap-2 text-sm text-text-muted hover:text-text"
      >
        <ArrowLeft size={16} /> Back
      </button>

      <header className="mx-auto max-w-2xl text-center">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          With & without a sync server
        </h1>
        <p className="mt-4 text-lg text-text-muted">
          Carbon is offline-first: everything you need to manage tasks works
          locally with no account and no server. Some features connect devices,
          people or services — those need a sync server, whether you self-host it
          or use the hosted offering.
        </p>
      </header>

      {/* Comparison table */}
      <section className="mt-12 overflow-hidden rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-2 text-left">
              <th className="px-4 py-3 font-semibold">Feature</th>
              <th className="w-28 px-4 py-3 text-center font-semibold">
                Local-only
              </th>
              <th className="w-28 px-4 py-3 text-center font-semibold">
                With sync
              </th>
            </tr>
          </thead>
          <tbody>
            {GROUPS.map((group) => (
              <FragmentGroup key={group.title} group={group} />
            ))}
          </tbody>
        </table>
      </section>

      {/* Why a server is needed */}
      <section className="mt-12">
        <h2 className="text-xl font-semibold">Why these need a server</h2>
        <p className="mt-1 text-sm text-text-muted">
          A sync server only ever moves and reconciles data between devices,
          people and services. Anything that involves just one device on its own
          never needs it.
        </p>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {serverRows.map((r) => (
            <div
              key={r.feature}
              className="rounded-xl border border-border bg-surface p-5"
            >
              <h3 className="mb-1 font-semibold">{r.feature}</h3>
              <p className="text-sm text-text-muted">{r.why}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="mt-12 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <button
          onClick={() => navigate("/signup")}
          className="w-full rounded-xl bg-accent px-5 py-3 text-sm font-medium text-white sm:w-auto"
        >
          Create a workspace
        </button>
        <button
          onClick={() => navigate("/")}
          className="w-full rounded-xl border border-border px-5 py-3 text-sm font-medium hover:bg-surface-2 sm:w-auto"
        >
          Back to overview
        </button>
      </section>
    </div>
  );
}

/** A titled section header row followed by its feature rows. */
function FragmentGroup({ group }: { group: Group }) {
  return (
    <>
      <tr className="border-b border-border bg-surface">
        <td colSpan={3} className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-text-faint">
          {group.title}
        </td>
      </tr>
      {group.rows.map((r) => (
        <tr key={r.feature} className="border-b border-border last:border-0">
          <td className="px-4 py-3">
            <div className="font-medium">{r.feature}</div>
            <div className="text-xs text-text-muted">{r.detail}</div>
          </td>
          <td className="px-4 py-3">
            <Cell on={r.local} />
          </td>
          <td className="px-4 py-3">
            <Cell on={r.server} />
          </td>
        </tr>
      ))}
    </>
  );
}
