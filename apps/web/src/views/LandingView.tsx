import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  ChevronDown,
  Mail,
  ListChecks,
  ListTree,
  Clock,
  CalendarClock,
  FileText,
  Code2,
  Gift,
  Server,
  Check,
  WifiOff,
  MonitorSmartphone,
  Sparkles,
  MapPin,
  Plug,
  SlidersHorizontal,
  LayoutGrid,
  Undo2,
  Database,
  HeartHandshake,
  type LucideIcon,
} from "lucide-react";
import { useStore } from "@/lib/store";
import {
  getServerConfig,
  saveServerConfig,
  saveCurrentUser,
} from "@/lib/config";

/** GitHub mark — lucide dropped brand icons, so it's inlined here. */
function GithubMark({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

const GITHUB_URL = "https://github.com/emmertex/carbon_dev";
const CHANGELOG_URL = `${GITHUB_URL}/blob/main/CHANGELOG.md`;
const CONTACT_EMAIL = "email@emmertex.com";

/** The positioning pillars — why Carbon exists, not an exhaustive feature list.
 *  The full inventory lives in the spotlight + grouped sections below. */
const PILLARS: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: ListChecks,
    title: "Serious GTD",
    body: "Projects, containers, perspectives, forecast and review — a full Getting-Things-Done system, not a flat to-do list.",
  },
  {
    icon: WifiOff,
    title: "Offline first",
    body: "The whole database lives on your device and every edit applies locally first. A sync server only moves data between devices — you always have full access, online or not.",
  },
  {
    icon: MonitorSmartphone,
    title: "Every platform",
    body: "A PWA at heart, wrapped natively for Linux, Windows and Android — with macOS and iOS on the way. Web or app, it's always the exact same Carbon.",
  },
  {
    icon: Code2,
    title: "Open source",
    body: "The whole app is open and inspectable. No lock-in, no black box, no paywalled features — fork it, audit it, improve it, trust it.",
  },
  {
    icon: Server,
    title: "Free, sync your way",
    body: "Use Carbon locally free, forever. Self-host the open-source server at no cost, or use our shared host — a small contribution toward running it, not a premium subscription.",
  },
];

/** Flagship capabilities, each rendered as an alternating image + copy block so the
 *  page reads as a story rather than a wall of cards. */
const SPOTLIGHTS: {
  icon: LucideIcon;
  title: string;
  body: string;
  points: string[];
  shot: string;
}[] = [
  {
    icon: ListTree,
    title: "A structure that scales from a list to a system",
    body: "Projects, tasks and folders — and any item can become a container, nested as deep as you like. Sequential, parallel and single-action lists drive a true next-action model.",
    points: [
      "Sequential / parallel / single-action containers",
      "Task dependencies gate what becomes available next",
      "Focus mode to drill into any branch with a breadcrumb",
      "Active / done / dropped states, plus tag-driven on-hold",
    ],
    shot: "/shots/outline.png",
  },
  {
    icon: Clock,
    title: "Plan real days, backed by real time",
    body: "Estimate tasks, set a daily time budget, and let the Plan view keep you honest. Built-in time tracking records where the hours actually go — then lets you fix them: merge accidental restarts, split gaps, drag segments, pin time notes, and optionally attach a GPS track.",
    points: [
      "Daily planner with a startup + per-task budget",
      "Per-user sessions, segments, pauses and time notes",
      "Merge, split and edit blocks after the fact",
      "Optional GPS tracks while a timer runs (background on Android)",
    ],
    shot: "/shots/time.png",
  },
  {
    icon: CalendarClock,
    title: "Scheduling with recurrence that thinks",
    body: "Every task carries separate due, defer/start and reminder times. Recurrence handles ordinal and complex patterns — weekly by weekday, monthly by day — plus completion-relative repeats that reschedule from when you actually finish.",
    points: [
      "Distinct due, defer-until and reminder times",
      "Complex and completion-relative recurrence",
      "Forecast agenda ribbon + month-grid picker",
      "Local reminders that work with no server at all",
    ],
    shot: "/shots/forecast.png",
  },
  {
    icon: Sparkles,
    title: "Capture in plain language",
    body: 'Type "remind me to grab milk at Coles tomorrow" and your own LLM agent adds, tags, schedules and files it for you. Complete, delete, rename, list and due queries work the same way — in the quick-add bar, over the agent API, or from a Telegram bot.',
    points: [
      "Natural-language: add, complete, delete, rename, tag, schedule, share",
      "Whole-list / whole-tag ops and “what's due tomorrow?” queries",
      "Telegram bot with per-user account linking",
      "Basic LLM included on hosted (fair-use), or bring your own key anytime",
    ],
    shot: "/shots/assistant.png",
  },
  {
    icon: MapPin,
    title: "Reminders that know where you are",
    body: 'Every signed-in device offers its own location as a toggleable source. "Nearest Coles"-style reminders geofence to the closest match with no coordinates to look up, and Home Assistant zones plug straight in.',
    points: [
      "Per-device GPS sources you switch on and off",
      "Nearest-place geofencing without coordinates",
      "Background geofencing on the native apps",
      "First-class, two-way Home Assistant integration",
    ],
    shot: "/shots/nearby.png",
  },
  {
    icon: FileText,
    title: "First-class notes, notebooks and recipes",
    body: "Notes are their own item type — nest them like tasks, convert either way without losing data, and edit with a rich Markdown editor. Flip a project to Notes for a notebook, or a note to Recipe for scaled servings. Tasks still carry GFM notes too, plus threaded comments with @mentions and attachments.",
    points: [
      "Notes projects, card-style note rows and list thumbnails",
      "Recipe mode with servings scale, Optimise (sync server) and a copy-able import prompt",
      "Convert task ↔ note without losing data; zip export of all notes",
      "Comment threads with @mentions and file attachments",
    ],
    shot: "/shots/detail.png",
  },
];

