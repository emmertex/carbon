import { memo, useEffect, useRef, useState } from "react";
import { DndContext, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  availableLeaves,
  getChildren,
  reorderItem,
  type Db,
  type Item,
  type OrderMode,
} from "@carbon/core";
import { useReorderSensors } from "@/hooks/useReorderSensors";
import { enrichItems } from "@/lib/enrich";
import { useStore } from "@/lib/store";
import { mutate } from "@/lib/mutate";
import { toggleTaskCompletion } from "@/lib/taskActions";
import { cn } from "@/lib/cn";
import { TaskRow, type TaskRowData } from "./TaskRow";
import { SwipeableRow } from "./SwipeableRow";
import { SelectedAddTaskButtons } from "./AddTaskButtons";
import { SegmentedControl } from "./ui/SegmentedControl";

/** A planned/matched item plus the available leaf actions to surface beneath it.
 *  For a sequential parent that's just the next action; for parallel/single it's
 *  all available leaves (single keeps them collapsed). This is the shared "Plan"
 *  presentation reused across Plan, Today, Flagged, Forecast and Inbox so subtask
 *  surfacing is identical everywhere. */
export interface PlanEntry {
  parent: TaskRowData;
  orderMode: OrderMode;
  hasChildren: boolean;
  leaves: TaskRowData[];
}

export function planEntry(db: Db, item: Item): PlanEntry {
  const hasChildren = getChildren(db, item.id).some((c) => c.type === "task");
  let leaves: Item[] = [];
  if (hasChildren) {
    const all = availableLeaves(db, item.id);
    leaves = item.order_mode === "sequential" ? all.slice(0, 1) : all;
  }
  return {
    parent: enrichItems(db, [item])[0],
    orderMode: item.order_mode,
    hasChildren,
    leaves: enrichItems(db, leaves),
  };
}

/** The two-row scaffold every entry shares: a `relative` wrapper around the top
 *  row (so a reorder grip can anchor to it) followed by any nested rows. */
function EntryShell({
  grip,
  topRow,
  rest,
}: {
  grip?: React.ReactNode;
  topRow: React.ReactNode;
  rest?: React.ReactNode;
}) {
  return (
    <div>
      <div className="relative">
        {grip}
        {topRow}
      </div>
      {rest}
    </div>
  );
}

/** Renders one entry per the global grouping toggle and its order mode. The
 *  optional `grip` is the drag handle, anchored to the top row only. */
export const PlanEntryRows = memo(function PlanEntryRows({
  entry,
  grouping,
  grip,
  focused = false,
}: {
  entry: PlanEntry;
  grouping: "nested" | "flat";
  grip?: React.ReactNode;
  /** Keyboard focus highlight for the entry's primary (parent) row. */
  focused?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const { parent, orderMode, hasChildren, leaves } = entry;

  const leafRow = (d: TaskRowData) => (
    <div key={d.item.id}>
      <SwipeableRow item={d.item}>
        <TaskRow {...d} showProject indent={grouping === "nested" ? 1 : 0} />
      </SwipeableRow>
      <SelectedAddTaskButtons
        itemId={d.item.id}
        depth={grouping === "nested" ? 1 : 0}
      />
    </div>
  );
  const parentRow = (
    <>
      <SwipeableRow item={parent.item}>
        <TaskRow {...parent} showProject focused={focused} />
      </SwipeableRow>
      <SelectedAddTaskButtons itemId={parent.item.id} depth={0} />
    </>
  );

  // Plain item with no actionable children.
  if (!hasChildren) {
    return <EntryShell grip={grip} topRow={parentRow} />;
  }

  // Flat: surface the available leaf actions only. If none are available, fall
  // back to the parent row so an item never silently vanishes.
  if (grouping === "flat") {
    if (leaves.length === 0) {
      return <EntryShell grip={grip} topRow={parentRow} />;
    }
    const [first, ...others] = leaves;
    return (
      <EntryShell
        grip={grip}
        topRow={leafRow(first)}
        rest={others.map(leafRow)}
      />
    );
  }

  // Nested: parent header with its available actions indented beneath.
  const collapsible = orderMode === "single" && leaves.length > 0;
  const showLeaves = collapsible ? expanded : true;
  const topRow = (
    <>
      <SwipeableRow item={parent.item}>
        <TaskRow
          {...parent}
          showProject
          focused={focused}
          collapsed={collapsible ? !expanded : undefined}
          onToggleCollapse={
            collapsible ? () => setExpanded((e) => !e) : undefined
          }
        />
      </SwipeableRow>
      <SelectedAddTaskButtons itemId={parent.item.id} depth={0} />
    </>
  );
  const rest = (
    <>
      {showLeaves && leaves.map(leafRow)}
      {collapsible && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="pl-9 text-left text-xs font-medium text-accent hover:underline"
        >
          Show {leaves.length} more
        </button>
      )}
    </>
  );
  return <EntryShell grip={grip} topRow={topRow} rest={rest} />;
});

