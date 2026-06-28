import { useRef, useState } from 'react';
import { Check, Flag, Trash2, Target, PanelRightOpen } from 'lucide-react';
import { subtaskProgress, type Item } from '@carbon/core';
import { useQuery } from '@/hooks/useQuery';
import { useStore } from '@/lib/store';
import { zoneForX } from '@/lib/gestures';
import {
  completeTask,
  flagTask,
  planTask,
  deleteTaskWithUndo,
} from '@/lib/taskActions';
import { cn } from '@/lib/cn';

/** Distance past which a release commits the swipe action (else it springs back). */
const COMMIT_PX = 72;
const MAX_PX = 120;

const clamp = (v: number) => Math.max(-MAX_PX, Math.min(MAX_PX, v));

/** Wraps a task row with horizontal swipe gestures: right → complete (locked),
 *  left → the configurable action. Axis-locked so vertical drags scroll the list
 *  (`touch-action: pan-y`), and zone-aware so edge swipes are left to the panes. */
export function SwipeableRow({ item, children }: { item: Item; children: React.ReactNode }) {
  const [dx, setDx] = useState(0);
  // The committed delta lives in the ref (not just state) so touch-end reads it
  // synchronously, regardless of React's render batching.
  const drag = useRef<{
    x: number;
    y: number;
    dx: number;
    axis: null | 'h' | 'v';
    active: boolean;
  } | null>(null);
  const swiped = useRef(false);

  const paneGestures = useStore((s) => s.uiPrefs.paneGestures);
  const swipeLeftAction = useStore((s) => s.uiPrefs.swipeLeftAction);
  const countScope = useStore((s) => s.uiPrefs.countScope);
  const select = useStore((s) => s.select);
  const openDetail = useStore((s) => s.openDetail);
  const showToast = useStore((s) => s.showToast);

  const progress =
    useQuery((db) => subtaskProgress(db, item.id, countScope), [item.id, countScope]) ?? {
      done: 0,
      total: 0,
    };
  // A parent with unfinished children can't be completed by swipe (§3/§7) — that
  // needs the deliberate tap + confirm.
  const completeBlocked = progress.total > 0 && progress.done < progress.total;
  const done = item.status === 'done';

  function onTouchStart(e: React.TouchEvent) {
    const t = e.touches[0]!;
    const zone = zoneForX(t.clientX, window.innerWidth, paneGestures);
    drag.current = { x: t.clientX, y: t.clientY, dx: 0, axis: null, active: zone === 'center' };
  }

  function onTouchMove(e: React.TouchEvent) {
    const d = drag.current;
    if (!d || !d.active) return;
    const t = e.touches[0]!;
    const ddx = t.clientX - d.x;
    const ddy = t.clientY - d.y;
    if (d.axis === null && (Math.abs(ddx) > 8 || Math.abs(ddy) > 8)) {
      d.axis = Math.abs(ddx) > Math.abs(ddy) ? 'h' : 'v';
    }
    if (d.axis === 'h') {
      d.dx = clamp(ddx);
      setDx(d.dx);
    }
  }

  function onTouchEnd() {
    const d = drag.current;
    drag.current = null;
    if (d && d.axis === 'h' && Math.abs(d.dx) > 10) {
      swiped.current = true; // swallow the click that follows
      if (Math.abs(d.dx) >= COMMIT_PX) commit(d.dx > 0 ? 'right' : 'left');
    }
    setDx(0);
  }

  function commit(dir: 'right' | 'left') {
    if (dir === 'right') {
      if (done) return; // already complete
      if (completeBlocked) {
        showToast({ message: 'Finish sub-tasks first' });
        return; // bounce — spring back, no change
      }
      completeTask(item);
      return;
    }
    switch (swipeLeftAction) {
      case 'flag':
        return flagTask(item);
      case 'plan':
        return planTask(item);
      case 'details':
        select(item.id);
        return openDetail();
      case 'delete':
        return deleteTaskWithUndo(item);
    }
  }

  // Left-action affordance shown as the row slides left.
  const leftAction =
    swipeLeftAction === 'delete'
      ? { bg: 'bg-danger', icon: <Trash2 size={18} /> }
      : swipeLeftAction === 'flag'
        ? { bg: 'bg-warning', icon: <Flag size={18} /> }
        : swipeLeftAction === 'details'
          ? { bg: 'bg-text-faint', icon: <PanelRightOpen size={18} /> }
          : { bg: 'bg-accent', icon: <Target size={18} /> };

  return (
    <div className="relative overflow-hidden">
      {/* Right-swipe → complete (revealed on the left as the row moves right) */}
      <div
        className={cn(
          'absolute inset-y-0 left-0 flex items-center px-5 text-white transition-opacity',
          completeBlocked ? 'bg-text-faint' : 'bg-success',
          dx > 0 ? 'opacity-100' : 'opacity-0',
        )}
        aria-hidden
      >
        <Check size={18} />
      </div>
      {/* Left-swipe → configurable action (revealed on the right) */}
      <div
        className={cn(
          'absolute inset-y-0 right-0 flex items-center px-5 text-white transition-opacity',
          leftAction.bg,
          dx < 0 ? 'opacity-100' : 'opacity-0',
        )}
        aria-hidden
      >
        {leftAction.icon}
      </div>

      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onClickCapture={(e) => {
          if (swiped.current) {
            e.preventDefault();
            e.stopPropagation();
            swiped.current = false;
          }
        }}
        style={{
          transform: `translateX(${dx}px)`,
          transition: dx === 0 ? 'transform 0.2s ease-out' : 'none',
          touchAction: 'pan-y',
        }}
        className="relative bg-bg"
      >
        {children}
      </div>
    </div>
  );
}