/** Compact grouped grids for the remaining feature surface — no images, just an
 *  honest inventory so nothing important is hidden. */
const GROUPS: { icon: LucideIcon; title: string; items: string[] }[] = [
  {
    icon: SlidersHorizontal,
    title: "Organize & filter",
    items: [
      "Colored, nestable tags synced family-wide",
      "Basic filters: completed, flagged, deferred, blocked, on-hold, tags, priority, due",
      "Advanced nested AND / OR / NOT filter builder",
      "Natural-language → filter via an LLM agent",
      "Four priority levels and flags",
      "Sort by manual order, due, priority, title or newest",
      "Saved perspectives in the sidebar",
    ],
  },
  {
    icon: LayoutGrid,
    title: "Views for every angle",
    items: [
      "Today, Inbox, Flagged, All",
      "Forecast — agenda + month grid",
      "Plan — daily planner with a time budget",
      "Review — per-project intervals",
      "Time — list, timeline or chart",
      "Tags — browse by context",
      "Nearby — location-based tasks",
      "Recently Deleted — recover tombstoned items",
    ],
  },
  {
    icon: Database,
    title: "Sync, data & durability",
    items: [
      "A real SQLite database running offline, right in your browser",
      "Conflict-free sync that merges edits from every device, field by field",
      "Debounced saves + immediate flush on tab close",
      "Full export / import, including attachment blobs",
      "Blob cache policy: On Load / Thumbnails / All per device",
      "Settings & view sync across your devices",
      "Reset local data, merge/replace on sign-in, erase on sign-out",
      "Purge old completed tasks; copy any subtree as Markdown",
      "Mandatory sync 2FA (email and/or authenticator) with trusted devices",
    ],
  },
  {
    icon: Plug,
    title: "Integrations & API",
    items: [
      "Full REST API with scoped tokens",
      "Agent API for external bots",
      "Outbound webhooks",
      "CalDAV sync — tasks and calendar events — per project",
      "Home Assistant capture, geofencing & two-way flows",
    ],
  },
  {
    icon: Undo2,
    title: "Editing & capture",
    items: [
      "Multi-level undo / redo (Ctrl+Z / Ctrl+Shift+Z)",
      "Recently Deleted — restore a task or whole cascade for 30 days",
      "Inline rapid entry — Enter creates the next task",
      "Quick-add tokens: #tag @user !priority",
      "Desktop global-hotkey + tray quick-add",
    ],
  },
  {
    icon: Gift,
    title: "Make it yours",
    items: [
      "Simple / Standard / Advanced presets, or fully custom",
      "Show or hide features per device",
      "Themes: Light, Dark, ePaper, Gruvbox, Ayu, Nord, Catppuccin",
      "Light & dark modes with accent colors",
      "Swipe and pane gestures on mobile",
    ],
  },
];

