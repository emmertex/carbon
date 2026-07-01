import { useStore } from "@/lib/store";
import type { Complexity } from "@/lib/features";

const CHOICES: {
  id: Exclude<Complexity, "custom">;
  label: string;
  blurb: string;
}[] = [
  {
    id: "simple",
    label: "Simple - Todo",
    blurb: "Minimalist interface, prioritising Todo Features only.",
  },
  {
    id: "standard",
    label: "Standard - GTD",
    blurb:
      "Adds filtering, forecast, nearby, review, and saved views for everyday planning.",
  },
  {
    id: "advanced",
    label: "Advanced - Carbon",
    blurb:
      "Everything Carbon offers, including review, time tracking, advanced filters, and LLM/NL features.",
  },
];

/** First-run modal asking how much of the UI to show. Rendered once the first sync
 *  has resolved, so a returning user whose synced choice arrives doesn't see it. */
export function ComplexityPicker() {
  const ready = useStore((s) => s.ready);
  const hydrated = useStore((s) => s.settingsHydrated);
  const chosen = useStore((s) => s.uiPrefs.complexityChosen);
  const setUiPrefs = useStore((s) => s.setUiPrefs);

  if (!ready || !hydrated || chosen) return null;

  function choose(id: Exclude<Complexity, "custom">) {
    setUiPrefs({ complexity: id, complexityChosen: true });
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-xl">
        <h2 className="text-xl font-semibold tracking-tight">
          Welcome to Carbon
        </h2>
        <p className="mt-1 text-sm text-text-muted">
          Customise your experience. You can always tweak and customise this in
          Settings&nbsp;→&nbsp;Features.
        </p>
        <div className="mt-5 space-y-2.5">
          {CHOICES.map((c) => (
            <button
              key={c.id}
              onClick={() => choose(c.id)}
              className="block w-full rounded-xl border border-border p-3.5 text-left transition-colors hover:border-accent hover:bg-accent-soft"
            >
              <div className="text-sm font-semibold">{c.label}</div>
              <div className="mt-0.5 text-xs text-text-muted">{c.blurb}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
