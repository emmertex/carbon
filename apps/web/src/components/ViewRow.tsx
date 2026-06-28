import { Eye, Users2, UserRound, Tag as TagIcon, Flag, Target } from 'lucide-react';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/cn';
import type { RowIcon } from '@/lib/config';
import { Chip } from './Chip';
import { GroupingToggle } from './PlanList';

/** The per-row icons the View row can show/hide, in display order. */
const ICON_TOGGLES: { key: RowIcon; label: string; Icon: typeof Eye }[] = [
  { key: 'focus', label: 'Focus', Icon: Eye },
  { key: 'shared', label: 'Shared', Icon: Users2 },
  { key: 'assigned', label: 'Assigned', Icon: UserRound },
  { key: 'tags', label: 'Tags', Icon: TagIcon },
  { key: 'flag', label: 'Flag', Icon: Flag },
  { key: 'plan', label: 'Plan', Icon: Target },
];

/**
 * The "View" row: which per-row icons to show, and (where it applies) the
 * Nested/Flat action grouping. Icon visibility is a global UI preference, so the
 * toggles read/write the shared `rowIcons` pref. `grouping` is only valid where a
 * planned/Plan-style list is shown — projects omit it ("only valid options").
 */
export function ViewRow({ grouping = false, className }: { grouping?: boolean; className?: string }) {
  const rowIcons = useStore((s) => s.uiPrefs.rowIcons);
  const setUiPrefs = useStore((s) => s.setUiPrefs);

  // Read the latest icons from the store at click time, not the render closure, so
  // toggling one never clobbers another's pending change.
  const toggle = (key: RowIcon) => {
    const cur = useStore.getState().uiPrefs.rowIcons;
    setUiPrefs({ rowIcons: { ...cur, [key]: !cur[key] } });
  };

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5 text-xs', className)}>
      {grouping && (
        <>
          <GroupingToggle />
          <span className="mx-1 h-4 w-px bg-border" />
        </>
      )}
      <span className="text-text-faint">Show</span>
      {ICON_TOGGLES.map(({ key, label, Icon }) => (
        <Chip
          key={key}
          active={rowIcons[key]}
          onClick={() => toggle(key)}
          aria-label={`${rowIcons[key] ? 'Hide' : 'Show'} ${label}`}
          title={label}
          className="px-1.5"
        >
          <Icon size={13} />
        </Chip>
      ))}
    </div>
  );
}