const SHOTS: { src: string; label: string }[] = [
  { src: "/shots/list.png", label: "Today & lists" },
  { src: "/shots/forecast.png", label: "Forecast" },
  { src: "/shots/time.png", label: "Time tracking" },
];

/** A screenshot that falls back to a styled placeholder frame until a real image is
 *  dropped into /public/shots. Lets the page ship before the captures exist. */
function Shot({
  src,
  label,
  className = "",
}: {
  src: string;
  label: string;
  className?: string;
}) {
  const [ok, setOk] = useState(true);
  return (
    <figure
      className={
        "overflow-hidden rounded-xl border border-border bg-surface shadow-sm " +
        className
      }
    >
      {ok ? (
        <img
          src={src}
          alt={label}
          loading="lazy"
          onError={() => setOk(false)}
          className="aspect-[4/3] w-full object-cover object-top"
        />
      ) : (
        <div className="flex aspect-[4/3] w-full items-center justify-center bg-surface-2 text-sm text-text-faint">
          {label} screenshot
        </div>
      )}
      <figcaption className="border-t border-border px-3 py-2 text-center text-xs text-text-muted">
        {label}
      </figcaption>
    </figure>
  );
}

/** One flagship capability: copy on one side, a hero screenshot on the other,
 *  alternating sides down the page. */
function Spotlight({
  icon: Icon,
  title,
  body,
  points,
  shot,
  flip,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  points: string[];
  shot: string;
  flip: boolean;
}) {
  return (
    <div className="grid items-center gap-8 lg:grid-cols-2">
      <div className={flip ? "lg:order-2" : ""}>
        <Icon className="mb-3 text-accent" size={24} />
        <h3 className="text-xl font-semibold sm:text-2xl">{title}</h3>
        <p className="mt-3 text-text-muted">{body}</p>
        <ul className="mt-4 space-y-2 text-sm">
          {points.map((p) => (
            <li key={p} className="flex items-start gap-2">
              <Check size={16} className="mt-0.5 shrink-0 text-green-500" />
              <span>{p}</span>
            </li>
          ))}
        </ul>
      </div>
      <Shot src={shot} label={title} className={flip ? "lg:order-1" : ""} />
    </div>
  );
}

/** How many bullets a grouped card shows before collapsing behind "Show all". */
const GROUP_PREVIEW_COUNT = 4;

/** One card in the "And a lot more" grid. Long lists collapse to the first few
 *  bullets with a toggle, so the section stays scannable. */
function GroupCard({
  icon: Icon,
  title,
  items,
}: {
  icon: LucideIcon;
  title: string;
  items: string[];
}) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = items.length > GROUP_PREVIEW_COUNT + 1;
  const visible =
    collapsible && !expanded ? items.slice(0, GROUP_PREVIEW_COUNT) : items;
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="text-accent" size={20} />
        <h3 className="font-semibold">{title}</h3>
      </div>
      <ul className="space-y-1.5 text-sm text-text-muted">
        {visible.map((it) => (
          <li key={it} className="flex items-start gap-2">
            <Check size={14} className="mt-1 shrink-0 text-green-500" />
            <span>{it}</span>
          </li>
        ))}
      </ul>
      {collapsible && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-3 flex items-center gap-1 text-xs font-medium text-accent hover:underline"
        >
          {expanded ? "Show less" : `Show all ${items.length}`}
          <ChevronDown
            size={14}
            className={expanded ? "rotate-180 transition-transform" : "transition-transform"}
          />
        </button>
      )}
    </div>
  );
}

const PLANS = [
  { label: "3 months", price: "$7.50", perMonth: "$2.50 / month" },
  {
    label: "1 year",
    price: "$20",
    perMonth: "$1.67 / month",
    highlight: true,
    badge: "Best value",
  },
];

