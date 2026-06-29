import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  ListChecks,
  Timer,
  Code2,
  Gift,
  Server,
  Share2,
  Check,
  WifiOff,
  MonitorSmartphone,
  Gauge,
  Sparkles,
  Send,
  MapPin,
  Command,
} from "lucide-react";
import { useStore } from "@/lib/store";
import {
  getServerConfig,
  saveServerConfig,
  saveCurrentUser,
} from "@/lib/config";

const STRENGTHS: { icon: typeof ListChecks; title: string; body: string }[] = [
  {
    icon: ListChecks,
    title: "Serious GTD",
    body: "Projects, focus areas, perspectives, forecast, review — a full Getting-Things-Done workflow, not a flat to-do list.",
  },
  {
    icon: Timer,
    title: "Built-in time tracking",
    body: "Track time against any task and project, see where your hours actually go, and plan realistic days from real estimates.",
  },
  {
    icon: Code2,
    title: "Open source",
    body: "The whole app is open and inspectable. No lock-in, no black box — fork it, audit it, improve it, trust it.",
  },
  {
    icon: Gift,
    title: "Free to use",
    body: "Use Carbon locally for free, forever. It is offline-first: your data lives on your device and syncs only when you want.",
  },
  {
    icon: Server,
    title: "Sync your way",
    body: "Subscribe to hosted sync, or self-host the sync server yourself. Even better, host a sync server for your friends.",
  },
  {
    icon: Share2,
    title: "Share across workspaces",
    body: "Share projects between workspaces on carbon.etx.sx today, or copy any project as a Markdown checklist to paste into a chat — with federation across self-hosted servers on the roadmap.",
  },
  {
    icon: WifiOff,
    title: "Offline first",
    body: "All your data lives locally, all the time. The sync server only moves data between devices — you always have full access, online or not.",
  },
  {
    icon: MonitorSmartphone,
    title: "Every platform",
    body: "A PWA at heart, wrapped natively for Android, iOS, Linux, Windows and Mac. Web or app, it's always the exact same Carbon.",
  },
  {
    icon: Gauge,
    title: "High performance",
    body: "Every build runs 100, 1,000 and 10,000-task performance tests to keep memory and latency low. It stays snappy at any scale.",
  },
  {
    icon: Sparkles,
    title: "Natural-language commands",
    body: 'Type "remind me to get milk and eggs at Coles" and your LLM agent adds, tags, completes and files tasks for you — in-app, or from Telegram, Hermes or any bot via the agent API.',
  },
  {
    icon: Send,
    title: "Telegram bot",
    body: "Run one bot for your whole server. Link your account, then manage tasks from chat — \"what's due tomorrow in work?\", \"untick my weekly shopping items\" — answered conversationally by your own AI agent.",
  },
  {
    icon: MapPin,
    title: "Location-aware reminders",
    body: 'Each signed-in device shares its own location as a toggleable source, and "nearest Coles"-style reminders geofence themselves to the closest match — no coordinates to look up.',
  },
  {
    icon: Command,
    title: "Desktop quick-add",
    body: "A global hotkey and system-tray icon pop a spotlight capture bar from anywhere on Linux, Windows and Mac — jot a task without switching windows.",
  },
];

const SHOTS: { src: string; label: string }[] = [
  { src: "/shots/list.png", label: "Today & lists" },
  { src: "/shots/forecast.png", label: "Forecast" },
  { src: "/shots/time.png", label: "Time tracking" },
];

/** A screenshot that falls back to a styled placeholder frame until a real image is
 *  dropped into /public/shots. Lets the page ship before the captures exist. */
function Shot({ src, label }: { src: string; label: string }) {
  const [ok, setOk] = useState(true);
  return (
    <figure className="overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
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

const PLANS = [
  { label: "3 months", price: "$7.50" },
  { label: "1 year", price: "$20", highlight: true },
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
    <div className="mx-auto max-w-5xl px-6 py-12 sm:py-16">
      {/* Hero */}
      <header className="mx-auto max-w-2xl text-center">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          Carbon
        </h1>
        <p className="mt-4 text-lg text-text-muted">
          A fast, offline-first task manager with serious GTD, built-in time
          tracking, natural-language capture and location-aware reminders. Open
          source, free to use, and yours to sync or self-host.
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

      {/* Strengths */}
      <section className="mt-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {STRENGTHS.map(({ icon: Icon, title, body }) => (
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

      {/* Screenshots */}
      <section className="mt-16">
        <h2 className="mb-6 text-center text-xl font-semibold">
          See it in action
        </h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {SHOTS.map((s) => (
            <Shot key={s.src} {...s} />
          ))}
        </div>
      </section>

      {/* Pricing / hosting */}
      <section className="mt-16 grid gap-4 lg:grid-cols-2">
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
            ].map((f) => (
              <li key={f} className="flex items-center gap-2">
                <Check size={15} className="text-green-500" /> {f}
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl border border-border bg-surface p-6">
          <h3 className="font-semibold">Hosted sync</h3>
          <p className="mt-1 text-sm text-text-muted">
            Don't want to run a server? Start with a 30-day trial, then pick a
            plan. Cancel anytime — Export and use locally, you will lose
            nothing.
          </p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            {PLANS.map((p) => (
              <div
                key={p.label}
                className={
                  "rounded-lg border p-4 text-center " +
                  (p.highlight
                    ? "border-accent bg-accent-soft"
                    : "border-border")
                }
              >
                <div className="text-2xl font-bold">
                  {p.price}
                  <span className="ml-1 text-xs font-normal text-text-muted">AUD</span>
                </div>
                <div className="text-xs text-text-muted">{p.label}</div>
              </div>
            ))}
          </div>
          <button
            onClick={() => navigate("/signup")}
            className="mt-4 w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
          >
            Start free trial
          </button>
        </div>
      </section>

      {/* Go to existing workspace */}
      <section className="mx-auto mt-16 max-w-md border-t border-border pt-8">
        <p className="mb-2 text-center text-sm font-medium">
          Already have a workspace?
        </p>
        <form onSubmit={goToWorkspace} className="flex items-stretch gap-2">
          <div className="flex min-w-0 flex-1 items-center rounded-lg border border-border bg-surface pl-3 text-sm">
            <input
              className="min-w-0 flex-1 bg-transparent py-2 outline-none"
              placeholder="your-workspace"
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value.toLowerCase())}
              autoCapitalize="none"
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
          You'll sign in on your workspace's own address.
        </p>
      </section>
    </div>
  );
}
