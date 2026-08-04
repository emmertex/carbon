import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { reorderItem, getChildren } from '@carbon/core';
import { useQuery } from '@/hooks/useQuery';
import { useReorderSensors } from '@/hooks/useReorderSensors';
import { enrichItems } from '@/lib/enrich';
import { useStore } from '@/lib/store';
import { mutate } from '@/lib/mutate';
import { TaskRow, type TaskRowData } from './TaskRow';
import { SwipeableRow } from './SwipeableRow';
import { SelectedAddTaskButtons } from './AddTaskButtons';

/** The revealed subtasks of `parentId`, indented one level deeper. Recurses so a
 *  subtask's own subtasks reveal in turn. Children are only queried while the
 *  parent is expanded, so collapsed subtrees cost nothing. */
function SubtaskRows({
  parentId,
  depth,
  showProject,
}: {
  parentId: string;
  depth: number;
  showProject: boolean;
}) {
  const rows =
    useQuery(
      (db) =>
        enrichItems(
          db,
          // Notes render inline in container/list views (icon, no checkbox).
          getChildren(db, parentId).filter((c) => c.type === 'task' || c.type === 'note'),
        ),
      [parentId],
    ) ?? [];
  if (rows.length === 0) return null;
  return (
    <>
      {rows.map((d) => (
        <NestedRow key={d.item.id} data={d} depth={depth} showProject={showProject} />
      ))}
    </>
  );
}

/** A revealed subtask row plus (when expanded) its own revealed subtasks. */
function NestedRow({
  data,
  depth,
  showProject,
}: {
  data: TaskRowData;
  depth: number;
  showProject: boolean;
}) {
  const expanded = useStore((s) => s.expanded.has(data.item.id));
  const toggleExpanded = useStore((s) => s.toggleExpanded);
  return (
    <>
      <SwipeableRow item={data.item}>
        <TaskRow
          {...data}
          showProject={showProject}
          indent={depth}
          collapsed={!expanded}
          onToggleCollapse={data.hasChildren ? () => toggleExpanded(data.item.id) : undefined}
        />
      </SwipeableRow>
      <SelectedAddTaskButtons itemId={data.item.id} depth={depth} />
      {expanded && data.hasChildren && (
        <SubtaskRows parentId={data.item.id} depth={depth + 1} showProject={showProject} />
      )}
    </>
  );
}

/** Top-level row chrome shared by the reorderable and static lists: the row itself,
 *  the collapse chevron, and (when expanded) its nested subtasks. */
function TopRow({
  data,
  showProject,
  nestSubtasks,
}: {
  data: TaskRowData;
  showProject: boolean;
  nestSubtasks: boolean;
}) {
  const expanded = useStore((s) => s.expanded.has(data.item.id));
  const toggleExpanded = useStore((s) => s.toggleExpanded);
  const reveal = nestSubtasks && data.hasChildren;
  return (
    <>
      <SwipeableRow item={data.item}>
        <TaskRow
          {...data}
          showProject={showProject}
          collapsed={reveal ? !expanded : undefined}
          onToggleCollapse={reveal ? () => toggleExpanded(data.item.id) : undefined}
        />
      </SwipeableRow>
      <SelectedAddTaskButtons itemId={data.item.id} depth={0} />
      {reveal && expanded && (
        <SubtaskRows parentId={data.item.id} depth={1} showProject={showProject} />
      )}
    </>
  );
}

function SortableRow({
  data,
  showProject,
  nestSubtasks,
}: {
  data: TaskRowData;
  showProject: boolean;
  nestSubtasks: boolean;
}) {
  const expanded = useStore((s) => s.expanded.has(data.item.id));
  const toggleExpanded = useStore((s) => s.toggleExpanded);
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: data.item.id,
  });
  const reveal = nestSubtasks && data.hasChildren;

  // Whole-row press-and-hold drag (see `sensors` below): no visible handle —
  // holding ~200ms lifts the row, a quick tap still selects it.
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`select-none group/sortable ${isDragging ? 'z-10 opacity-80' : ''}`}
    >
      <SwipeableRow item={data.item}>
        <TaskRow
          {...data}
          showProject={showProject}
          collapsed={reveal ? !expanded : undefined}
          onToggleCollapse={reveal ? () => toggleExpanded(data.item.id) : undefined}
        />
      </SwipeableRow>
      <SelectedAddTaskButtons itemId={data.item.id} depth={0} />
      {reveal && expanded && (
        <SubtaskRows parentId={data.item.id} depth={1} showProject={showProject} />
      )}
    </div>
  );
}

export function TaskList({
  items,
  showProject = false,
  reorderable = true,
  nestSubtasks = false,
}: {
  items: TaskRowData[];
  showProject?: boolean;
  reorderable?: boolean;
  /** Reveal each task's subtasks nested beneath it (collapsed by default). Used by
   *  the perspective list views; off for already-flattened lists. */
  nestSubtasks?: boolean;
}) {
  // Press-and-hold to drag: hold ~200ms to lift a row; moving >5px before then
  // is treated as a tap/scroll, not a drag. Lets the whole row be the handle.
  const sensors = useReorderSensors();

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = items.findIndex((d) => d.item.id === active.id);
    const newIndex = items.findIndex((d) => d.item.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    const reordered = arrayMove(items, oldIndex, newIndex);
    const prev = reordered[newIndex - 1]?.item.sort_order;
    const next = reordered[newIndex + 1]?.item.sort_order;
    let target: number;
    if (prev === undefined && next === undefined) target = 0;
    else if (prev === undefined) target = next! - 1;
    else if (next === undefined) target = prev + 1;
    else target = (prev + next) / 2;

    mutate((db, dev) => reorderItem(db, dev, String(active.id), target));
  }

  if (items.length === 0) return null;

  if (!reorderable) {
    return (
      <div className="flex flex-col">
        {items.map((d) => (
          <TopRow key={d.item.id} data={d} showProject={showProject} nestSubtasks={nestSubtasks} />
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
        items={items.map((d) => d.item.id)}
        strategy={verticalListSortingStrategy}
      >
        <div className="flex flex-col">
          {items.map((d) => (
            <SortableRow
              key={d.item.id}
              data={d}
              showProject={showProject}
              nestSubtasks={nestSubtasks}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
