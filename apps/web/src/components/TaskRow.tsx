import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Flag,
  Check,
  ChevronRight,
  Pencil,
  MessageSquare,
  Users2,
  Target,
  Ban,
  Eye,
  MoreHorizontal,
  Sparkles,
  FileText,
} from 'lucide-react';
import {
  subtaskProgress,
  inheritedPriority,
  isInPlan,
  isOverdue,
  isDueToday,
  type Item,
  type Tag,
  type User,
} from '@carbon/core';
import { useQuery } from '@/hooks/useQuery';
import { useCompact } from '@/hooks/useCompact';
import { useFocusItem } from '@/hooks/useFocusItem';
import { TagMark } from './TagMark';
import { abbreviateTagPath } from '@/lib/tagLabel';
import { ProgressRing } from './ProgressRing';
import { Avatar } from './Avatar';
import { RemoteOwnerBadge } from './RemoteOwnerBadge';
import { RowQuickMenu, type MenuPos } from './RowQuickMenu';
import { useStore, getCurrentUserId } from '@/lib/store';
import { cn } from '@/lib/cn';
import { formatDue } from '@/lib/date';
import { toggleTaskCompletion, flagTask, togglePlan } from '@/lib/taskActions';

/** Shared classes for the right-hand row action buttons (focus/flag/plan/menu):
 *  faint until row hover, lit when in their active state. `expanded` keeps them
 *  visible on the expanded mobile card where there's no hover. */