/**
 * Apex landing page (e.g. carbon.etx.sx). Markets the app, then offers three ways in:
 * create a workspace, use Carbon locally with no account, or jump to an existing
 * workspace's subdomain to sign in there.
 */
export function LandingView() {
  const navigate = useNavigate();
  const baseDomain = useStore((s) => s.baseDomain);
  const appHost = useStore((s) => s.appHost);
  const setLocalOnly = useStore((s) => s.setLocalOnly);
  const [workspace, setWorkspace] = useState("");
  const [shotIdx, setShotIdx] = useState(0);

  function useLocally() {
    // Prefer the dedicated offline host so local data lives on a stable origin
    // (per-origin IndexedDB) rather than the apex. Fall back to local-only here.
    if (appHost && baseDomain) {
      window.location.href = `https://${appHost}.${baseDomain}`;
      return;
    }
    saveServerConfig({
      ...getServerConfig(),
      url: "",
      username: "",
      password: "",
      token: "",
    });
    saveCurrentUser(null);
    useStore.getState().setCurrentUser(null);
    useStore.getState().setAuthRequired(false);
    setLocalOnly(true);
    navigate("/today");
  }

  function goToWorkspace(e: React.FormEvent) {
    e.preventDefault();
    const sub = workspace.trim().toLowerCase();
    if (!sub || !baseDomain) return;
    // Accept either "name" or a full "name.carbon.etx.sx".
    const label = sub.endsWith(`.${baseDomain}`)
      ? sub.slice(0, -(baseDomain.length + 1))
      : sub;
    window.location.href = `https://${label}.${baseDomain}`;
  }

  return (
    <div>
      {/* Sticky nav — keeps orientation and a conversion path on a long page. */}
      <nav className="sticky top-0 z-20 border-b border-border bg-surface/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-4 px-6 py-3">
          <a href="#top" className="flex items-center gap-2 font-semibold">
            <img src="/icon-192.png" alt="" className="h-6 w-6 rounded" />
            Carbon
          </a>
          <div className="ml-auto flex items-center gap-4 text-sm text-text-muted">
            <a href="#features" className="hidden hover:text-text sm:block">
              Features
            </a>
            <a href="#demo" className="hidden hover:text-text sm:block">
              Demo
            </a>
            <a href="#pricing" className="hover:text-text">
              Pricing
            </a>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 hover:text-text"
            >
              <GithubMark size={16} />
              <span className="hidden sm:inline">GitHub</span>
            </a>
            <button
              onClick={() => navigate("/signup")}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white"
            >
              Create a workspace
            </button>
          </div>
        </div>
      </nav>

      <div id="top" className="mx-auto max-w-5xl px-6 py-12 sm:py-16">
      {/* Hero */}
      <header className="mx-auto max-w-2xl text-center">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          Get seriously organized.
          <br />
          Own every byte.
        </h1>
        <p className="mt-4 text-lg text-text-muted">
          Carbon 1.0 is a free, open-source task manager built on Getting Things
          Done. It works fully offline on every platform — syncing is optional,
          and always on your terms.
        </p>
        <p className="mt-3 text-sm text-text-muted">
          For GTD practitioners, and anyone outgrowing a flat to-do list or
          leaving Things, OmniFocus or Todoist.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <button
            onClick={() => navigate("/signup")}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-medium text-white sm:w-auto"
          >
            Create a workspace
            <ArrowRight size={16} />
          </button>
          <button
            onClick={useLocally}
            className="w-full rounded-xl border border-border px-5 py-3 text-sm font-medium hover:bg-surface-2 sm:w-auto"
          >
            Use without signing in
          </button>
        </div>
        <p className="mt-4 text-sm text-text-muted">
          <button
            onClick={() => navigate("/features")}
            className="underline underline-offset-4 hover:text-text"
          >
            See what works with and without a sync server
          </button>
        </p>
      </header>

      {/* Positioning pillars */}
      <section
        id="features"
        className="mt-16 grid scroll-mt-20 gap-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        {PILLARS.map(({ icon: Icon, title, body }) => (
          <div
            key={title}
            className="rounded-xl border border-border bg-surface p-5"
          >
            <Icon className="mb-3 text-accent" size={22} />
            <h3 className="mb-1 font-semibold">{title}</h3>
            <p className="text-sm text-text-muted">{body}</p>
          </div>
        ))}
      </section>

      {/* Flagship capabilities — alternating image + copy */}
      <section className="mt-20">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-2xl font-semibold sm:text-3xl">
            Everything you need, nothing you don't
          </h2>
          <p className="mt-3 text-text-muted">
            Carbon starts simple and unfolds into a genuine power tool. Here's
            what's inside.
          </p>
        </div>
        <div className="mt-12 space-y-16">
          {SPOTLIGHTS.map((s, i) => (
            <Spotlight key={s.title} {...s} flip={i % 2 === 1} />
          ))}
        </div>
      </section>

      {/* Grouped feature inventory */}
      <section className="mt-20">
        <h2 className="text-center text-2xl font-semibold sm:text-3xl">
          And a lot more
        </h2>
        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {GROUPS.map((g) => (
            <GroupCard key={g.title} {...g} />
          ))}
        </div>
      </section>

      {/* Screenshots — a tabbed preview so each view gets a full-width look. */}
      <section id="demo" className="mt-20 scroll-mt-20">
        <h2 className="mb-8 text-center text-2xl font-semibold sm:text-3xl">
          See it in action
        </h2>
        <div className="mb-4 flex justify-center gap-2">
          {SHOTS.map((s, i) => (
            <button
              key={s.src}
              onClick={() => setShotIdx(i)}
              className={
                "rounded-full border px-4 py-1.5 text-sm font-medium " +
                (i === shotIdx
                  ? "border-accent bg-accent-soft text-text"
                  : "border-border text-text-muted hover:bg-surface-2")
              }
            >
              {s.label}
            </button>
          ))}
        </div>
        <Shot
          key={SHOTS[shotIdx].src}
          {...SHOTS[shotIdx]}
          className="mx-auto max-w-3xl"
        />
      </section>

      {/* Pricing / hosting */}
      <section id="pricing" className="mt-20 grid scroll-mt-20 gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border bg-surface p-6">
          <h3 className="font-semibold">Self-host — free</h3>
          <p className="mt-1 text-sm text-text-muted">
            Run the open-source sync server yourself and sync unlimited
            workspaces at no cost. Your data, your infrastructure.
          </p>
          <ul className="mt-4 space-y-2 text-sm">
            {[
              "Open-source sync server",
              "Unlimited workspaces",
              "Full control of your data",
              "Bring your own LLM keys for AI features",
            ].map((f) => (
              <li key={f} className="flex items-center gap-2">
                <Check size={15} className="text-green-500" /> {f}
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl border border-border bg-surface p-6">
          <h3 className="font-semibold">Hosted sync — cost recovery</h3>
          <p className="mt-1 text-sm text-text-muted">
            Don't want to run a server? Use ours. Carbon itself is free and fully
            open — nothing is paywalled. The amount below only helps cover the
            cost of keeping this shared host running (a fraction of typical task-app
            subscriptions). We're including 30 days free while we have the spare
            resources — cancel anytime and export to keep using locally.
          </p>
          <ul className="mt-4 space-y-2 text-sm">
            {[
              "Same full app as self-host — no premium tiers",
              "Managed sync across all your devices",
              "Included LLM for natural-language capture & Telegram — no API key needed",
              "Push reminders on every signed-in device",
            ].map((f) => (
              <li key={f} className="flex items-start gap-2">
                <Check size={15} className="mt-0.5 shrink-0 text-green-500" /> {f}
              </li>
            ))}
          </ul>
          <div className="mt-4 grid grid-cols-2 gap-3">
            {PLANS.map((p) => (
              <div
                key={p.label}
                className={
                  "relative rounded-lg border p-4 text-center " +
                  (p.highlight
                    ? "border-accent bg-accent-soft"
                    : "border-border")
                }
              >
                {p.badge && (
                  <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                    {p.badge}
                  </span>
                )}
                <div className="text-2xl font-bold">
                  {p.price}
                  <span className="ml-1 text-xs font-normal text-text-muted">
                    AUD
                  </span>
                </div>
                <div className="text-xs text-text-muted">{p.label}</div>
                <div className="mt-1 text-xs text-text-faint">{p.perMonth}</div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-center text-xs text-text-muted">
            Contribution toward hosting — not a product subscription. Prices in
            Australian dollars ($20 AUD is roughly US$13 or €12).
          </p>
          <button
            onClick={() => navigate("/signup")}
            className="mt-3 w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
          >
            Create a workspace
          </button>
          <p className="mt-3 text-xs text-text-faint">
            Included AI runs a basic model (currently GPT-OSS-20B, may change)
            under fair-use limits. Bring your own OpenAI, Anthropic or webhook
            key anytime for higher limits or a stronger model. AI features only
            send the model the request you typed plus the task context needed to
            act on it — and only when you use them. See the{" "}
            <button
              onClick={() => navigate("/privacy")}
              className="underline underline-offset-4 hover:text-text"
            >
              Privacy Policy
            </button>
            .
          </p>
        </div>
      </section>

      {/* Go to existing workspace */}
      <section className="mx-auto mt-20 max-w-md border-t border-border pt-8">
        <p className="mb-2 text-center text-sm font-medium">
          Already have a workspace?
        </p>
        <form onSubmit={goToWorkspace} className="flex items-stretch gap-2">
          <div className="flex min-w-0 flex-1 items-center rounded-lg border border-border bg-surface pl-3 text-sm">
            <input
              className="min-w-0 flex-1 bg-transparent py-2 outline-none"
              placeholder="your-workspace"
              value={workspace}
              onChange={(e) =>
                // Subdomain labels: lowercase letters, digits and hyphens only
                // (dots allowed so a pasted full address still works).
                setWorkspace(
                  e.target.value.toLowerCase().replace(/[^a-z0-9.-]/g, ""),
                )
              }
              autoCapitalize="none"
              spellCheck={false}
            />
            {baseDomain && (
              <span className="pr-3 text-text-muted">.{baseDomain}</span>
            )}
          </div>
          <button
            type="submit"
            disabled={!workspace.trim()}
            className="rounded-lg bg-surface-2 px-4 text-sm font-medium disabled:opacity-50"
          >
            Go
          </button>
        </form>
        <p className="mt-2 text-center text-xs text-text-muted">
          You'll sign in on your workspace's own address. Workspace names use
          lowercase letters, numbers and hyphens.
        </p>
      </section>

      {/* Call to contributors */}
      <section
        id="contributors"
        className="mx-auto mt-20 max-w-2xl scroll-mt-20 rounded-xl border border-border bg-surface p-6 sm:p-8"
      >
        <HeartHandshake className="mb-3 text-accent" size={24} />
        <h2 className="text-xl font-semibold sm:text-2xl">
          Call to contributors
        </h2>
        <p className="mt-3 text-text-muted">
          We need someone to help us build and sign macOS and iOS apps. If you
          are willing to help out, please{" "}
          <a
            href="mailto:email@emmertex.com?subject=Carbon%20macOS%20%2F%20iOS%20help"
            className="text-accent underline underline-offset-4 hover:text-text"
          >
            get in touch
          </a>
          . If enough people support, and want these platforms supported, to
          cover Apple&apos;s costs, we will do it. Donations are welcome!
        </p>
      </section>

      {/* Footer */}
      <footer className="mt-20 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 border-t border-border pt-8 text-center text-sm text-text-muted">
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 underline underline-offset-4 hover:text-text"
        >
          <GithubMark size={14} /> Source on GitHub
        </a>
        <a
          href={CHANGELOG_URL}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-4 hover:text-text"
        >
          What&apos;s new in 1.0
        </a>
        <a
          href="#contributors"
          className="underline underline-offset-4 hover:text-text"
        >
          Call to contributors
        </a>
        <a
          href={`mailto:${CONTACT_EMAIL}?subject=Carbon%20support`}
          className="inline-flex items-center gap-1.5 underline underline-offset-4 hover:text-text"
        >
          <Mail size={14} /> Contact
        </a>
        <button
          onClick={() => navigate("/privacy")}
          className="underline underline-offset-4 hover:text-text"
        >
          Privacy Policy
        </button>
      </footer>
      </div>
    </div>
  );
}
