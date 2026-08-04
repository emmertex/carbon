import { useStore } from '@/lib/store';
import { CONVENTIONS, type CupConvention } from '@/lib/recipe';
import { SettingsSection } from './SettingsSection';
import { SegmentedControl } from '../ui/SegmentedControl';

const CUP_CONVENTIONS: { id: CupConvention; label: string }[] = [
  { id: 'au', label: 'Australian' },
  { id: 'us', label: 'US' },
  { id: 'metric', label: 'Metric' },
];

/** e.g. "Australian — 250 mL cup, 20 mL tbsp, 5 mL tsp". Read off CONVENTIONS so the
 *  tooltip can't drift from the constants the conversion actually uses. */
function describe(id: CupConvention, label: string): string {
  const c = CONVENTIONS[id];
  return `${label} — ${c.cup} mL cup, ${c.tbsp} mL tbsp, ${c.tsp} mL tsp`;
}

export function RecipesSection() {
  const uiPrefs = useStore((s) => s.uiPrefs);
  const setUiPrefs = useStore((s) => s.setUiPrefs);

  return (
    <SettingsSection id="recipes" title="Recipes">
      <span className="mb-1 block text-sm font-medium">Cup convention</span>
      <SegmentedControl
        value={uiPrefs.cupConvention}
        onChange={(v) => setUiPrefs({ cupConvention: v })}
        options={CUP_CONVENTIONS.map((o) => ({
          value: o.id,
          label: o.label,
          title: describe(o.id, o.label),
        }))}
      />
      <p className="mt-1 text-xs text-text-faint">
        Only affects recipe notes: which cup and spoon sizes amounts are converted against.
      </p>
    </SettingsSection>
  );
}