/** A reorderable entry: same content, with a drag handle anchored to the top row. */
const SortableEntry = memo(function SortableEntry({
  entry,
  grouping,
  focused = false,
}: {
  entry: PlanEntry;
  grouping: "nested" | "flat";
  focused?: boolean;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({
      id: entry.parent.item.id,
    });
  // Whole-row press-and-hold drag (see `sensors` below): there is no visible
  // handle, so the row's pointer listeners are the drag affordance. A quick tap
  // still selects/opens the row; holding ~200ms lifts it for reordering.
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      data-row-id={entry.parent.item.id}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`select-none group/sortable ${isDragging ? "z-10 opacity-80" : ""}`}
    >
      <PlanEntryRows entry={entry} grouping={grouping} focused={focused} />
    </div>
  );
});

/** Renders a list of plan entries with the shared subtask-surfacing presentation.
 *  When `reorderable`, the top-level entries (parents) can be drag-sorted. */
/** Rows you can page past per PageUp/PageDown. */
const PAGE_STEP = 10;

export function PlanList({
  entries,
  reorderable = false,
}: {
  entries: PlanEntry[];
  reorderable?: boolean;
}) {
  const grouping = useStore((s) => s.uiPrefs.planGrouping);
  const select = useStore((s) => s.select);
  const openDetail = useStore((s) => s.openDetail);
  // Press-and-hold to drag: hold ~200ms to lift a row; moving >5px before then
  // is treated as a tap/scroll, not a drag. Lets the whole row be the handle.
  const sensors = useReorderSensors();

  // Keyboard focus over the top-level (parent) rows: ArrowUp/Down to move,
  // Home/End/PageUp/PageDown to jump, Space to complete, Enter to open. This is
  // what makes the flat list views (Today/Inbox/All) completable without a mouse.
  const containerRef = useRef<HTMLDivElement>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  useEffect(() => {
    if (!focusedId) return;
    containerRef.current
      ?.querySelector(`[data-row-id="${window.CSS.escape(focusedId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [focusedId]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (!entries.length) return;
    const ids = entries.map((en) => en.parent.item.id);
    const idx = focusedId ? ids.indexOf(focusedId) : -1;
    const at = (i: number) =>
      setFocusedId(ids[Math.max(0, Math.min(i, ids.length - 1))]!);

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        return at(idx < 0 ? 0 : idx + 1);
      case "ArrowUp":
        e.preventDefault();
        return at(idx < 0 ? 0 : idx - 1);
      case "Home":
        e.preventDefault();
        return at(0);
      case "End":
        e.preventDefault();
        return at(ids.length - 1);
      case "PageDown":
        e.preventDefault();
        return at((idx < 0 ? 0 : idx) + PAGE_STEP);
      case "PageUp":
        e.preventDefault();
        return at((idx < 0 ? 0 : idx) - PAGE_STEP);
      case " ": {
        if (idx < 0) return;
        e.preventDefault();
        return toggleTaskCompletion(entries[idx]!.parent.item);
      }
      case "Enter": {
        if (idx < 0) return;
        e.preventDefault();
        select(entries[idx]!.parent.item.id);
        if (e.ctrlKey || e.metaKey) openDetail();
        return;
      }
      default:
        return;
    }
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = entries.findIndex((d) => d.parent.item.id === active.id);
    const newIndex = entries.findIndex((d) => d.parent.item.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    const reordered = arrayMove(entries, oldIndex, newIndex);
    const prev = reordered[newIndex - 1]?.parent.item.sort_order;
    const next = reordered[newIndex + 1]?.parent.item.sort_order;
    let target: number;
    if (prev === undefined && next === undefined) target = 0;
    else if (prev === undefined) target = next! - 1;
    else if (next === undefined) target = prev + 1;
    else target = (prev + next) / 2;

    mutate((db, dev) => reorderItem(db, dev, String(active.id), target));
  }

  if (entries.length === 0) return null;

  if (!reorderable) {
    return (
      <div
        ref={containerRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        data-tasklist
        className="flex flex-col outline-none"
      >
        {entries.map((e) => (
          <div key={e.parent.item.id} data-row-id={e.parent.item.id}>
            <PlanEntryRows
              entry={e}
              grouping={grouping}
              focused={e.parent.item.id === focusedId}
            />
          </div>
        ))}
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis]}
      onDragEnd={onDragEnd}
    >
      <SortableContext
        items={entries.map((e) => e.parent.item.id)}
        strategy={verticalListSortingStrategy}
      >
        <div
          ref={containerRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          data-tasklist
          className="flex flex-col outline-none"
        >
          {entries.map((e) => (
            <SortableEntry
              key={e.parent.item.id}
              entry={e}
              grouping={grouping}
              focused={e.parent.item.id === focusedId}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

/** The Nested/Flat actions toggle, bound to the shared `planGrouping` UI pref.
 *  Reused standalone by Plan/Forecast and composed into the View row. */
export function GroupingToggle({ className }: { className?: string }) {
  const grouping = useStore((s) => s.uiPrefs.planGrouping);
  const setUiPrefs = useStore((s) => s.setUiPrefs);
  return (
    <div className={cn("flex items-center gap-1.5 text-xs", className)}>
      <span className="text-text-faint">List</span>
      <SegmentedControl<"nested" | "flat">
        value={grouping}
        onChange={(v) => setUiPrefs({ planGrouping: v })}
        segmentClassName="px-2.5"
        options={[
          { value: "nested", label: "Nested" },
          { value: "flat", label: "Flat" },
        ]}
      />
    </div>
  );
}
