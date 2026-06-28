import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { reorderItem, getChildren } from '@carbon/core';
import { useQuery } from '@/hooks/useQuery';
import { enrichItems } from '@/lib/enrich';
import { useStore } from '@/lib/store';
import { mutate } from '@/lib/mutate';
import { TaskRow, type TaskRowData } from './TaskRow';
import { SwipeableRow } from './SwipeableRow';

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
      (db) => enrichItems(db, getChildren(db, parentId).filter((c) => c.type === 'task')),
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
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: data.item.id,
  });
  const reveal = nestSubtasks && data.hasChildren;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group/sortable ${isDragging ? 'z-10 opacity-80' : ''}`}
    >
      {/* Handle is positioned relative to the top row only, so it stays put when
          the subtree is expanded below. */}
      <div className="relative">
        <button
          {...attributes}
          {...listeners}
          className="absolute left-0 top-1/2 z-10 -translate-y-1/2 cursor-grab p-0.5 text-text-faint opacity-0 group-hover/sortable:opacity-100"
          aria-label="Drag to reorder"
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical size={14} />
        </button>
        <SwipeableRow item={data.item}>
          <TaskRow
            {...data}
            showProject={showProject}
            collapsed={reveal ? !expanded : undefined}
            onToggleCollapse={reveal ? () => toggleExpanded(data.item.id) : undefined}
          />
        </SwipeableRow>
      </div>
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
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

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
