import { useEffect, useState } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import {
  Sun,
  Inbox as InboxIcon,
  Flag,
  Eye,
  Plus,
  Settings,
  Tag as TagIcon,
  Folder,
  FolderOpen,
  FolderPlus,
  Layers,
  Bookmark,
  Users,
  CalendarRange,
  MapPin,
  Target,
  Clock,
  Pencil,
  Trash2,
  ChevronRight,
  X,
  Undo2,
  Redo2,
} from 'lucide-react';
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  allItems,
  inbox,
  today,
  flagged,
  getProjects,
  getFolders,
  needsReview,
  createItem,
  updateItem,
  reorderItem,
  moveProjectToFolder,
  deleteFolder,
  subtaskProgress,
  isOverdue,
  sharedRoots,
  tasksNearLocation,
  listTags,
  tagCounts,
  effectiveTagColor,
  createTag,
  moveTag,
  reorderTag,
  tagId,
  listPlan,
  getItem,
  type Item,
  type OrderMode,
} from '@carbon/core';
import { queryRoots } from '@/lib/listQuery';
import { buildTagTree, flattenTagTree, type TagNode } from '@/lib/tagTree';
import { useReorderSensors } from '@/hooks/useReorderSensors';
import { TagMark } from './TagMark';
import { useDeferredQuery } from '@/hooks/useQuery';
import { useWhere } from '@/hooks/useWhere';
import { useFeature } from '@/hooks/useFeature';
import { undo, redo } from '@/lib/undo';
import { useStore, getCurrentUserId } from '@/lib/store';
import { mutate } from '@/lib/mutate';
import { cn } from '@/lib/cn';
import {
  getPerspectives,
  removePerspective,
  reorderPerspectives,
  type SavedPerspective,
} from '@/lib/views';
import { buildFolderRows, rowGroup, targetGroupAt, type FolderRow } from '@/lib/folderTree';
import { ColorSwatches } from './ColorSwatches';
import { ProjectGlyph } from './ProjectGlyph';
import { SyncIndicator } from './SyncIndicator';
import { ThemeToggle } from './ThemeToggle';

function NavItem({
  to,
  icon,
  label,
  count,
  onClick,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  count?: number;
  onClick?: () => void;
}) {
  return (
    <NavLink
      to={to}
      onClick={onClick}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors',
          isActive
            ? 'bg-accent-soft text-accent'
            : 'text-text-muted hover:bg-surface-2 hover:text-text',
        )
      }
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {count !== undefined && count > 0 && (
        <span className="text-xs tabular-nums text-text-faint">{count}</span>
      )}
    </NavLink>
  );
}

/** Inline rename + colour + delete panel for a folder, shown beneath its row. */
function FolderEditor({ folder, onClose }: { folder: Item; onClose: () => void }) {
  const [name, setName] = useState(folder.title || '');
  const commitName = () => {
    const next = name.trim() || 'Folder';
    if (next !== folder.title) mutate((db, dev) => updateItem(db, dev, folder.id, { title: next }));
  };
  return (
    <div
      className="mb-1 ml-6 mr-2 rounded-lg border border-border bg-surface-2 p-2"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commitName();
            onClose();
          } else if (e.key === 'Escape') {
            onClose();
          }
        }}
        placeholder="Folder name"
        className="mb-2 w-full rounded border border-border bg-surface px-2 py-1 text-sm"
      />
      <ColorSwatches
        value={folder.color}
        onChange={(c) => mutate((db, dev) => updateItem(db, dev, folder.id, { color: c }))}
      />
      <div className="mt-2 flex items-center justify-between">
        <button
          type="button"
          onClick={() => {
            mutate((db, dev) => deleteFolder(db, dev, folder.id));
            onClose();
          }}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-danger hover:bg-surface"
        >
          <Trash2 size={13} /> Delete
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-2 py-1 text-xs text-text-muted hover:bg-surface"
        >
          Done
        </button>
      </div>
    </div>
  );
}

