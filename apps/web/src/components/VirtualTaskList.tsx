import { Profiler, useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { DndContext, DragOverlay, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useReorderSensors } from '@/hooks/useReorderSensors';
import { mutate } from '@/lib/mutate';
import { moveListItem } from '@/lib/listReorder';
import type { Item } from '@carbon/core';
import { useQuery } from '@/hooks/useQuery';
import { useStore } from '@/lib/store';
import { perf } from '@/lib/perf';
import { toggleTaskCompletion } from '@/lib/taskActions';
import { PlanEntryRows, planEntry } from './PlanList';

/** How many off-screen rows to keep mounted on each side ("a few in either
 *  direction", per the local-DB tradeoff). */
const OVERSCAN = 8;
/** Row-height seed for the virtualizer before real heights are measured. */
const ROW_ESTIMATE = 48;
const PAGE_STEP = 10;
/**
 * The list renderer for the big views (Today / Inbox / Flagged / All / saved
 * perspectives). It takes the already-filtered, already-sorted top-level `items`
 * (cheap — no enrichment) and:
 *   - renders only the on-screen rows + a small overscan (windowing), and
 *   - enriches each row lazily, so tags/assignees/progress/blocked/leaf-actions
 *     are computed only for rendered rows.
 *
 * That keeps DOM size, JS heap, render time, and per-row query fan-out bounded by
 * what's visible. Sortable targets mount with the virtual window; the drag overlay
 * retains the lifted row's measured dimensions while scrolling.
 */
export function VirtualTaskList({
  items,
  reorderable = false,
}: {
  items: Item[];
  reorderable?: boolean;
}) {
  return <WindowedList items={items} reorderable={reorderable} />;
}

function DraggableRow({ item, children, intent }: { item: Item; children: React.ReactNode; intent?: 'before' | 'after' }) {
  const { setNodeRef, listeners, attributes, transform, transition, isDragging } = useSortable({ id: item.id });
  return <div ref={setNodeRef} className="relative" data-sortable-id={item.id} {...attributes} {...listeners}
    style={{ transform: CSS.Transform.toString(transform ? { ...transform, scaleX: 1, scaleY: 1 } : null), transition,
      opacity: isDragging ? 0.3 : 1, outline: intent ? '2px solid var(--color-accent)' : undefined }}>
    {intent === 'before' && <div className="pointer-events-none absolute inset-x-0 top-0 z-10 border-t-2 border-accent text-xs text-accent">Drop before</div>}
    {children}
    {intent === 'after' && <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 border-b-2 border-accent text-xs text-accent">Drop after</div>}
  </div>;
}

/** One windowed row: enriches its single item lazily (re-running on each DB
 *  change, but only while mounted = only while on screen). */
function WindowedRow({ item, focused }: { item: Item; focused: boolean }) {
  const grouping = useStore((s) => s.uiPrefs.planGrouping);
  const entry = useQuery((db) => planEntry(db, item), [item, grouping]);
  if (!entry) return null;
  return <PlanEntryRows entry={entry} grouping={grouping} focused={focused} />;
}

function WindowedList({ items, reorderable }: { items: Item[]; reorderable: boolean }) {
  const sensors = useReorderSensors();
  const selectedId = useStore((s) => s.selectedId);
  const [drag, setDrag] = useState<{ id: string; width: number; height: number } | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [position, setPosition] = useState(1);
  function move(id: string, index: number) { mutate((db, dev) => moveListItem(db, dev, items, id, index)); }
  function endDrag(event: DragEndEvent) {
    const index = event.over ? items.findIndex((i) => i.id === event.over!.id) : -1;
    if (index >= 0) move(String(event.active.id), index);
    setDrag(null); setOverId(null);
  }
  const select = useStore((s) => s.select);
  const openDetail = useStore((s) => s.openDetail);

  const listRef = useRef<HTMLDivElement>(null);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // Find the nearest scrolling ancestor (the app's <main>) — the virtualizer
  // measures against it, and the list lives inside it below a header/quick-add.
  useLayoutEffect(() => {
    let n: HTMLElement | null = listRef.current?.parentElement ?? null;
    while (n) {
      const oy = getComputedStyle(n).overflowY;
      if (oy === 'auto' || oy === 'scroll') break;
      n = n.parentElement;
    }
    setScrollEl(n);
  }, []);

  // Distance from the scroll container's content-top to where the list starts, so
  // virtual offsets line up with the real scroll position.
  useLayoutEffect(() => {
    if (!scrollEl || !listRef.current) return;
    const recompute = () => {
      const l = listRef.current;
      if (!l) return;
      setScrollMargin(l.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop);
    };
    recompute();
    window.addEventListener('resize', recompute);
    return () => window.removeEventListener('resize', recompute);
  }, [scrollEl, items.length]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => ROW_ESTIMATE,
    overscan: OVERSCAN,
    scrollMargin,
    getItemKey: (index) => items[index]!.id,
  });

  function moveFocus(nextIdx: number) {
    const idx = Math.max(0, Math.min(nextIdx, items.length - 1));
    const id = items[idx]?.id ?? null;
    setFocusedId(id);
    virtualizer.scrollToIndex(idx, { align: 'auto' });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.target !== e.currentTarget) return;
    if (!items.length) return;
    const idx = focusedId ? items.findIndex((i) => i.id === focusedId) : -1;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        return moveFocus(idx < 0 ? 0 : idx + 1);
      case 'ArrowUp':
        e.preventDefault();
        return moveFocus(idx < 0 ? 0 : idx - 1);
      case 'Home':
        e.preventDefault();
        return moveFocus(0);
      case 'End':
        e.preventDefault();
        return moveFocus(items.length - 1);
      case 'PageDown':
        e.preventDefault();
        return moveFocus((idx < 0 ? 0 : idx) + PAGE_STEP);
      case 'PageUp':
        e.preventDefault();
        return moveFocus((idx < 0 ? 0 : idx) - PAGE_STEP);
      case ' ': {
        if (idx < 0) return;
        e.preventDefault();
        return toggleTaskCompletion(items[idx]!);
      }
      case 'Enter': {
        if (idx < 0) return;
        e.preventDefault();
        select(items[idx]!.id);
        if (e.ctrlKey || e.metaKey) openDetail();
        return;
      }
      default:
        return;
    }
  }

  const list = (
    <Profiler id="list" onRender={(_id, _phase, actual) => perf.record('render', 'list', actual)}>
      <div
        ref={listRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        data-tasklist
        className="relative outline-none"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((vi) => {
          const item = items[vi.index]!;
          return (
            <div
              key={item.id}
              data-index={vi.index}
              data-row-id={item.id}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)`,
              }}
            >
              {reorderable ? <DraggableRow item={item}
                intent={drag && overId === item.id && drag.id !== item.id ?
                  (items.findIndex((i) => i.id === drag.id) < vi.index ? 'after' : 'before') : undefined}>
                <WindowedRow item={item} focused={item.id === focusedId} />
              </DraggableRow> : <WindowedRow item={item} focused={item.id === focusedId} />}
            </div>
          );
        })}
      </div>
    </Profiler>
  );
  if (!reorderable) return list;
  return <DndContext sensors={sensors} collisionDetection={closestCenter}
    onDragStart={({ active }) => { const rect = active.rect.current.initial; setDrag({ id: String(active.id), width: rect?.width ?? 0, height: rect?.height ?? 48 }); }}
    onDragOver={({ over }) => setOverId(over ? String(over.id) : null)}
    onDragEnd={endDrag} onDragCancel={() => { setDrag(null); setOverId(null); }}>
    <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
      <label>Move selected task to position <input aria-label="Move selected task to position" type="number" min={1} max={items.length}
        className="w-20 rounded border border-border bg-surface px-2 py-1" value={position} onChange={(e) => setPosition(Number(e.target.value))} /></label>
      <button className="text-accent disabled:opacity-40" disabled={!items.some((i) => i.id === selectedId)}
        onClick={() => { if (selectedId) move(selectedId, position - 1); }}>Move</button>
    </div>
    <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>{list}</SortableContext>
    <DragOverlay adjustScale={false}>{drag && <div data-testid="drag-preview" className="rounded border border-accent bg-surface px-3 py-2 shadow-lg"
      style={{ width: drag.width, height: drag.height }}>{items.find((i) => i.id === drag.id)?.title}</div>}</DragOverlay>
  </DndContext>;
}
