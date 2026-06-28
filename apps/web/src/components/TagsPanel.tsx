import { useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ChevronRight, X, Plus, Pause, Play, Pencil, Trash2 } from 'lucide-react';
import {
  listTags,
  tagCounts,
  createTag,
  updateTag,
  deleteTag,
  moveTag,
  effectiveTagColor,
  tagParentPath,
  tagId,
} from '@carbon/core';
import { useQuery } from '@/hooks/useQuery';
import { mutate } from '@/lib/mutate';
import { useStore } from '@/lib/store';
import { buildTagTree, flattenTagTree, type TagNode } from '@/lib/tagTree';
import { TagMark } from './TagMark';
import { cn } from '@/lib/cn';

const TAG_COLORS = [
  '#ef4444',
  '#f59e0b',
  '#eab308',
  '#10b981',
  '#14b8a6',
  '#3b82f6',
  '#6366f1',
  '#8b5cf6',
  '#ec4899',
  '#64748b',
];

type Draft = { mode: 'rename'; id: string; parent: string } | { mode: 'new'; parent: string };

export function TagsPanel() {
  const navigate = useNavigate();
  const { id: activeId } = useParams();
  const collapsed = useStore((s) => s.collapsed);
  const toggleCollapsed = useStore((s) => s.toggleCollapsed);

  const data = useQuery((db) => {
    const tags = listTags(db);
    const counts = tagCounts(db);
    const colorOf: Record<string, string | null> = {};
    for (const t of tags) colorOf[t.id] = effectiveTagColor(db, t.name);
    return { roots: buildTagTree(tags, counts), colorOf };
  }, []);

  const roots = data?.roots ?? [];
  const colorOf = data?.colorOf ?? {};
  const flat = flattenTagTree(roots, collapsed);
  const byPath = new Map<string, TagNode>();
  const index = (nodes: TagNode[]) => nodes.forEach((n) => (byPath.set(n.tag.name, n), index(n.children)));
  index(roots);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState('');
  const [colorPicker, setColorPicker] = useState<string | null>(null);
  const cancelled = useRef(false);

  function startRename(node: TagNode) {
    cancelled.current = false;
    setText(node.leaf);
    setDraft({ mode: 'rename', id: node.tag.id, parent: node.parentPath });
  }
  function startAdd(parent: string) {
    cancelled.current = false;
    setText('');
    setDraft({ mode: 'new', parent });
  }

  /** Apply the pending draft (idempotent — safe to call from both Enter and blur). */
  function finalize(d: Draft, value: string): string | null {
    const leaf = value.trim();
    if (!leaf) return null;
    const fullName = d.parent ? `${d.parent}:${leaf}` : leaf;
    if (d.mode === 'rename') {
      mutate((db, dev) => moveTag(db, dev, d.id, fullName));
    } else {
      mutate((db, dev) => createTag(db, dev, fullName));
    }
    return tagId(fullName);
  }

  function onBlur() {
    if (cancelled.current) {
      cancelled.current = false;
      setDraft(null);
      return;
    }
    if (draft) finalize(draft, text);
    setDraft(null);
  }

  function onKeyDown(e: React.KeyboardEvent, node?: TagNode) {
    if (!draft) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelled.current = true;
      setDraft(null);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      finalize(draft, text);
      // Chain into adding a sibling for rapid entry.
      startAdd(draft.parent);
      return;
    }
    if (e.key === 'Tab' && draft.mode === 'rename' && node) {
      e.preventDefault();
      const sibs = (node.parentPath ? byPath.get(node.parentPath)?.children : roots) ?? [];
      const idx = sibs.findIndex((s) => s.tag.id === node.tag.id);
      if (e.shiftKey) {
        if (!node.parentPath) return; // already at root
        const grandparent = tagParentPath(node.parentPath);
        const newName = grandparent ? `${grandparent}:${text.trim() || node.leaf}` : text.trim() || node.leaf;
        mutate((db, dev) => moveTag(db, dev, node.tag.id, newName));
        setDraft({ mode: 'rename', id: tagId(newName), parent: grandparent });
      } else {
        if (idx <= 0) return; // no previous sibling to nest under
        const newParent = sibs[idx - 1]!.tag.name;
        const newName = `${newParent}:${text.trim() || node.leaf}`;
        mutate((db, dev) => moveTag(db, dev, node.tag.id, newName));
        setDraft({ mode: 'rename', id: tagId(newName), parent: newParent });
      }
    }
  }

  function setColor(id: string, color: string | null) {
    mutate((db, dev) => updateTag(db, dev, id, { color }));
    setColorPicker(null);
  }
  function toggleHold(node: TagNode) {
    mutate((db, dev) =>
      updateTag(db, dev, node.tag.id, {
        status: node.tag.status === 'on-hold' ? 'active' : 'on-hold',
      }),
    );
  }
  function remove(node: TagNode) {
    const n = node.rollupCount;
    const kids = node.children.length;
    const msg = kids
      ? `Delete "${node.tag.name}" and its ${kids} nested tag${kids > 1 ? 's' : ''}?`
      : `Delete tag "${node.tag.name}"?`;
    if (!window.confirm(msg + (n ? ` It is used on ${n} task${n > 1 ? 's' : ''}.` : ''))) return;
    // Cascade: remove the node and its whole subtree.
    const ids: string[] = [];
    const collect = (x: TagNode) => (ids.push(x.tag.id), x.children.forEach(collect));
    collect(node);
    mutate((db, dev) => ids.forEach((tid) => deleteTag(db, dev, tid)));
    if (ids.includes(activeId ?? '')) navigate('/tags');
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header />
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
        {flat.length === 0 && draft?.mode !== 'new' && (
          <p className="px-3 py-6 text-center text-sm text-text-faint">
            No tags yet. Add one below, or type a path like
            <br />
            <code className="text-text-muted">Shopping:Coles:FreshGoods</code> to nest.
          </p>
        )}

        {flat.map((node) => {
          const isEditing = draft?.mode === 'rename' && draft.id === node.tag.id;
          const hasKids = node.children.length > 0;
          const isCollapsed = collapsed.has(node.tag.id);
          return (
            <div
              key={node.tag.id}
              className={cn(
                'group relative flex items-center gap-1 rounded-md py-1 pr-1 text-sm hover:bg-surface-2',
                activeId === node.tag.id && 'bg-accent-soft',
              )}
              style={{ paddingLeft: `${0.25 + node.depth * 0.9}rem` }}
            >
              <button
                onClick={() => hasKids && toggleCollapsed(node.tag.id)}
                className={cn('flex h-4 w-4 shrink-0 items-center justify-center', !hasKids && 'invisible')}
                aria-label={isCollapsed ? 'Expand' : 'Collapse'}
              >
                <ChevronRight
                  size={14}
                  className={cn('text-text-faint transition-transform', !isCollapsed && 'rotate-90')}
                />
              </button>

              {/* The # opens the colour picker */}
              <button
                onClick={() => setColorPicker(colorPicker === node.tag.id ? null : node.tag.id)}
                title="Set colour"
                className="shrink-0"
              >
                <TagMark color={colorOf[node.tag.id]} />
              </button>

              {isEditing ? (
                <input
                  autoFocus
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => onKeyDown(e, node)}
                  onBlur={onBlur}
                  className="min-w-0 flex-1 rounded border border-accent bg-surface px-1 py-0 text-sm outline-none"
                />
              ) : (
                <button
                  onClick={() => navigate(`/tag/${node.tag.id}`)}
                  className="min-w-0 flex-1 truncate text-left"
                  title={node.tag.name}
                >
                  <span className={cn(node.tag.status === 'on-hold' && 'text-text-faint line-through')}>
                    {node.leaf}
                  </span>
                </button>
              )}

              {!isEditing && (
                <>
                  <span className="shrink-0 text-xs tabular-nums text-text-faint">
                    {node.rollupCount || ''}
                  </span>
                  <div className="flex shrink-0 items-center opacity-0 group-hover:opacity-100">
                    <IconBtn title="Add nested tag" onClick={() => startAdd(node.tag.name)}>
                      <Plus size={13} />
                    </IconBtn>
                    <IconBtn title="Rename" onClick={() => startRename(node)}>
                      <Pencil size={13} />
                    </IconBtn>
                    <IconBtn
                      title={node.tag.status === 'on-hold' ? 'Set active' : 'Put on hold'}
                      onClick={() => toggleHold(node)}
                      active={node.tag.status === 'on-hold'}
                    >
                      {node.tag.status === 'on-hold' ? <Play size={13} /> : <Pause size={13} />}
                    </IconBtn>
                    <IconBtn title="Delete" danger onClick={() => remove(node)}>
                      <Trash2 size={13} />
                    </IconBtn>
                  </div>
                </>
              )}

              {colorPicker === node.tag.id && (
                <ColorPopover
                  value={node.tag.color}
                  inherited={colorOf[node.tag.id]}
                  onPick={(c) => setColor(node.tag.id, c)}
                  onClose={() => setColorPicker(null)}
                />
              )}
            </div>
          );
        })}

        {/* New top-level / nested draft row */}
        {draft?.mode === 'new' && (
          <div
            className="flex items-center gap-1 py-1"
            style={{ paddingLeft: `${0.25 + (draft.parent ? draft.parent.split(':').length : 0) * 0.9 + 0.95}rem` }}
          >
            <TagMark color={null} />
            <input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => onKeyDown(e)}
              onBlur={onBlur}
              placeholder={draft.parent ? `New under ${draft.parent}…` : 'New tag…'}
              className="min-w-0 flex-1 rounded border border-accent bg-surface px-1 py-0 text-sm outline-none"
            />
          </div>
        )}
      </div>

      <div className="border-t border-border p-2">
        <button
          onClick={() => startAdd('')}
          className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm text-text-muted hover:bg-surface-2"
        >
          <Plus size={15} /> New tag
        </button>
        <p className="mt-1.5 px-1 text-[11px] leading-snug text-text-faint">
          Enter adds a sibling · Tab / Shift-Tab nest · type <code>Parent:Child</code> to nest directly.
        </p>
      </div>
    </div>
  );
}

