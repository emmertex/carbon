import { Share2, Sparkles, RefreshCw, ArrowRight } from "lucide-react";
import { useStore } from "@/lib/store";

const EXTRAS: { icon: typeof Share2; text: string }[] = [
  { icon: Share2, text: "Sharing lists with other people" },
  { icon: Sparkles, text: "Natural-language / LLM integration" },
  { icon: RefreshCw, text: "Sync between all your devices" },
];

/**
 * Second onboarding step, shown once the complexity picker is answered: introduces
 * what a sync server adds on top of the standalone offline app. "Welcome" dismisses
 * it for good (the flag syncs, so it won't reappear on other devices).
 */
export function SyncIntro() {
  const ready = useStore((s) => s.ready);
  const hydrated = useStore((s) => s.settingsHydrated);
  const chosen = useStore((s) => s.uiPrefs.complexityChosen);
  const welcomed = useStore((s) => s.uiPrefs.welcomed);
  const setUiPrefs = useStore((s) => s.setUiPrefs);

  // Only after the complexity picker (chosen) and never before it.
  if (!ready || !hydrated || !chosen || welcomed) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-xl">
        <h2 className="text-xl font-semibold tracking-tight">Carbon is better connected</h2>
        <p className="mt-2 text-sm text-text-muted">
          Carbon is a standalone, offline-only app — and yours to keep that way. But with a
          <span className="font-medium text-text"> Sync Server</span> it does even more. Host
          your own, or subscribe to{" "}
          <span className="font-medium text-text">carbon.etx.sx</span> in Settings.
        </p>

        <div className="mt-4 space-y-2.5">
          {EXTRAS.map(({ icon: Icon, text }) => (
            <div key={text} className="flex items-center gap-2.5 text-sm">
              <Icon size={16} className="shrink-0 text-accent" />
              <span>{text}</span>
            </div>
          ))}
          <a
            href="/features"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline"
          >
            Much more — see what a server adds
            <ArrowRight size={14} />
          </a>
        </div>

        <p className="mt-4 rounded-lg bg-surface-2 px-3 py-2 text-xs text-text-muted">
          Hosted subscriptions include up to <span className="font-medium text-text">6 users
          per workspace</span>. Self-hosting is unlimited.
        </p>

        <button
          onClick={() => setUiPrefs({ welcomed: true })}
          className="mt-5 w-full rounded-xl bg-accent px-5 py-3 text-sm font-medium text-accent-fg hover:bg-accent-hover"
        >
          Welcome
        </button>
      </div>
    </div>
  );
}