function SidebarRow({
  row,
  editing,
  onToggleCollapse,
  onOpenProject,
  onEditFolder,
  onCloseEditor,
}: {
  row: FolderRow;
  editing: boolean;
  onToggleCollapse: (id: string) => void;
  onOpenProject: () => void;
  onEditFolder: (id: string) => void;
  onCloseEditor: () => void;
}) {
  const collapsedSet = useStore((s) => s.collapsed);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row.id,
  });
  const draggable = row.kind !== 'empty-folder-slot';

  // Whole-row press-and-hold drag (matches the task list): no visible handle —
  // holding ~200ms lifts the row, a quick tap still opens/toggles it. Reliable on
  // touch where a tiny grip target was not.
  return (
    <div
      ref={setNodeRef}
      {...(draggable ? attributes : {})}
      {...(draggable ? listeners : {})}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'group/srow relative flex select-none items-start',
        isDragging && 'z-10 opacity-80',
      )}
    >
      <div className="min-w-0 flex-1" style={{ paddingLeft: `${row.depth * 0.9}rem` }}>
        {row.kind === 'folder' && row.item && (
          <>
            <div className="group/folder flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-text-muted hover:bg-surface-2">
              <button
                type="button"
                onClick={() => onToggleCollapse(row.id)}
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                aria-label={collapsedSet.has(row.id) ? 'Expand' : 'Collapse'}
              >
                <span className="shrink-0">
                  {collapsedSet.has(row.id) ? (
                    <Folder
                      size={17}
                      style={row.item.color ? { color: row.item.color } : undefined}
                    />
                  ) : (
                    <FolderOpen
                      size={17}
                      style={row.item.color ? { color: row.item.color } : undefined}
                    />
                  )}
                </span>
                <span className="flex-1 truncate">{row.item.title || 'Folder'}</span>
              </button>
              {row.open > 0 && (
                <span className="text-xs tabular-nums text-text-faint">{row.open}</span>
              )}
              <button
                type="button"
                onClick={() => onEditFolder(row.id)}
                className="rounded p-0.5 text-text-faint opacity-0 hover:text-text group-hover/folder:opacity-100"
                aria-label="Edit folder"
              >
                <Pencil size={13} />
              </button>
            </div>
            {editing && <FolderEditor folder={row.item} onClose={onCloseEditor} />}
          </>
        )}

        {row.kind === 'project' && row.item && (
          <NavLink
            to={`/project/${row.item.id}`}
            onClick={onOpenProject}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-accent-soft text-accent'
                  : 'text-text-muted hover:bg-surface-2 hover:text-text',
              )
            }
          >
            <span className="shrink-0">
              <ProjectGlyph mode={row.item.order_mode} size={17} color={row.item.color} />
            </span>
            <span className="flex-1 truncate">{row.item.title || 'Untitled project'}</span>
            {row.open > 0 && (
              <span className="text-xs tabular-nums text-text-faint">{row.open}</span>
            )}
          </NavLink>
        )}

        {row.kind === 'empty-folder-slot' && (
          <p className="px-2.5 py-1 text-xs italic text-text-faint">Drop projects here</p>
        )}
      </div>
    </div>
  );
}

