import { useEffect, useRef, useState } from 'react';
import {
  DndContext,
  closestCenter,
  type DragStartEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  moveItem,
  getItemTags,
  listComments,
  deleteItem,
  reorderSibling,
  indentItem,
  outdentItem,
  createItem,
  createSiblingAfter,
  effectiveShares,
  isBlocked,
  type Item,
} from '@carbon/core';
import { useQuery } from '@/hooks/useQuery';
import { useReorderSensors } from '@/hooks/useReorderSensors';
import { isCompactViewport } from '@/hooks/useCompact';
import { itemAssignees } from '@/lib/enrich';
import { mutate } from '@/lib/mutate';
import { useStore, getCurrentUserId } from '@/lib/store';
import { toggleTaskCompletion } from '@/lib/taskActions';
import { applyFilters } from '@/lib/filter';
import { makeEvalCtx, evalExpr, type FilterExpr } from '@/lib/filter-expr';
import { updateFromQuickAdd } from '@/lib/quickadd';
import type { Filters } from '@/lib/views';
import { TaskRow } from './TaskRow';
import { SwipeableRow } from './SwipeableRow';
import { AddTaskButtons } from './AddTaskButtons';
import { useTokenSuggest, SuggestionMenu } from './TokenSuggest';
import {
  flattenTree,
  removeDescendants,
  getProjection,
  computeSortOrder,
} from '@/lib/tree';

interface EditProps {
  focused: boolean;
  editing: boolean;
  editText: string;
  onEditChange: (v: string) => void;
  onEditKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onEditBlur: (e: React.FocusEvent<HTMLInputElement>) => void;
}

/** The outliner's inline edit field, with the same `#tag`/`@user`/`!priority`
 *  autocomplete as the quick-add box. The menu's nav keys take precedence; other
 *  keys fall through to the outliner's edit handler (Enter/Tab/Backspace/Escape). */
