import { Profiler, useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Item } from '@carbon/core';
import { useQuery } from '@/hooks/useQuery';
import { useStore } from '@/lib/store';
import { perf } from '@/lib/perf';
import { toggleTaskCompletion } from '@/lib/taskActions';
import { PlanList, PlanEntryRows, planEntry } from './PlanList';

/** How many off-screen rows to keep mounted on each side ("a few in either
 *  direction", per the local-DB tradeoff). */
const OVERSCAN = 8;
/** Row-height seed for the virtualizer before real heights are measured. */
const ROW_ESTIMATE = 48;
const PAGE_STEP = 10;
/** Above this many rows, drag-reorder is dropped in favour of virtualization —
 *  hand-dragging a row in a list this long isn't a real workflow, and full DOM
 *  for it is what blows up memory/render. Order is still honoured (sort_order). */
const DND_MAX = 200;

/**
 * The list renderer for the big views (Today / Inbox / Flagged / All / saved
 * perspectives). It takes the already-filtered, already-sorted top-level `items`
 * (cheap — no enrichment) and:
 *   - renders only the on-screen rows + a small overscan (windowing), and
 *   - enriches each row lazily, so tags/assignees/progress/blocked/leaf-actions
 *     are computed only for rendered rows.
 *
 * That keeps DOM size, JS heap, render time, and per-row query fan-out bounded by
 * what's visible rather than by the size of the workspace. Manual (drag) sort —
 * which is inherently small and needs full DOM for dnd — falls back to the plain
 * `PlanList`.
 */
export function VirtualTaskList({
  items,
  reorderable = false,
}: {
  items: Item[];
  reorderable?: boolean;
}) {
  // Keep drag-reorder only for small manual lists; large lists virtualize (and
  // give up drag, which isn't usable at that size anyway).
  if (reorderable && items.length <= DND_MAX) return <ReorderableList items={items} />;
  return <WindowedList items={items} />;
}

/** Manual-sort fallback: enrich everything and reuse the dnd-capable PlanList.
 *  Manual ordering is only practical on small lists, so full render is fine. */
function ReorderableList({ items }: { items: Item[] }) {
  const entries = useQuery((db) => items.map((it) => planEntry(db, it)), [items]) ?? [];
  return <PlanList entries={entries} reorderable />;
}

/** One windowed row: enriches its single item lazily (re-running on each DB
 *  change, but only while mounted = only while on screen). */
function WindowedRow({ item, focused }: { item: Item; focused: boolean }) {
  const grouping = useStore((s) => s.uiPrefs.planGrouping);
  const entry = useQuery((db) => planEntry(db, item), [item, grouping]);
  if (!entry) return null;
  return <PlanEntryRows entry={entry} grouping={grouping} focused={focused} />;
}

function WindowedList({ items }: { items: Item[] }) {
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

  return (
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
              <WindowedRow item={item} focused={item.id === focusedId} />
            </div>
          );
        })}
      </div>
    </Profiler>
  );
}
