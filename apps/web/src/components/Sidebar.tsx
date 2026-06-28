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
  GripVertical,
  Pencil,
  Trash2,
  X,
} from 'lucide-react';
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
  type Item,
  type OrderMode,
} from '@carbon/core';
import { useQuery } from '@/hooks/useQuery';
import { useWhere } from '@/hooks/useWhere';
import { useStore, getCurrentUserId } from '@/lib/store';
import { mutate } from '@/lib/mutate';
import { cn } from '@/lib/cn';
import { getPerspectives, removePerspective, type SavedPerspective } from '@/lib/views';
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

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('group/srow relative flex items-start', isDragging && 'z-10 opacity-80')}
    >
      <button
        {...(draggable ? attributes : {})}
        {...(draggable ? listeners : {})}
        className={cn(
          'flex h-8 w-4 shrink-0 items-center justify-center text-text-faint',
          draggable
            ? 'cursor-grab opacity-0 group-hover/srow:opacity-100'
            : 'pointer-events-none opacity-0',
        )}
        aria-label="Drag to reorder"
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical size={13} />
      </button>

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

  const data = useQuery(
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

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

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

      <div className="flex-1 overflow-y-auto px-2.5">
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

export function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const openTagsPanel = useStore((s) => s.openTagsPanel);
  const tagsPanelOpen = useStore((s) => s.tagsPanelOpen);

  const [perspectives, setPerspectives] = useState<SavedPerspective[]>(getPerspectives);
  useEffect(() => setPerspectives(getPerspectives()), [location.pathname]);

  function deletePerspective(id: string) {
    removePerspective(id);
    setPerspectives(getPerspectives());
    if (location.pathname === `/view/${id}`) navigate('/today');
  }

  const where = useWhere();
  const countScope = useStore((s) => s.uiPrefs.countScope);
  const data = useQuery(
    (db) => {
      const items = allItems(db);
      const projects = getProjects(db);
      const me = getCurrentUserId();
      // Remaining work in scope (recursive for 'all'), kept consistent with the pie.
      const remaining = (id: string) => {
        const { done, total } = subtaskProgress(db, id, countScope);
        return total - done;
      };
      return {
        todayCount: today(items).length,
        inboxCount: inbox(items).length,
        flaggedCount: flagged(items).length,
        overdueCount: items.filter((i) => i.type === 'task' && isOverdue(i)).length,
        nearbyCount:
          where.hasLocation
            ? tasksNearLocation(db, { zone: where.zone, point: where.point }).length
            : 0,
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
        'fixed inset-y-0 left-0 z-40 flex w-64 max-w-[85vw] flex-col border-r border-border bg-surface transition-transform lg:static lg:z-auto lg:translate-x-0',
        sidebarOpen ? 'translate-x-0' : '-translate-x-full',
      )}
    >
      <div className="flex items-center gap-2 px-4 py-3.5">
        <img src="/icon-192.png" alt="" className="h-7 w-7 rounded-lg" />
        <span className="text-[15px] font-semibold tracking-tight">Carbon</span>
      </div>

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
        <NavItem
          to="/forecast"
          icon={<CalendarRange size={17} />}
          label="Forecast"
          count={data?.overdueCount}
          onClick={close}
        />
        {where.hasLocation && (
          <NavItem
            to="/nearby"
            icon={<MapPin size={17} />}
            label="Nearby"
            count={data?.nearbyCount}
            onClick={close}
          />
        )}
        <NavItem to="/plan" icon={<Target size={17} />} label="Plan" onClick={close} />
        <NavItem
          to="/review"
          icon={<Eye size={17} />}
          label="Review"
          count={data?.reviewCount}
          onClick={close}
        />
        <NavItem to="/all" icon={<Layers size={17} />} label="All Tasks" onClick={close} />
        <NavItem to="/time" icon={<Clock size={17} />} label="Time tracked" onClick={close} />
        <button
          onClick={() => {
            openTagsPanel();
            navigate('/tags');
            close();
          }}
          className={cn(
            'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors',
            tagsPanelOpen
              ? 'bg-accent-soft text-accent'
              : 'text-text-muted hover:bg-surface-2 hover:text-text',
          )}
        >
          <span className="shrink-0">
            <TagIcon size={17} />
          </span>
          <span className="flex-1 truncate text-left">Tags</span>
        </button>
      </nav>

      {perspectives.length > 0 && (
        <>
          <div className="mt-5 px-4 pb-1 text-xs font-semibold uppercase tracking-wide text-text-faint">
            Perspectives
          </div>
          <nav className="flex flex-col gap-0.5 px-2.5">
            {perspectives.map((p) => (
              <div key={p.id} className="group/persp relative">
                <NavItem
                  to={`/view/${p.id}`}
                  icon={<Bookmark size={16} />}
                  label={p.name}
                  onClick={close}
                />
                <button
                  onClick={() => deletePerspective(p.id)}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-text-faint opacity-0 hover:text-danger group-hover/persp:opacity-100"
                  aria-label={`Delete ${p.name}`}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </nav>
        </>
      )}

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

      <div className="flex items-center gap-1 border-t border-border px-2.5 py-2">
        <SyncIndicator />
        <div className="flex-1" />
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
