import { Eye, Users2, UserRound, Tag as TagIcon, Flag, Target, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { useStore } from '@/lib/store';
import { useFeature } from '@/hooks/useFeature';
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
export function ViewRow({
  grouping = false,
  className,
  collapseIds,
}: {
  grouping?: boolean;
  className?: string;
  /** Ids of the container rows (tasks/projects with children) in the tree
   *  currently on screen. When given and non-empty, renders "Collapse All" /
   *  "Expand All" buttons that fold/unfold every one of them at once. */
  collapseIds?: string[];
}) {
  const rowIcons = useStore((s) => s.uiPrefs.rowIcons);
  const setUiPrefs = useStore((s) => s.setUiPrefs);
  const collapseAll = useStore((s) => s.collapseAll);
  const expandAll = useStore((s) => s.expandAll);
  const showBar = useFeature('showBar');

  // Hidden by the user's UI-complexity choice. Row-icon prefs still apply; only the
  // toggle bar is gone.
  if (!showBar) return null;

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
      {collapseIds && collapseIds.length > 0 && (
        <>
          <span className="mx-1 h-4 w-px bg-border" />
          <Chip
            active={false}
            onClick={() => collapseAll(collapseIds)}
            aria-label="Collapse all"
            title="Collapse all"
            className="px-1.5"
          >
            <ChevronsDownUp size={13} />
          </Chip>
          <Chip
            active={false}
            onClick={() => expandAll(collapseIds)}
            aria-label="Expand all"
            title="Expand all"
            className="px-1.5"
          >
            <ChevronsUpDown size={13} />
          </Chip>
        </>
      )}
    </div>
  );
}
