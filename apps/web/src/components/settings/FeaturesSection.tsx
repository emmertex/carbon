import { useStore } from '@/lib/store';
import {
  FEATURES,
  presetFeatures,
  type Complexity,
  type FeatureId,
  type FeaturePrefs,
} from '@/lib/features';
import { setSettingsSyncEnabled } from '@/lib/settings-sync';
import { SettingsSection } from './SettingsSection';
import { SettingsToggle } from './controls';
import { SegmentedControl } from '../ui/SegmentedControl';

const PRESETS: { id: Complexity; label: string; hint: string }[] = [
  { id: 'simple', label: 'Simple', hint: 'The essentials — a calm, welcoming app.' },
  { id: 'standard', label: 'Standard', hint: 'Common features for everyday planning.' },
  { id: 'advanced', label: 'Advanced', hint: 'Everything, including power tools.' },
  { id: 'custom', label: 'Custom', hint: 'Choose each feature yourself.' },
];

const CATEGORY_ORDER: FeatureToggleCategory[] = ['Navigation', 'Filtering', 'Power tools'];
type FeatureToggleCategory = (typeof FEATURES)[number]['category'];

export function FeaturesSection() {
  const uiPrefs = useStore((s) => s.uiPrefs);
  const setUiPrefs = useStore((s) => s.setUiPrefs);
  const syncEnabled = useStore((s) => s.settingsSyncEnabled);
  const { complexity } = uiPrefs;

  // The feature map currently in effect: a preset expands uniformly; custom uses
  // the saved per-device overrides.
  const effective: FeaturePrefs =
    complexity === 'custom' ? uiPrefs.features : presetFeatures(complexity);

  function choosePreset(id: Complexity) {
    if (id === 'custom') {
      // Seed the custom map from whatever is showing now, so toggles don't jump.
      setUiPrefs({ complexity: 'custom', features: effective, complexityChosen: true });
    } else {
      setUiPrefs({ complexity: id, complexityChosen: true });
    }
  }

  function setToggle(id: FeatureId, device: 'desktop' | 'mobile', value: boolean) {
    // Editing any toggle implies a custom configuration; seed from the effective map.
    const base = complexity === 'custom' ? uiPrefs.features : presetFeatures(complexity);
    const features: FeaturePrefs = {
      ...base,
      [id]: { ...base[id], [device]: value },
    };
    setUiPrefs({ complexity: 'custom', features, complexityChosen: true });
  }

  return (
    <SettingsSection id="features" title="Features & UI complexity">
      <p className="mb-3 text-sm text-text-muted">
        Choose how much of Carbon to show. Start simple and switch features on as you need them.
      </p>

      <div className="mb-2">
        <SegmentedControl
          value={complexity}
          onChange={choosePreset}
          block
          segmentClassName="px-2"
          options={PRESETS.map((p) => ({ value: p.id, label: p.label }))}
        />
      </div>
      <p className="mb-5 text-xs text-text-faint">
        {PRESETS.find((p) => p.id === complexity)?.hint}
      </p>

      <div className="space-y-5">
        {CATEGORY_ORDER.map((cat) => {
          const items = FEATURES.filter((f) => f.category === cat);
          if (!items.length) return null;
          return (
            <div key={cat}>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-semibold">{cat}</span>
                <span className="flex gap-4 text-xs text-text-faint">
                  <span className="w-16 text-center">Desktop</span>
                  <span className="w-16 text-center">Mobile</span>
                </span>
              </div>
              <div className="space-y-2.5">
                {items.map((f) => (
                  <div key={f.id} className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm">{f.label}</div>
                      <div className="text-xs text-text-faint">{f.hint}</div>
                    </div>
                    <div className="flex shrink-0 gap-4">
                      <div className="flex w-16 justify-center">
                        <input
                          type="checkbox"
                          aria-label={`${f.label} on desktop`}
                          checked={effective[f.id].desktop}
                          onChange={(e) => setToggle(f.id, 'desktop', e.target.checked)}
                        />
                      </div>
                      <div className="flex w-16 justify-center">
                        <input
                          type="checkbox"
                          aria-label={`${f.label} on mobile`}
                          checked={effective[f.id].mobile}
                          onChange={(e) => setToggle(f.id, 'mobile', e.target.checked)}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-6 border-t border-border pt-4">
        <SettingsToggle
          label="Sync views & UI settings across devices"
          checked={syncEnabled}
          onChange={(v) => setSettingsSyncEnabled(v)}
          hint="When on, your feature choices, filters, and saved views follow you to your other devices."
        />
      </div>
    </SettingsSection>
  );
}
