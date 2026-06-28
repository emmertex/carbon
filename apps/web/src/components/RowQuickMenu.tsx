import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal, Check, Target } from 'lucide-react';
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
} from '@carbon/core';
import { useQuery } from '@/hooks/useQuery';
import { mutate } from '@/lib/mutate';
import { getCurrentUserId } from '@/lib/store';
import { TagMark } from './TagMark';
import { Avatar } from './Avatar';
import { cn } from '@/lib/cn';

/** Hover affordance on a task row: assign people / toggle tags without opening the
 *  detail pane. Queries lazily (only while open) so it's cheap in long lists; the
 *  menu renders in a portal so scroll containers can't clip it. */
export function RowQuickMenu({
  itemId,
  forceVisible = false,
}: {
  itemId: string;
  /** Always show the trigger (e.g. the expanded mobile card, where there's no hover). */
  forceVisible?: boolean;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const open = pos !== null;

  const data = useQuery(
    (db) =>
      open
        ? {
            roster: listUsers(db).filter((u) => !u.is_bot),
            tags: listTags(db),
            assigned: new Set(listAssigneesForItem(db, itemId).map((a) => a.user_id)),
            itemTags: new Set(getItemTags(db, itemId).map((t) => t.id)),
            inPlan: isInPlan(db, getCurrentUserId(), itemId),
          }
        : null,
    [itemId, open],
  );

  function togglePlan() {
    const uid = getCurrentUserId();
    mutate((db, dev) =>
      isInPlan(db, uid, itemId)
        ? removeFromPlan(db, dev, uid, itemId)
        : addToPlan(db, dev, uid, itemId),
    );
  }

  function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (open) return setPos(null);
    const r = btnRef.current!.getBoundingClientRect();
    setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
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

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        className={cn(
          'mt-0.5 shrink-0 rounded p-0.5 text-text-faint transition-opacity hover:text-text',
          open || forceVisible ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        )}
        aria-label="Quick assign / tag"
      >
        <MoreHorizontal size={15} />
      </button>

      {open &&
        createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={() => setPos(null)} />
            <div
              onClick={(e) => e.stopPropagation()}
              style={{ top: pos.top, right: pos.right }}
              className="fixed z-50 max-h-72 w-52 overflow-auto rounded-lg border border-border bg-surface p-1 text-sm shadow-lg"
            >
              <button
                onClick={togglePlan}
                className="flex w-full items-center gap-2 rounded px-2 py-1 hover:bg-surface-2"
              >
                <Target size={14} className={data?.inPlan ? 'text-accent' : 'text-text-faint'} />
                <span className="flex-1 text-left">{data?.inPlan ? 'In Plan' : 'Add to Plan'}</span>
                {data?.inPlan && <Check size={14} className="text-accent" />}
              </button>

              <div className="mt-1 border-t border-border px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-text-faint">
                Assign
              </div>
              {data?.roster.length ? (
                data.roster.map((u) => (
                  <button
                    key={u.id}
                    onClick={() => toggleAssignee(u.id)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1 hover:bg-surface-2"
                  >
                    <Avatar user={u} size="sm" />
                    <span className="flex-1 truncate text-left">
                      {u.display_name || u.username}
                    </span>
                    {data.assigned.has(u.id) && <Check size={14} className="text-accent" />}
                  </button>
                ))
              ) : (
                <div className="px-2 py-1 text-xs text-text-faint">No people</div>
              )}

              <div className="mt-1 border-t border-border px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-text-faint">
                Tags
              </div>
              {data?.tags.length ? (
                data.tags.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => toggleTag(t.id)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1 hover:bg-surface-2"
                  >
                    <TagMark color={t.color} />
                    <span className="flex-1 truncate text-left">{t.name}</span>
                    {data.itemTags.has(t.id) && <Check size={14} className="text-accent" />}
                  </button>
                ))
              ) : (
                <div className="px-2 py-1 text-xs text-text-faint">No tags yet</div>
              )}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
