import { useStore } from '@/lib/store';
import { resolveFeature, type FeatureId } from '@/lib/features';
import { useCompact } from './useCompact';

/** Whether an optional feature surface is visible, given the user's complexity
 *  preset (or custom per-device overrides) and the current viewport. Reactive to
 *  both preference changes and resize. */
export function useFeature(id: FeatureId): boolean {
  const prefs = useStore((s) => s.uiPrefs);
  const compact = useCompact();
  return resolveFeature(prefs, id, compact);
}
