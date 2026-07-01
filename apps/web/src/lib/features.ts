// UI complexity: which optional feature surfaces are visible. The goal is a simple,
// welcoming app by default with power features opt-in. A first-run picker chooses a
// preset (Simple / Standard / Advanced); Settings → Features lets a user fine-tune
// individual surfaces, optionally differing between desktop and mobile.

export type FeatureId =
  | "viewControls" // the Filter & Sort bar on list views
  | "showBar" // the "Show" row (per-row icon toggles + grouping) above lists
  | "gtdTools" // GTD extras: advanced filters, defer dates, dependencies
  | "nearby" // location alerts / the Nearby view + nav item
  | "forecast" // the Forecast (calendar) view + nav item
  | "review" // the project Review view + nav item
  | "timeTracking" // the Time tracked view + nav item
  | "perspectives" // saved views (sidebar section + "Save view")
  | "tags" // the Tags section in the sidebar
  | "nlCommands"; // the natural-language assistant in the add box

export type Complexity = "simple" | "standard" | "advanced" | "custom";
export type Preset = Exclude<Complexity, "custom">;

export interface FeatureToggle {
  desktop: boolean;
  mobile: boolean;
}
export type FeaturePrefs = Record<FeatureId, FeatureToggle>;

interface FeatureDef {
  id: FeatureId;
  label: string;
  hint: string;
  /** Sidebar grouping in the settings panel. */
  category: "Navigation" | "Filtering" | "Power tools";
  presets: Record<Preset, boolean>;
}

/** The single source of truth for feature surfaces and their per-preset defaults. */
export const FEATURES: FeatureDef[] = [
  {
    id: "viewControls",
    label: "Filter & sort bar",
    hint: "The filter chips and sort dropdown above task lists.",
    category: "Filtering",
    presets: { simple: false, standard: true, advanced: true },
  },
  {
    id: "showBar",
    label: "Show bar",
    hint: 'The "Show" row of per-row icon toggles (and grouping) above lists.',
    category: "Navigation",
    presets: { simple: false, standard: true, advanced: true },
  },
  {
    id: "gtdTools",
    label: "GTD Tools",
    hint: "Advanced filters, defer dates and task dependencies.",
    category: "Power tools",
    presets: { simple: false, standard: true, advanced: true },
  },
  {
    id: "nearby",
    label: "Location alerts (Nearby)",
    hint: "Surface tasks tied to where you are.",
    category: "Navigation",
    presets: { simple: false, standard: true, advanced: true },
  },
  {
    id: "forecast",
    label: "Forecast",
    hint: "A calendar view of upcoming due dates.",
    category: "Navigation",
    presets: { simple: false, standard: true, advanced: true },
  },
  {
    id: "review",
    label: "Review",
    hint: "Periodic project review (GTD-style).",
    category: "Navigation",
    presets: { simple: false, standard: true, advanced: true },
  },
  {
    id: "timeTracking",
    label: "Time tracking",
    hint: "Track time spent and review logged time.",
    category: "Power tools",
    presets: { simple: false, standard: false, advanced: true },
  },
  {
    id: "perspectives",
    label: "Saved views",
    hint: "Save filter/sort combinations as named views in the sidebar.",
    category: "Power tools",
    presets: { simple: false, standard: true, advanced: true },
  },
  {
    id: "tags",
    label: "Tags",
    hint: "The tag tree in the sidebar.",
    category: "Navigation",
    presets: { simple: true, standard: true, advanced: true },
  },
  {
    id: "nlCommands",
    label: "Assistant in add box",
    hint: "Type natural-language commands into the add box.",
    category: "Power tools",
    presets: { simple: false, standard: false, advanced: true },
  },
];

const FEATURE_BY_ID = new Map(FEATURES.map((f) => [f.id, f]));

/** The feature map a preset expands to (same value on desktop and mobile). */
export function presetFeatures(preset: Preset): FeaturePrefs {
  const out = {} as FeaturePrefs;
  for (const f of FEATURES)
    out[f.id] = { desktop: f.presets[preset], mobile: f.presets[preset] };
  return out;
}

/** Default until the user picks: Standard, not yet chosen (drives the first-run picker). */
export const DEFAULT_COMPLEXITY: Complexity = "standard";
export const DEFAULT_FEATURE_PREFS: FeaturePrefs = presetFeatures("standard");

/** Resolve whether a feature is visible. Presets are uniform across form factors;
 *  'custom' honours the per-device (desktop/mobile) override map. */
export function resolveFeature(
  prefs: { complexity: Complexity; features: FeaturePrefs },
  id: FeatureId,
  compact: boolean,
): boolean {
  if (prefs.complexity === "custom") {
    const t = prefs.features[id] ?? DEFAULT_FEATURE_PREFS[id];
    return compact ? t.mobile : t.desktop;
  }
  return FEATURE_BY_ID.get(id)?.presets[prefs.complexity] ?? true;
}
