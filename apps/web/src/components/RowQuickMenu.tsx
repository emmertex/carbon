import { createPortal } from 'react-dom';
import { Check, Target, Eye, Flag, Trash2, ClipboardList } from 'lucide-react';
import {
  listUsers,
  listTags,
  getItemTags,
  listAssigneesForItem,
  setItemTags,
  assignItem,
  unassignItem,
  hasWriteAccess,
  shareItem,
  isInPlan,
  addToPlan,
  removeFromPlan,
  type Item,
} from '@carbon/core';
import { useQuery } from '@/hooks/useQuery';
import { mutate } from '@/lib/mutate';
import { itemTreeToMarkdown } from '@/lib/exportMarkdown';
import { getCurrentUserId, useStore } from '@/lib/store';
import { useFocusItem } from '@/hooks/useFocusItem';
import { flagTask, setPriority, deleteTaskWithUndo } from '@/lib/taskActions';
import { TagMark } from './TagMark';
import { Avatar } from './Avatar';
import { cn } from '@/lib/cn';

/** Where the menu is anchored — below the trigger button (top/right) or at the
 *  cursor for a right-click (top/left). */
export interface MenuPos {
  top: number;
  left?: number;
  right?: number;
}

/** Priority picker values, low→high left to right (None first). */
const PRIORITIES = [
  { value: 0, label: 'None' },
  { value: 1, label: 'Low' },
  { value: 2, label: 'Med' },
  { value: 3, label: 'High' },
];

/** Row quick menu, rendered in a portal so scroll containers can't clip it.
 *  Opened from the row's "⋯" button or a desktop right-click; the owning row
 *  holds the position and closes it. Queries lazily — it only mounts while open,
 *  so the lists are cheap even in long views. */
export function RowQuickMenu({
  item,
  pos,
  onClose,
}: {
  item: Item;
  pos: MenuPos;
  onClose: () => void;
}) {
  const focus = useFocusItem();
  const itemId = item.id;

  const data = useQuery(
    (db) => ({
      roster: listUsers(db).filter((u) => !u.is_bot),
      tags: listTags(db),
      assigned: new Set(listAssigneesForItem(db, itemId).map((a) => a.user_id)),
      itemTags: new Set(getItemTags(db, itemId).map((t) => t.id)),
      inPlan: isInPlan(db, getCurrentUserId(), itemId),
    }),
    [itemId],
  );

  function togglePlan() {
    const uid = getCurrentUserId();
    mutate((db, dev) =>
      isInPlan(db, uid, itemId)
        ? removeFromPlan(db, dev, uid, itemId)
        : addToPlan(db, dev, uid, itemId),
    );
  }

  function toggleAssignee(userId: string) {
    mutate((db, dev) => {
      if (listAssigneesForItem(db, itemId).some((a) => a.user_id === userId)) {
        unassignItem(db, dev, itemId, userId);
      } else {
        assignItem(db, dev, itemId, userId);
        if (!hasWriteAccess(db, itemId, userId)) shareItem(db, dev, itemId, userId, 'write');
      }
    });
  }

  async function copyMarkdown() {
    const md = itemTreeToMarkdown(itemId);
    try {
      await navigator.clipboard.writeText(md);
      useStore.getState().showToast({ message: 'Copied as Markdown' });
    } catch {
      useStore.getState().showToast({ message: 'Copy failed' });
    }
    onClose();
  }

  function toggleTag(tagId: string) {
    mutate((db, dev) => {
      const current = getItemTags(db, itemId).map((t) => t.id);
      setItemTags(
        db,
        dev,
        itemId,
        current.includes(tagId) ? current.filter((id) => id !== tagId) : [...current, tagId],
      );
    });
  }

  const sectionCls =
    'mt-1 border-t border-border px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-text-faint';
  const itemCls = 'flex w-full items-center gap-2 rounded px-2 py-1 hover:bg-surface-2';

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => e.preventDefault()} />
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ top: pos.top, left: pos.left, right: pos.right }}
        className="fixed z-50 max-h-[80vh] w-52 overflow-auto rounded-lg border border-border bg-surface p-1 text-sm shadow-lg"
      >
        <button
          onClick={() => {
            focus(item);
            onClose();
          }}
          className={itemCls}
        >
          <Eye size={14} className="text-text-faint" />
          <span className="flex-1 text-left">Focus</span>
        </button>
        <button onClick={() => flagTask(item)} className={itemCls}>
          <Flag
            size={14}
            className={item.flagged ? 'text-warning' : 'text-text-faint'}
            fill={item.flagged ? 'currentColor' : 'none'}
          />
          <span className="flex-1 text-left">{item.flagged ? 'Flagged' : 'Flag'}</span>
          {item.flagged && <Check size={14} className="text-accent" />}
        </button>

        <div className="mt-1 flex gap-1 border-t border-border px-1 pb-1 pt-1.5">
          {PRIORITIES.map((p) => (
            <button
              key={p.value}
              onClick={() => setPriority(item, p.value)}
              className={cn(
                'flex-1 rounded border px-1 py-1 text-center text-xs font-medium',
                item.priority === p.value
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-border text-text-muted hover:bg-surface-2',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>

        <button onClick={togglePlan} className={cn(itemCls, 'mt-1')}>
          <Target size={14} className={data?.inPlan ? 'text-accent' : 'text-text-faint'} />
          <span className="flex-1 text-left">{data?.inPlan ? 'In Plan' : 'Add to Plan'}</span>
          {data?.inPlan && <Check size={14} className="text-accent" />}
        </button>

        <div className={sectionCls}>Assign</div>
        {data?.roster.length ? (
          data.roster.map((u) => (
            <button key={u.id} onClick={() => toggleAssignee(u.id)} className={itemCls}>
              <Avatar user={u} size="sm" />
              <span className="flex-1 truncate text-left">{u.display_name || u.username}</span>
              {data.assigned.has(u.id) && <Check size={14} className="text-accent" />}
            </button>
          ))
        ) : (
          <div className="px-2 py-1 text-xs text-text-faint">No people</div>
        )}

        <div className={sectionCls}>Tags</div>
        {data?.tags.length ? (
          data.tags.map((t) => (
            <button key={t.id} onClick={() => toggleTag(t.id)} className={itemCls}>
              <TagMark color={t.color} />
              <span className="flex-1 truncate text-left">{t.name}</span>
              {data.itemTags.has(t.id) && <Check size={14} className="text-accent" />}
            </button>
          ))
        ) : (
          <div className="px-2 py-1 text-xs text-text-faint">No tags yet</div>
        )}

        <button onClick={copyMarkdown} className={cn(itemCls, 'mt-1 border-t border-border')}>
          <ClipboardList size={14} className="text-text-faint" />
          <span className="flex-1 text-left">Copy as Markdown</span>
        </button>

        <button
          onClick={() => {
            deleteTaskWithUndo(item);
            onClose();
          }}
          className={cn(itemCls, 'text-danger')}
        >
          <Trash2 size={14} />
          <span className="flex-1 text-left">Delete</span>
        </button>
      </div>
    </>,
    document.body,
  );
}