function TreeEditInput({
  value,
  onEditChange,
  onEditKeyDown,
  onEditBlur,
}: {
  value: string;
  onEditChange: (v: string) => void;
  onEditKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onEditBlur: (e: React.FocusEvent<HTMLInputElement>) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const suggest = useTokenSuggest({ value, setValue: onEditChange, inputRef });
  return (
    <span className="relative min-w-0 flex-1">
      <input
        ref={inputRef}
        autoFocus
        value={value}
        onChange={(e) => {
          onEditChange(e.target.value);
          suggest.onValueChange(e.currentTarget);
        }}
        onKeyDown={(e) => {
          if (suggest.onKeyDown(e)) return;
          onEditKeyDown(e);
        }}
        onKeyUp={(e) => suggest.syncCaret(e.currentTarget)}
        onBlur={onEditBlur}
        onClick={(e) => {
          e.stopPropagation();
          suggest.syncCaret(e.currentTarget);
        }}
        className="w-full rounded border border-accent bg-surface px-1 py-0.5 text-sm outline-none"
      />
      <SuggestionMenu
        open={suggest.open}
        suggestions={suggest.suggestions}
        active={suggest.active}
        trigger={suggest.token?.trigger}
        onChoose={suggest.choose}
      />
    </span>
  );
}

function SortableTreeRow({
  item,
  depth,
  collapsible,
  kbMode,
  edit,
  onAddSibling,
  onAddSubtask,
}: {
  item: Item;
  depth: number;
  collapsible: boolean;
  kbMode: boolean;
  edit: EditProps;
  onAddSibling: (afterId: string) => void;
  onAddSubtask: (parentId: string) => void;
}) {
  const tags = useQuery((db) => getItemTags(db, item.id), [item.id]) ?? [];
  const assignees = useQuery((db) => itemAssignees(db, item.id), [item.id]) ?? [];
  const hasComments = useQuery((db) => listComments(db, item.id).length > 0, [item.id]) ?? false;
  const shared = useQuery((db) => effectiveShares(db, item.id).length > 0, [item.id]) ?? false;
  const blocked =
    useQuery(
      (db) => item.status === 'active' && isBlocked(db, item.id),
      [item.id, item.status, item.parent_id],
    ) ?? false;
  const collapsed = useStore((s) => s.collapsed.has(item.id));
  const toggleCollapsed = useStore((s) => s.toggleCollapsed);
  const selected = useStore((s) => s.selectedId === item.id);
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  });

  const titleSlot = edit.editing ? (
    <TreeEditInput
      value={edit.editText}
      onEditChange={edit.onEditChange}
      onEditKeyDown={edit.onEditKeyDown}
      onEditBlur={edit.onEditBlur}
    />
  ) : undefined;

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      data-row-id={item.id}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group/tree relative select-none ${isDragging ? 'z-10 opacity-50' : ''}`}
    >
      <SwipeableRow item={item}>
        <TaskRow
          item={item}
          tags={tags}
          assignees={assignees}
          hasComments={hasComments}
          shared={shared}
          blocked={blocked}
          indent={depth}
          collapsed={collapsed}
          onToggleCollapse={collapsible ? () => toggleCollapsed(item.id) : undefined}
          focused={edit.focused}
          titleSlot={titleSlot}
        />
      </SwipeableRow>
      {selected && !edit.editing && !kbMode && !isDragging && (
        <AddTaskButtons
          depth={depth}
          onAddSibling={() => onAddSibling(item.id)}
          onAddSubtask={() => onAddSubtask(item.id)}
        />
      )}
    </div>
  );
}

/** A drag-reorderable, drag-to-nest tree of a container's descendants.
 *  When `filters` is given, non-matching nodes are hidden but their matching
 *  descendants' ancestors are kept, so the hierarchy stays intact. */
export function TaskTree({
  rootId,
  filters,
  expr,
}: {
  rootId: string;
  filters?: Filters;
  expr?: FilterExpr | null;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [offsetLeft, setOffsetLeft] = useState(0);

  const flat =
    useQuery(
      (db) => {
        const all = flattenTree(db, rootId);
        // Advanced mode (expr) takes precedence; else basic filters; else show all.
        const matchIds = expr
          ? (() => {
              const ctx = makeEvalCtx(db);
              return new Set(all.filter((f) => evalExpr(ctx, f.item, expr)).map((f) => f.id));
            })()
          : filters
            ? new Set(applyFilters(db, all.map((f) => f.item), filters).map((i) => i.id))
            : null;
        if (!matchIds) return all;
        const byId = new Map(all.map((f) => [f.id, f.item]));
        const keep = new Set<string>();
        for (const f of all) {
          if (!matchIds.has(f.id)) continue;
          keep.add(f.id);
          let pid = f.item.parent_id; // keep ancestors for context
          while (pid && byId.has(pid)) {
            keep.add(pid);
            pid = byId.get(pid)!.parent_id;
          }
        }
        return all.filter((f) => keep.has(f.id));
      },
      [rootId, filters ? JSON.stringify(filters) : '', expr ? JSON.stringify(expr) : ''],
    ) ?? [];
  const collapsedSet = useStore((s) => s.collapsed);
  // Nodes with children (for the collapse chevron).
  const hasKids = new Set<string>();
  for (const f of flat) if (f.parentId) hasKids.add(f.parentId);
  // Hide descendants of any collapsed node (flat is pre-order).
  const collapseHidden = new Set<string>();
  for (const f of flat) {
    if (f.parentId && (collapsedSet.has(f.parentId) || collapseHidden.has(f.parentId))) {
      collapseHidden.add(f.id);
    }
  }
  const shown = flat.filter((f) => !collapseHidden.has(f.id));
  const visible = activeId ? removeDescendants(shown, activeId) : shown;
  const projected =
    activeId && overId ? getProjection(visible, rootId, activeId, overId, offsetLeft) : null;

  // ----- keyboard outliner (tree only) --------------------------------------
  const select = useStore((s) => s.select);
  const openDetail = useStore((s) => s.openDetail);
  const toggleCollapsed = useStore((s) => s.toggleCollapsed);
  const containerRef = useRef<HTMLDivElement>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  // Keyboard mode hides the mouse "add below" box (which autofocuses) so it can't
  // steal navigation focus.
  const [kbMode, setKbMode] = useState(false);
  // A freshly-created empty task that the user hasn't typed into yet. Typing
  // confirms it (and opens its detail); cancelling discards it and restores the
  // task that was selected before it was created.
  const [pendingNewId, setPendingNewId] = useState<string | null>(null);
  const [returnToId, setReturnToId] = useState<string | null>(null);

  const idxOf = (id: string | null) => visible.findIndex((f) => f.id === id);
  const wideEnough = () => !isCompactViewport();

  // Keep the keyboard-focused row in view.
  useEffect(() => {
    if (!focusedId) return;
    containerRef.current
      ?.querySelector(`[data-row-id="${window.CSS.escape(focusedId)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [focusedId]);

  function focusRow(id: string | null) {
    setFocusedId(id);
    if (id && wideEnough()) select(id); // sync/open the docked detail pane
  }

  function startEdit(id: string) {
    const f = visible.find((v) => v.id === id);
    if (!f) return;
    setEditingId(id);
    setEditText(f.item.title);
  }

  /** Create a new empty task and drop into inline edit (the outliner's nicer
   *  new-task visual). */
  function beginNew(created: Item) {
    setKbMode(false);
    setEditingId(created.id);
    setEditText('');
    setFocusedId(created.id);
    setPendingNewId(created.id);
    setReturnToId(useStore.getState().selectedId);
  }
  function addSibling(afterId: string) {
    beginNew(mutate((db, dev) => createSiblingAfter(db, dev, afterId, getCurrentUserId())));
  }
  function addSubtask(parentId: string) {
    if (collapsedSet.has(parentId)) toggleCollapsed(parentId); // reveal the new child
    beginNew(
      mutate((db, dev) => createItem(db, dev, { title: '', parentId, ownerId: getCurrentUserId() })),
    );
  }

  /** First keystroke in a brand-new task confirms it: it's no longer "pending"
   *  (so cancelling later won't discard it) and we reveal its detail pane. */
  function onEditTextChange(v: string) {
    setEditText(v);
    if (pendingNewId && editingId === pendingNewId && v.trim() !== '') {
      const id = pendingNewId;
      setPendingNewId(null);
      setReturnToId(null);
      select(id); // opens the docked right-hand detail pane on desktop
    }
  }

  /** If `id` is an untouched new task, drop it and restore the prior selection.
   *  Returns true if it handled the cancel. */
  function discardIfPending(id: string): boolean {
    if (id !== pendingNewId || editText.trim() !== '') return false;
    const back = returnToId;
    mutate((db, dev) => deleteItem(db, dev, id));
    setPendingNewId(null);
    setReturnToId(null);
    setEditingId((cur) => (cur === id ? null : cur));
    setFocusedId(back && visible.some((v) => v.id === back) ? back : null);
    if (back) select(back);
    containerRef.current?.focus();
    return true;
  }

  /** Commit a row's typed value on blur; only clear edit if still on that row. */
  function onRowBlur(rowId: string, e: React.FocusEvent<HTMLInputElement>) {
    if (discardIfPending(rowId)) return;
    const value = e.target.value;
    mutate((db, dev) => updateFromQuickAdd(db, dev, rowId, value.trim()));
    setEditingId((cur) => (cur === rowId ? null : cur));
  }

  function onContainerClick(e: React.MouseEvent) {
    setKbMode(false);
    const tag = (e.target as HTMLElement).tagName;
    if (['INPUT', 'TEXTAREA', 'BUTTON', 'SELECT', 'A'].includes(tag) || editingId) return;
    containerRef.current?.focus();
    const sel = useStore.getState().selectedId;
    if (sel && visible.some((f) => f.id === sel)) setFocusedId(sel);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (editingId) return; // the edit input handles its own keys
    setKbMode(true);
    const idx = idxOf(focusedId);
    const cur = idx >= 0 ? visible[idx] : null;
    const mod = e.altKey || e.shiftKey;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!cur) return focusRow(visible[0]?.id ?? null);
        if (mod) return mutate((db, dev) => reorderSibling(db, dev, cur.id, 1));
        return focusRow(visible[Math.min(idx + 1, visible.length - 1)]!.id);
      case 'ArrowUp':
        e.preventDefault();
        if (!cur) return focusRow(visible[0]?.id ?? null);
        if (mod) return mutate((db, dev) => reorderSibling(db, dev, cur.id, -1));
        return focusRow(visible[Math.max(idx - 1, 0)]!.id);
      case 'ArrowLeft':
        if (cur && hasKids.has(cur.id) && !collapsedSet.has(cur.id)) {
          e.preventDefault();
          toggleCollapsed(cur.id);
        }
        return;
      case 'ArrowRight':
        if (cur && hasKids.has(cur.id) && collapsedSet.has(cur.id)) {
          e.preventDefault();
          toggleCollapsed(cur.id);
        }
        return;
      case 'Tab':
        if (!cur) return;
        e.preventDefault();
        return mutate((db, dev) =>
          e.shiftKey ? outdentItem(db, dev, cur.id, rootId) : indentItem(db, dev, cur.id),
        );
      case 'Enter':
        if (!cur) return;
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          select(cur.id);
          openDetail();
          return;
        }
        return startEdit(cur.id);
      case ' ': {
        if (!cur) return;
        e.preventDefault();
        toggleTaskCompletion(cur.item);
        return;
      }
      case 'Home':
        e.preventDefault();
        return focusRow(visible[0]?.id ?? null);
      case 'End':
        e.preventDefault();
        return focusRow(visible[visible.length - 1]?.id ?? null);
      case 'PageDown':
        e.preventDefault();
        return focusRow(visible[Math.min((idx < 0 ? 0 : idx) + 10, visible.length - 1)]?.id ?? null);
      case 'PageUp':
        e.preventDefault();
        return focusRow(visible[Math.max((idx < 0 ? 0 : idx) - 10, 0)]?.id ?? null);
      default:
        return;
    }
  }

  function onEditKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    e.stopPropagation();
    const id = editingId!;
    if (e.key === 'Enter') {
      e.preventDefault();
      // Empty pending row: discard instead of committing "Untitled" and spawning another.
      if (id === pendingNewId && editText.trim() === '') {
        discardIfPending(id);
        return;
      }
      const created = mutate((db, dev) => {
        updateFromQuickAdd(db, dev, id, editText.trim());
        return createSiblingAfter(db, dev, id, getCurrentUserId());
      });
      // Treat Enter-created siblings like beginNew so Escape can discard blanks.
      setPendingNewId(created.id);
      setReturnToId(id);
      setEditingId(created.id);
      setFocusedId(created.id);
      setEditText('');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (discardIfPending(id)) return;
      setEditingId(null);
      containerRef.current?.focus();
    } else if (e.key === 'Backspace' && editText === '') {
      e.preventDefault();
      const idx = idxOf(id);
      const prev = idx > 0 ? visible[idx - 1] : undefined;
      mutate((db, dev) => deleteItem(db, dev, id));
      setPendingNewId((cur) => (cur === id ? null : cur));
      setEditingId(null);
      setFocusedId(prev?.id ?? null);
      containerRef.current?.focus();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      mutate((db, dev) => {
        updateFromQuickAdd(db, dev, id, editText.trim());
        if (e.shiftKey) outdentItem(db, dev, id, rootId);
        else indentItem(db, dev, id);
      });
    }
  }

  // Press-and-hold to drag: hold ~200ms to lift a row (reorder or nest); moving
  // >5px before then is a tap/scroll. The whole row is the handle — no grip.
  const sensors = useReorderSensors();

  function reset() {
    setActiveId(null);
    setOverId(null);
    setOffsetLeft(0);
  }

  function onDragStart({ active }: DragStartEvent) {
    setActiveId(String(active.id));
    setOverId(String(active.id));
  }
  function onDragMove({ delta }: DragMoveEvent) {
    setOffsetLeft(delta.x);
  }
  function onDragOver({ over }: DragOverEvent) {
    setOverId(over ? String(over.id) : null);
  }
  function onDragEnd({ active, over }: DragEndEvent) {
    const items = visible;
    const off = offsetLeft;
    reset();
    if (!over) return;
    const proj = getProjection(items, rootId, String(active.id), String(over.id), off);
    const sortOrder = computeSortOrder(items, String(active.id), String(over.id), proj.parentId);
    mutate((db, dev) => moveItem(db, dev, String(active.id), proj.parentId, sortOrder));
  }

  if (flat.length === 0) return null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={reset}
    >
      <SortableContext items={visible.map((f) => f.id)} strategy={verticalListSortingStrategy}>
        <div
          ref={containerRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onClick={onContainerClick}
          className="flex flex-col outline-none"
        >
          {visible.map((f) => (
            <SortableTreeRow
              key={f.id}
              item={f.item}
              depth={f.id === activeId && projected ? projected.depth : f.depth}
              collapsible={hasKids.has(f.id)}
              kbMode={kbMode}
              edit={{
                focused: focusedId === f.id,
                editing: editingId === f.id,
                editText,
                onEditChange: onEditTextChange,
                onEditKeyDown,
                onEditBlur: (e) => onRowBlur(f.id, e),
              }}
              onAddSibling={addSibling}
              onAddSubtask={addSubtask}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