function ProjectsSection() {
  const navigate = useNavigate();
  const select = useStore((s) => s.select);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const collapsed = useStore((s) => s.collapsed);
  const toggleCollapsed = useStore((s) => s.toggleCollapsed);
  const countScope = useStore((s) => s.uiPrefs.countScope);
  const close = () => setSidebarOpen(false);

  const [menuOpen, setMenuOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const data = useDeferredQuery(
    (db) => {
      const projects = getProjects(db);
      const folders = getFolders(db);
      const openById: Record<string, number> = {};
      for (const p of projects) {
        const { done, total } = subtaskProgress(db, p.id, countScope);
        openById[p.id] = total - done;
      }
      return { projects, folders, openById };
    },
    [countScope],
  );

  const rows = data ? buildFolderRows(data.folders, data.projects, data.openById, collapsed) : [];

  // Press-and-hold to drag (~200ms), matching every other list in the app. A
  // quick tap/scroll (moving >5px before the delay) is never treated as a drag.
  const sensors = useReorderSensors();

  function createProject(mode: OrderMode) {
    const project = mutate((db, dev) =>
      createItem(db, dev, {
        type: 'project',
        title: 'New Project',
        ownerId: getCurrentUserId(),
        orderMode: mode,
      }),
    );
    setMenuOpen(false);
    navigate(`/project/${project.id}`);
    select(project.id);
    close();
  }

  function createFolder() {
    const folder = mutate((db, dev) =>
      createItem(db, dev, { type: 'folder', title: 'New Folder', ownerId: getCurrentUserId() }),
    );
    setMenuOpen(false);
    setEditingId(folder.id); // open the inline editor so it can be named right away
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = rows.findIndex((r) => r.id === active.id);
    const overIndex = rows.findIndex((r) => r.id === over.id);
    if (oldIndex < 0 || overIndex < 0) return;
    const activeRow = rows[oldIndex]!;
    if (!activeRow.item) return; // slots aren't draggable

    const reordered = arrayMove(rows, oldIndex, overIndex);
    const newIndex = reordered.findIndex((r) => r.id === active.id);

    // Folders only ever live at the top level (no nested folders).
    let group = targetGroupAt(reordered, newIndex, collapsed);
    if (activeRow.kind === 'folder') group = null;

    // sort_order = midpoint of same-group neighbours around the new slot.
    let prev: number | undefined;
    let next: number | undefined;
    for (let i = newIndex - 1; i >= 0; i--) {
      const r = reordered[i]!;
      if (r.id === active.id || !r.item) continue;
      if (rowGroup(r) === group) {
        prev = r.item.sort_order;
        break;
      }
    }
    for (let i = newIndex + 1; i < reordered.length; i++) {
      const r = reordered[i]!;
      if (r.id === active.id || !r.item) continue;
      if (rowGroup(r) === group) {
        next = r.item.sort_order;
        break;
      }
    }
    let target: number;
    if (prev === undefined && next === undefined) target = 0;
    else if (prev === undefined) target = next! - 1;
    else if (next === undefined) target = prev + 1;
    else target = (prev + next) / 2;

    const id = String(active.id);
    if (activeRow.kind === 'project' && group !== (activeRow.item.folder_id ?? null)) {
      mutate((db, dev) => moveProjectToFolder(db, dev, id, group, target));
    } else {
      mutate((db, dev) => reorderItem(db, dev, id, target));
    }
  }

  const menuItemCls =
    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-surface-2';

  return (
    <>
      <div className="mt-5 flex items-center justify-between px-4 pb-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-faint">
          Projects
        </span>
        <div className="relative">
          <button
            className="rounded p-1 text-text-faint hover:bg-surface-2 hover:text-text"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="New folder or project"
          >
            <Plus size={15} />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-full z-50 mt-1 w-56 rounded-lg border border-border bg-surface p-1 text-sm shadow-lg">
                <button type="button" className={menuItemCls} onClick={createFolder}>
                  <FolderPlus size={15} className="text-text-faint" />
                  New Folder
                </button>
                <button
                  type="button"
                  className={menuItemCls}
                  onClick={() => createProject('parallel')}
                >
                  <ProjectGlyph mode="parallel" size={15} />
                  New Parallel Project
                </button>
                <button
                  type="button"
                  className={menuItemCls}
                  onClick={() => createProject('sequential')}
                >
                  <ProjectGlyph mode="sequential" size={15} />
                  New Sequential Project
                </button>
                <button
                  type="button"
                  className={menuItemCls}
                  onClick={() => createProject('single')}
                >
                  <ProjectGlyph mode="single" size={15} />
                  New Single Action Project
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="px-2.5">
        {rows.length === 0 && (
          <p className="px-2.5 py-1 text-xs text-text-faint">No projects yet</p>
        )}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={rows.map((r) => r.id)} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col">
              {rows.map((row) => (
                <SidebarRow
                  key={row.id}
                  row={row}
                  editing={editingId === row.id}
                  onToggleCollapse={toggleCollapsed}
                  onOpenProject={close}
                  onEditFolder={(id) => setEditingId((cur) => (cur === id ? null : id))}
                  onCloseEditor={() => setEditingId(null)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>
    </>
  );
}

/** One draggable tag row in the sidebar tag tree. */
function TagRow({ node, onOpen }: { node: TagNode; onOpen: (id: string) => void }) {
  const collapsed = useStore((s) => s.collapsed);
  const toggleCollapsed = useStore((s) => s.toggleCollapsed);
  const selectedId = useStore((s) => s.selectedId);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: node.tag.id,
  });
  const hasChildren = node.children.length > 0;
  const onHold = node.tag.status === 'on-hold';
  const active = selectedId === node.tag.id;

  // Whole-row press-and-hold drag (matches the task list): hold ~200ms to lift,
  // a quick tap still opens the tag or toggles its collapse.
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'group/trow relative flex select-none items-start',
        isDragging && 'z-10 opacity-80',
      )}
    >
      <div className="min-w-0 flex-1" style={{ paddingLeft: `${node.depth * 0.9}rem` }}>
        <div
          className={cn(
            'flex items-center gap-1 rounded-lg pr-2 text-sm font-medium transition-colors',
            active
              ? 'bg-accent-soft text-accent'
              : 'text-text-muted hover:bg-surface-2 hover:text-text',
          )}
        >
          <button
            type="button"
            onClick={() => toggleCollapsed(node.tag.id)}
            className={cn(
              'flex h-7 w-5 shrink-0 items-center justify-center text-text-faint',
              !hasChildren && 'invisible',
            )}
            aria-label={collapsed.has(node.tag.id) ? 'Expand' : 'Collapse'}
          >
            <ChevronRight
              size={14}
              className={cn('transition-transform', !collapsed.has(node.tag.id) && 'rotate-90')}
            />
          </button>
          <button
            type="button"
            onClick={() => onOpen(node.tag.id)}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left"
          >
            <TagMark color={node.tag.color} />
            <span className={cn('flex-1 truncate', onHold && 'italic text-text-faint')}>
              {node.leaf}
            </span>
            {node.rollupCount > 0 && (
              <span className="text-xs tabular-nums text-text-faint">{node.rollupCount}</span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function TagsSection() {
  const navigate = useNavigate();
  const select = useStore((s) => s.select);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const collapsed = useStore((s) => s.collapsed);
  const close = () => setSidebarOpen(false);

  const data = useDeferredQuery((db) => {
    const tags = listTags(db);
    // Resolve display colour (own or inherited) so nested tags show their parent's hue.
    const resolved = tags.map((t) => ({ ...t, color: effectiveTagColor(db, t.name) }));
    return { roots: buildTagTree(resolved, tagCounts(db)) };
  }, []);

  const flat = data ? flattenTagTree(data.roots, collapsed) : [];

  // Press-and-hold to drag (~200ms), matching the task list and Projects.
  const sensors = useReorderSensors();

  function openTag(id: string) {
    select(id, 'tag');
    navigate(`/tag/${id}`);
    close();
  }

  function addTag() {
    const tag = mutate((db, dev) => createTag(db, dev, 'New tag'));
    openTag(tag.id);
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = flat.findIndex((n) => n.tag.id === active.id);
    const overIndex = flat.findIndex((n) => n.tag.id === over.id);
    if (oldIndex < 0 || overIndex < 0) return;
    const activeNode = flat[oldIndex]!;

    const reordered = arrayMove(flat, oldIndex, overIndex);
    const newIndex = reordered.findIndex((n) => n.tag.id === active.id);

    // Target parent path is taken from the row directly above the new slot: an
    // expanded parent means "drop inside it"; otherwise share that row's parent.
    const above = newIndex > 0 ? reordered[newIndex - 1] : null;
    let parentPath: string;
    if (!above) parentPath = '';
    else if (above.children.length && !collapsed.has(above.tag.id)) parentPath = above.tag.name;
    else parentPath = above.parentPath;

    // Never nest a tag inside itself or one of its own descendants.
    if (parentPath === activeNode.tag.name || parentPath.startsWith(activeNode.tag.name + ':')) {
      return;
    }

    // sort_order = midpoint of same-parent neighbours around the new slot.
    let prev: number | undefined;
    let next: number | undefined;
    for (let i = newIndex - 1; i >= 0; i--) {
      const n = reordered[i]!;
      if (n.tag.id === activeNode.tag.id) continue;
      if (n.parentPath === parentPath) {
        prev = n.tag.sort_order;
        break;
      }
    }
    for (let i = newIndex + 1; i < reordered.length; i++) {
      const n = reordered[i]!;
      if (n.tag.id === activeNode.tag.id) continue;
      if (n.parentPath === parentPath) {
        next = n.tag.sort_order;
        break;
      }
    }
    let target: number;
    if (prev === undefined && next === undefined) target = 0;
    else if (prev === undefined) target = next! - 1;
    else if (next === undefined) target = prev + 1;
    else target = (prev + next) / 2;

    const id = String(active.id);
    if (parentPath !== activeNode.parentPath) {
      // Reparent = rename the colon path (and the whole subtree); then place it.
      const newName = parentPath ? `${parentPath}:${activeNode.leaf}` : activeNode.leaf;
      mutate((db, dev) => {
        moveTag(db, dev, id, newName);
        reorderTag(db, dev, tagId(newName), target);
      });
    } else {
      mutate((db, dev) => reorderTag(db, dev, id, target));
    }
  }

  return (
    <>
      <div className="mt-5 flex items-center justify-between px-4 pb-1">
        <button
          onClick={() => {
            navigate('/tags');
            close();
          }}
          className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-text-faint hover:text-text"
        >
          <TagIcon size={12} /> Tags
        </button>
        <button
          className="rounded p-1 text-text-faint hover:bg-surface-2 hover:text-text"
          onClick={addTag}
          aria-label="New tag"
        >
          <Plus size={15} />
        </button>
      </div>

      <div className="px-2.5 pb-2">
        {flat.length === 0 && <p className="px-2.5 py-1 text-xs text-text-faint">No tags yet</p>}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={flat.map((n) => n.tag.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="flex flex-col">
              {flat.map((node) => (
                <TagRow key={node.tag.id} node={node} onOpen={openTag} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>
    </>
  );
}

/** Undo / redo controls, disabled when the respective stack is empty. */
function UndoButtons() {
  const undoCount = useStore((s) => s.undoCount);
  const redoCount = useStore((s) => s.redoCount);
  return (
    <>
      <button
        onClick={() => undo()}
        disabled={undoCount === 0}
        className="rounded-lg p-2 text-text-muted hover:bg-surface-2 hover:text-text disabled:opacity-30"
        aria-label="Undo"
        title="Undo (Ctrl+Z)"
      >
        <Undo2 size={17} />
      </button>
      <button
        onClick={() => redo()}
        disabled={redoCount === 0}
        className="rounded-lg p-2 text-text-muted hover:bg-surface-2 hover:text-text disabled:opacity-30"
        aria-label="Redo"
        title="Redo (Ctrl+Shift+Z)"
      >
        <Redo2 size={17} />
      </button>
    </>
  );
}

/** One draggable perspective row. The delete button only exists while this
 *  perspective is the open view — and when it does, it stays fully visible
 *  (no hover reveal) so it is reachable on touch. */
function PerspectiveRow({
  p,
  selected,
  count,
  onOpen,
  onDelete,
}: {
  p: SavedPerspective;
  selected: boolean;
  count?: number;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: p.id,
  });
  // Whole-row press-and-hold drag, matching the projects/tags lists.
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('relative select-none', isDragging && 'z-10 opacity-80')}
    >
      <NavLink
        to={`/view/${p.id}`}
        onClick={onOpen}
        className={({ isActive }) =>
          cn(
            'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors',
            isActive
              ? 'bg-accent-soft text-accent'
              : 'text-text-muted hover:bg-surface-2 hover:text-text',
            // leave room for the delete button so long names don't slide under it
            selected && 'pr-9',
          )
        }
      >
        <span className="shrink-0">
          <Bookmark size={16} />
        </span>
        <span className="flex-1 truncate">{p.name}</span>
        {count !== undefined && count > 0 && (
          <span className="text-xs tabular-nums text-text-faint">{count}</span>
        )}
      </NavLink>
      {selected && (
        <button
          type="button"
          onClick={onDelete}
          // stop the drag sensor from claiming the press so a tap deletes
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-text-faint hover:text-danger"
          aria-label={`Delete ${p.name}`}
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}

function PerspectivesSection() {
  const navigate = useNavigate();
  const location = useLocation();
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  // A sync bumps dbRevision after applying settings; re-read so a perspective
  // added/removed/reordered on another device shows up without a navigation.
  const dbRevision = useStore((s) => s.dbRevision);
  const close = () => setSidebarOpen(false);
  const sensors = useReorderSensors();

  const [perspectives, setPerspectives] = useState<SavedPerspective[]>(getPerspectives);
  useEffect(() => setPerspectives(getPerspectives()), [location.pathname, dbRevision]);

  // Task quantity per saved perspective, computed the same way the view page
  // itself would (see ListView) so the sidebar badge matches what you'd see on open.
  const counts = useDeferredQuery(
    (db) =>
      Object.fromEntries(
        perspectives.map((p) => [p.id, queryRoots(db, p.base, p.prefs).length]),
      ),
    [perspectives],
  );

  if (perspectives.length === 0) return null;

  function deletePerspective(id: string, name: string) {
    if (!window.confirm(`Delete perspective "${name}"?`)) return;
    removePerspective(id);
    setPerspectives(getPerspectives());
    if (location.pathname === `/view/${id}`) navigate('/today');
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = perspectives.findIndex((p) => p.id === active.id);
    const newIndex = perspectives.findIndex((p) => p.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const reordered = arrayMove(perspectives, oldIndex, newIndex);
    setPerspectives(reordered); // optimistic; persist + sync the new order
    reorderPerspectives(reordered);
  }

  return (
    <>
      <div className="mt-5 px-4 pb-1 text-xs font-semibold uppercase tracking-wide text-text-faint">
        Perspectives
      </div>
      <div className="px-2.5">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={perspectives.map((p) => p.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="flex flex-col gap-0.5">
              {perspectives.map((p) => (
                <PerspectiveRow
                  key={p.id}
                  p={p}
                  selected={location.pathname === `/view/${p.id}`}
                  count={counts?.[p.id]}
                  onOpen={close}
                  onDelete={() => deletePerspective(p.id, p.name)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>
    </>
  );
}

export function Sidebar() {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);

  const where = useWhere();
  const showNearby = useFeature('nearby');
  const showForecast = useFeature('forecast');
  const showReview = useFeature('review');
  const showTime = useFeature('timeTracking');
  const showPerspectives = useFeature('perspectives');
  const showTags = useFeature('tags');
  const countScope = useStore((s) => s.uiPrefs.countScope);
  const data = useDeferredQuery(
    (db) => {
      const items = allItems(db);
      const projects = getProjects(db);
      const me = getCurrentUserId();
      // Remaining work in scope (recursive for 'all'), kept consistent with the pie.
      const remaining = (id: string) => {
        const { done, total } = subtaskProgress(db, id, countScope);
        return total - done;
      };
      const planCount = listPlan(db, me)
        .map((p) => getItem(db, p.item_id))
        .filter((i): i is Item => !!i && !i.deleted && i.status === 'active').length;
      return {
        todayCount: today(items).length,
        inboxCount: inbox(items).length,
        flaggedCount: flagged(items).length,
        overdueCount: items.filter((i) => i.type === 'task' && isOverdue(i)).length,
        nearbyCount:
          where.hasLocation
            ? tasksNearLocation(db, { zone: where.zone, point: where.point }).length
            : 0,
        planCount,
        reviewCount: projects.filter((p) => needsReview(p)).length,
        shared: (me ? sharedRoots(db, me) : []).map((it) => ({
          item: it,
          open: remaining(it.id),
        })),
      };
    },
    [countScope, where.hasLocation, where.zone, where.point?.lat, where.point?.lng],
  );

  const close = () => setSidebarOpen(false);

  return (
    <aside
      className={cn(
        'fixed inset-y-0 left-0 z-40 flex w-64 max-w-[85vw] flex-col overflow-hidden border-r border-border bg-surface transition-transform lg:static lg:z-auto lg:translate-x-0',
        sidebarOpen ? 'translate-x-0' : '-translate-x-full',
      )}
    >
      <div className="flex items-center gap-2 px-4 py-3.5">
        <img src="/icon-192.png" alt="" className="h-7 w-7 rounded-lg" />
        <span className="text-[15px] font-semibold tracking-tight">Carbon</span>
      </div>

      {/* Single scroll region: everything between the branding and the footer scrolls
          together, so the quick-access views stay reachable on short mobile viewports. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <nav className="flex flex-col gap-0.5 px-2.5">
        <NavItem
          to="/today"
          icon={<Sun size={17} />}
          label="Today"
          count={data?.todayCount}
          onClick={close}
        />
        <NavItem
          to="/inbox"
          icon={<InboxIcon size={17} />}
          label="Inbox"
          count={data?.inboxCount}
          onClick={close}
        />
        <NavItem
          to="/flagged"
          icon={<Flag size={17} />}
          label="Flagged"
          count={data?.flaggedCount}
          onClick={close}
        />
        {showForecast && (
          <NavItem
            to="/forecast"
            icon={<CalendarRange size={17} />}
            label="Forecast"
            count={data?.overdueCount}
            onClick={close}
          />
        )}
        {showNearby && where.hasLocation && (
          <NavItem
            to="/nearby"
            icon={<MapPin size={17} />}
            label="Nearby"
            count={data?.nearbyCount}
            onClick={close}
          />
        )}
        <NavItem
          to="/plan"
          icon={<Target size={17} />}
          label="Plan"
          count={data?.planCount}
          onClick={close}
        />
        {showReview && (
          <NavItem
            to="/review"
            icon={<Eye size={17} />}
            label="Review"
            count={data?.reviewCount}
            onClick={close}
          />
        )}
        <NavItem to="/all" icon={<Layers size={17} />} label="All Tasks" onClick={close} />
        {showTime && (
          <NavItem to="/time" icon={<Clock size={17} />} label="Time tracked" onClick={close} />
        )}
      </nav>

      {showPerspectives && <PerspectivesSection />}

      {data?.shared && data.shared.length > 0 && (
        <>
          <div className="mt-5 px-4 pb-1 text-xs font-semibold uppercase tracking-wide text-text-faint">
            Shared with me
          </div>
          <nav className="flex flex-col gap-0.5 px-2.5">
            {data.shared.map(({ item, open }: { item: Item; open: number }) => (
              <NavItem
                key={item.id}
                to={`/focus/${item.id}`}
                icon={<Users size={16} />}
                label={item.title || 'Untitled'}
                count={open}
                onClick={close}
              />
            ))}
          </nav>
        </>
      )}

      <ProjectsSection />

      {showTags && <TagsSection />}
      </div>

      <div className="flex items-center gap-1 border-t border-border px-2.5 py-2">
        <SyncIndicator />
        <div className="flex-1" />
        <UndoButtons />
        <ThemeToggle />
        <NavLink
          to="/settings"
          onClick={close}
          className="rounded-lg p-2 text-text-muted hover:bg-surface-2 hover:text-text"
          aria-label="Settings"
        >
          <Settings size={18} />
        </NavLink>
      </div>
    </aside>
  );
}