function Header() {
  const closeTagsPanel = useStore((s) => s.closeTagsPanel);
  return (
    <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
      <h2 className="text-sm font-semibold">Tags</h2>
      <button onClick={closeTagsPanel} className="rounded p-1 hover:bg-surface-2" aria-label="Close tags">
        <X size={16} className="text-text-faint" />
      </button>
    </div>
  );
}

function IconBtn({
  children,
  title,
  onClick,
  danger,
  active,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  danger?: boolean;
  active?: boolean;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        'rounded p-1 text-text-faint hover:bg-surface-3',
        active && 'text-accent',
        danger ? 'hover:text-danger' : 'hover:text-text',
      )}
    >
      {children}
    </button>
  );
}

function ColorPopover({
  value,
  inherited,
  onPick,
  onClose,
}: {
  value: string | null;
  inherited: string | null;
  onPick: (c: string | null) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onClose} />
      <div className="absolute left-6 top-7 z-20 flex w-44 flex-wrap items-center gap-1.5 rounded-lg border border-border bg-surface p-2 shadow-lg">
        {TAG_COLORS.map((c) => (
          <button
            key={c}
            onClick={() => onPick(c)}
            title={c}
            className={cn(
              'h-5 w-5 rounded-full border transition-transform hover:scale-110',
              value === c ? 'border-text ring-2 ring-text/30' : 'border-border',
            )}
            style={{ background: c }}
          />
        ))}
        <button
          onClick={() => onPick(null)}
          title={inherited ? 'Inherit from parent' : 'No colour'}
          className={cn(
            'flex h-5 w-5 items-center justify-center rounded-full border text-[10px] text-text-faint transition-transform hover:scale-110',
            !value ? 'border-text ring-2 ring-text/30' : 'border-border',
          )}
          style={inherited ? { background: inherited, opacity: 0.4 } : undefined}
        >
          {!inherited && '✕'}
        </button>
      </div>
    </>
  );
}