function actionCls(active: boolean, activeClass: string, expanded: boolean) {
  return cn(
    'mt-0.5 shrink-0 rounded p-0.5 transition-opacity',
    active
      ? activeClass
      : cn('text-text-faint hover:text-text', expanded ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'),
  );
}

export interface TaskRowData {
  item: Item;
  projectId?: string | null;
  projectName?: string | null;
  projectColor?: string | null;
  tags?: Tag[];
  assignees?: User[];
  hasChildren?: boolean;
  hasComments?: boolean;
  /** Shared with at least one other user (directly or via an ancestor). */
  shared?: boolean;
  /** Blocked/unavailable: a sequential earlier sibling or a predecessor is unmet. */
  blocked?: boolean;
  /** Carries an on-hold tag — rendered faded (OmniFocus "on hold"). */
  onHold?: boolean;
  /** When the item is owned by a federation shadow user, its `home_server` label —
   *  drives the subtle "from @&lt;host&gt;" badge. Undefined for locally-owned items. */
  remoteOwner?: string | null;
}

/** Indentation: subtle, capped, and tighter on phones so deep trees don't run
 *  off-screen. A single place to tune the step/cap. */
const MAX_DEPTH = 6;
const INDENT_BASE_REM = 0.75; // matches the row's px-3
const STEP_ROOMY_REM = 1;
const STEP_COMPACT_REM = 0.75; // ~12px

/** Up to two colour-only tag dots + a "+N" pill — the collapsed-row tag view. */
function TagDots({ tags }: { tags: Tag[] }) {
  return (
    <span className="mt-0.5 flex shrink-0 items-center gap-1">
      {tags.slice(0, 2).map((t) => (
        <span
          key={t.id}
          title={t.name}
          className="h-2 w-2 rounded-full"
          style={{ background: t.color || 'var(--accent)' }}
        />
      ))}
      {tags.length > 2 && (
        <span className="text-[10px] leading-none text-text-faint">+{tags.length - 2}</span>
      )}
    </span>
  );
}

export function TaskRow({
  item,
  projectId,
  projectName,
  projectColor,
  tags = [],
  assignees = [],
  hasChildren,
  hasComments,
  shared,
  blocked,
  onHold,
  remoteOwner,
  showProject = false,
  indent = 0,
  collapsed,
  onToggleCollapse,
  focused,
  titleSlot,
}: TaskRowData & {
  showProject?: boolean;
  indent?: number;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  focused?: boolean;
  /** Replaces the title text (used for inline keyboard editing). */
  titleSlot?: React.ReactNode;
}) {
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const openDetail = useStore((s) => s.openDetail);
  const countScope = useStore((s) => s.uiPrefs.countScope);
  // Per-row iconography is a global view preference (the View row). Flag and Plan
  // are independent toggles here — no auto-swap based on the swipe action.
  const rowIcons = useStore((s) => s.uiPrefs.rowIcons);
  const compact = useCompact();
  const navigate = useNavigate();
  const focus = useFocusItem();
  // Quick menu anchor: set by the "⋯" button or a desktop right-click; null = closed.
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null);
  const selected = selectedId === item.id;
  const isNote = item.type === 'note';
  const done = item.status === 'done';
  const overdue = isOverdue(item);
  const dueToday = isDueToday(item);

  // Sub-task progress for the pie ring (and to decide leaf vs parent behaviour).
  const progress =
    useQuery((db) => subtaskProgress(db, item.id, countScope), [item.id, countScope]) ?? {
      done: 0,
      total: 0,
    };
  const isParent = progress.total > 0;
  const allDone = isParent && progress.done >= progress.total;

  // Priority is shown by tinting the completion circle: a resting ring colour and
  // a brighter/darker completion (fill / progress-arc) colour, theme-aware via CSS
  // vars. 0 None=grey, 1 Low=blue, 2 Med=orange, 3 High=red. An unprioritised task
  // inherits its nearest ancestor *task*'s priority, so a subtree shares a colour
  // until a task sets its own. (Project colours are not inherited onto tasks.)
  const prio =
    useQuery((db) => inheritedPriority(db, item), [item.id, item.priority, item.parent_id]) ??
    Math.min(3, Math.max(0, item.priority || 0));
  const ringColor = `var(--prio-${prio}-ring)`;
  const fillColor = `var(--prio-${prio}-fill)`;

  // Plan membership — only queried when the Plan toggle is shown.
  const inPlan =
    useQuery(
      (db) => (rowIcons.plan ? isInPlan(db, getCurrentUserId(), item.id) : false),
      [item.id, rowIcons.plan],
    ) ?? false;

  // Compact rows collapse to a lean summary and expand into a full card when
  // selected (accordion via the single selectedId). Desktop stays roomy always.
  const expanded = compact && selected;
  const lean = compact && !selected;
  const showActions = !compact || expanded; // flag + menu
  const showMeta = !compact || expanded; // due/project/assignees, full tag labels

  function toggleComplete(e: React.MouseEvent) {
    e.stopPropagation();
    // Shared with the keyboard path: completing a parent with unfinished sub-tasks
    // confirms and cascades to all descendants (§7).
    toggleTaskCompletion(item);
  }

  function toggleFlag(e: React.MouseEvent) {
    e.stopPropagation();
    flagTask(item);
  }

  /** Desktop right-click opens the quick menu at the cursor (clamped to stay on
   *  screen). Touch devices keep the explicit "⋯" button instead. */
  function openContextMenu(e: React.MouseEvent) {
    if (compact) return;
    e.preventDefault();
    const MENU_W = 208; // w-52
    setMenuPos({ top: e.clientY, left: Math.min(e.clientX, window.innerWidth - MENU_W - 8) });
  }

  /** "⋯" button: toggle the menu anchored just below it, right-aligned. */
  function toggleMenu(e: React.MouseEvent) {
    e.stopPropagation();
    if (menuPos) return setMenuPos(null);
    const r = e.currentTarget.getBoundingClientRect();
    setMenuPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
  }

  const step = compact ? STEP_COMPACT_REM : STEP_ROOMY_REM;
  const padLeft = indent ? `${Math.min(indent, MAX_DEPTH) * step + INDENT_BASE_REM}rem` : undefined;

  return (
    <div
      data-testid="task-row"
      data-title={item.title}
      data-status={item.status}
      onClick={() => {
        // Collapsed → select (expands). Expanded card → tap opens the full detail.
        // Desktop → select shows the docked pane.
        if (selected && compact) openDetail();
        else select(item.id);
      }}
      onContextMenu={openContextMenu}
      style={padLeft ? { paddingLeft: padLeft } : undefined}
      className={cn(
        'group flex cursor-pointer items-start gap-2.5 rounded-lg px-3 transition-colors',
        expanded ? 'py-3' : 'py-2',
        selected ? 'bg-accent-soft' : 'hover:bg-surface-2',
        focused && 'ring-2 ring-inset ring-accent',
        onHold && !done && 'opacity-50',
      )}
    >
      {isNote ? (
        // A note can't be completed from the row — a static glyph replaces the
        // completion ring. Clicking the row (handled above) opens the note.
        <span
          className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center text-text-faint"
          aria-label="Note"
          title="Note"
        >
          <FileText size={15} />
        </span>
      ) : (
        <button
          onClick={toggleComplete}
          className={cn(
            'relative mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full transition-colors',
            done && 'border text-white',
          )}
          style={done ? { background: fillColor, borderColor: fillColor } : undefined}
          aria-label={done ? 'Mark incomplete' : 'Mark complete'}
          title={
            isParent && !allDone ? `${progress.done}/${progress.total} sub-tasks done` : undefined
          }
        >
          {done ? (
            <Check size={12} strokeWidth={3} />
          ) : (
            // Leaf and parent share the same SVG ring (leaf = empty track); the arc
            // fills as sub-tasks complete. Uniform 2.5px weight across every row.
            <ProgressRing
              done={progress.done}
              total={progress.total}
              ringColor={ringColor}
              fillColor={fillColor}
            />
          )}
          {item.flagged && !done && (
            // Flag → amber dot in the centre of the ring.
            <span
              className="pointer-events-none absolute inset-0 m-auto h-[6px] w-[6px] rounded-full"
              style={{ background: 'var(--warning)' }}
            />
          )}
        </button>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {onToggleCollapse && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleCollapse();
              }}
              className="-ml-1 shrink-0 rounded p-0.5 text-text-faint hover:text-text"
              aria-label={collapsed ? 'Expand' : 'Collapse'}
            >
              <ChevronRight
                size={14}
                className={cn('transition-transform', !collapsed && 'rotate-90')}
              />
            </button>
          )}
          {item.sys_kind && (
            // Marks a Carbon-authored system notice (federation offer, billing, …).
            <Sparkles
              size={12}
              className="shrink-0 text-accent"
              aria-label="From Carbon"
            />
          )}
          {titleSlot ?? (
            <span
              className={cn(
                'truncate text-sm',
                done ? 'text-text-faint line-through' : blocked ? 'text-text-muted' : 'text-text',
              )}
            >
              {item.title || 'Untitled'}
            </span>
          )}
          {blocked && !done && (
            <span
              className="flex shrink-0 items-center text-text-faint"
              title="Blocked — waiting on an earlier or prerequisite task"
            >
              <Ban size={12} aria-label="Blocked" />
            </span>
          )}
          {item.note && (
            <Pencil size={12} className="shrink-0 text-text-faint" aria-label="Has notes" />
          )}
          {hasComments && (
            <MessageSquare
              size={12}
              className="shrink-0 text-text-faint"
              aria-label="Has comments"
            />
          )}
          {remoteOwner && <RemoteOwnerBadge homeServer={remoteOwner} />}
        </div>

        {showMeta && (item.due_date || (showProject && projectName) || hasChildren) && (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-text-muted">
            {item.due_date && (
              <span
                className={cn(
                  'tabular-nums',
                  overdue && 'font-medium text-danger',
                  !overdue && dueToday && 'font-medium text-accent',
                )}
              >
                {formatDue(item.due_date)}
              </span>
            )}
            {showProject && projectName && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (projectId) navigate(`/project/${projectId}`);
                }}
                className="flex items-center gap-1 hover:text-accent hover:underline"
                title={`Go to ${projectName}`}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: projectColor || 'var(--text-faint)' }}
                />
                {projectName}
              </button>
            )}
            {hasChildren && <span className="text-text-faint">contains tasks</span>}
          </div>
        )}
      </div>

      {showMeta && rowIcons.assigned && assignees.length > 0 && (
        <div className="mt-0.5 flex shrink-0 items-center -space-x-1">
          {assignees.slice(0, 3).map((u) => (
            <Avatar key={u.id} user={u} size="sm" className="ring-1 ring-bg" />
          ))}
          {assignees.length > 3 && (
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-2 text-[10px] text-text-muted ring-1 ring-bg">
              +{assignees.length - 3}
            </span>
          )}
        </div>
      )}

      {rowIcons.tags &&
        tags.length > 0 &&
        (lean ? (
          <TagDots tags={tags} />
        ) : (
          <div className="mt-0.5 flex shrink-0 items-center gap-1">
            {tags.slice(0, 2).map((t) => (
              <span
                key={t.id}
                title={t.name}
                className="flex max-w-[8rem] items-center gap-1 rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-muted"
              >
                <TagMark color={t.color} />
                <span className="truncate">{abbreviateTagPath(t.name)}</span>
              </span>
            ))}
            {tags.length > 2 && (
              <span
                title={tags
                  .slice(2)
                  .map((t) => t.name)
                  .join(', ')}
                className="rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] leading-none text-text-muted"
              >
                …
              </span>
            )}
          </div>
        ))}

      {/* Share indicator — last of the indicators so it right-aligns into a
          consistent column across rows (shown even in the lean collapsed row). */}
      {rowIcons.shared && shared && (
        <Users2 size={14} className="mt-0.5 shrink-0 text-text-faint" aria-label="Shared" />
      )}

      {showActions && (
        <>
          {rowIcons.focus && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                focus(item);
              }}
              className={actionCls(false, '', expanded)}
              aria-label="Focus on this task"
              title="Focus on this task"
            >
              <Eye size={15} />
            </button>
          )}
          {rowIcons.flag && (
            <button
              onClick={toggleFlag}
              className={actionCls(item.flagged, 'text-warning', expanded)}
              aria-label={item.flagged ? 'Unflag' : 'Flag'}
            >
              <Flag size={15} fill={item.flagged ? 'currentColor' : 'none'} />
            </button>
          )}
          {rowIcons.plan && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                togglePlan(item);
              }}
              className={actionCls(inPlan, 'text-accent', expanded)}
              aria-label={inPlan ? 'Remove from Plan' : 'Add to Plan'}
            >
              <Target size={15} />
            </button>
          )}
          <button
            onClick={toggleMenu}
            className={actionCls(menuPos !== null, 'text-text', expanded)}
            aria-label="More actions"
          >
            <MoreHorizontal size={15} />
          </button>
        </>
      )}

      {menuPos && <RowQuickMenu item={item} pos={menuPos} onClose={() => setMenuPos(null)} />}
    </div>
  );
}
