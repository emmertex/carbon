import { useStore } from '@/lib/store';
import type { SwipeLeftAction, EdgeGestureAction, CountScope } from '@/lib/config';
import { LINKS } from '@/lib/links';
import { SettingsSection } from './SettingsSection';
import { ThemeChip, SettingsToggle, DocLink } from './controls';

const SWIPE_LEFT_ACTIONS: { id: SwipeLeftAction; label: string }[] = [
  { id: 'plan', label: 'Add to Plan' },
  { id: 'flag', label: 'Flag' },
  { id: 'details', label: 'Open Details' },
  { id: 'delete', label: 'Delete' },
];
const EDGE_GESTURE_ACTIONS: { id: EdgeGestureAction; label: string }[] = [
  { id: 'projectRoot', label: 'Project Root' },
  { id: 'today', label: 'Today' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'plan', label: 'Plan' },
];
const COUNT_SCOPES: { id: CountScope; label: string }[] = [
  { id: 'all', label: 'All Tasks' },
  { id: 'direct', label: 'Direct Subtasks' },
];

export function GesturesSection() {
  const uiPrefs = useStore((s) => s.uiPrefs);
  const setUiPrefs = useStore((s) => s.setUiPrefs);

  return (
    <SettingsSection id="gestures" title="Gestures & mobile">
      <span className="mb-1 block text-sm font-medium">Swipe-left action</span>
      <div className="flex flex-wrap gap-2">
        {SWIPE_LEFT_ACTIONS.map((o) => (
          <ThemeChip
            key={o.id}
            label={o.label}
            active={uiPrefs.swipeLeftAction === o.id}
            onClick={() => setUiPrefs({ swipeLeftAction: o.id })}
          />
        ))}
      </div>
      <p className="mb-4 mt-1 text-xs text-text-faint">Swiping a task right always completes it.</p>

      <SettingsToggle
        className="mb-4"
        label="Enable pane gestures (edge swipes open panes; the centre swipes act on tasks)"
        checked={uiPrefs.paneGestures}
        onChange={(v) => setUiPrefs({ paneGestures: v })}
      />

      <span className="mb-1 block text-sm font-medium">Right-edge swipe</span>
      <div className="mb-4 flex flex-wrap gap-2">
        {EDGE_GESTURE_ACTIONS.map((o) => (
          <ThemeChip
            key={o.id}
            label={o.label}
            active={uiPrefs.edgeGestureAction === o.id}
            onClick={() => setUiPrefs({ edgeGestureAction: o.id })}
          />
        ))}
      </div>

      <span className="mb-1 block text-sm font-medium">Task progress counting</span>
      <div className="flex flex-wrap gap-2">
        {COUNT_SCOPES.map((o) => (
          <ThemeChip
            key={o.id}
            label={o.label}
            active={uiPrefs.countScope === o.id}
            onClick={() => setUiPrefs({ countScope: o.id })}
          />
        ))}
      </div>
      <p className="mt-1 text-xs text-text-faint">
        Drives the parent-task progress ring and the “tasks left” counts.
      </p>

      <div className="mt-4 border-t border-border pt-3">
        <DocLink href={LINKS.usage}>Usage, keyboard shortcuts &amp; terminology</DocLink>
      </div>
    </SettingsSection>
  );
}
