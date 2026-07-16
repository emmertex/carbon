import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Trash2, Pause, Play } from 'lucide-react';
import {
  listTags,
  tagCounts,
  tagLeaf,
  tagParentPath,
  normalizeTagName,
  tagId,
  expandTagIds,
  descendantTagIds,
  effectiveTagColor,
  moveTag,
  updateTag,
  deleteTag,
} from '@carbon/core';
import { useQuery } from '@/hooks/useQuery';
import { mutate } from '@/lib/mutate';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/cn';
import { ColorSwatches } from './ColorSwatches';
import { GeoEditor } from './GeoEditor';
import { TagMark } from './TagMark';
import { abbreviateTagPath } from '@/lib/tagLabel';
import { inputCls, btnIcon, Label } from './ui/controls';
import { SegmentedControl } from './ui/SegmentedControl';

export function TagDetail({ id }: { id: string }) {
  const select = useStore((s) => s.select);
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const seededId = useRef<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const data = useQuery(
    (db) => {
      const tag = listTags(db).find((t) => t.id === id);
      if (!tag) return { tag: undefined, effColor: null, ownCount: 0, rollupCount: 0 };
      const counts = tagCounts(db);
      const ids = expandTagIds(db, [id]);
      let rollupCount = 0;
      for (const tid of ids) rollupCount += counts[tid] ?? 0;
      return {
        tag,
        effColor: effectiveTagColor(db, tag.name),
        ownCount: counts[id] ?? 0,
        rollupCount,
        descendants: descendantTagIds(db, id).length,
      };
    },
    [id],
  );

  const tag = data?.tag;

  useEffect(() => {
    if (!tag) return;
    // Reseed the name draft only when switching tags (or the id re-keyed after a
    // rename), never on an unrelated re-render that could clobber keystrokes.
    if (seededId.current !== id || document.activeElement !== nameRef.current) {
      setName(tagLeaf(tag.name));
    }
    seededId.current = id;
  }, [id, tag?.name]);

  if (!tag) {
    return (
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-1 border-b border-border px-3 py-2">
          <button
            onClick={() => select(null)}
            className={cn(btnIcon, 'p-2')}
            aria-label="Close"
          >
            <X size={18} />
          </button>
          <span className="text-xs uppercase tracking-wide text-text-faint">Tag</span>
        </header>
        <div className="p-4 text-sm text-text-muted">Tag not found.</div>
      </div>
    );
  }

  const onHold = tag.status === 'on-hold';
  const parentPath = tagParentPath(tag.name);

  function commitName() {
    const raw = name.trim();
    if (!raw) {
      setName(tagLeaf(tag!.name));
      return;
    }
    // A colon path is treated as an absolute rename/reparent; a bare leaf keeps
    // the current parent. moveTag re-keys the whole subtree + relinks tasks.
    const newName = raw.includes(':') ? raw : parentPath ? `${parentPath}:${raw}` : raw;
    if (normalizeTagName(newName) === tag!.name) return;
    mutate((db, dev) => moveTag(db, dev, id, newName));
    const newId = tagId(newName);
    select(newId, 'tag');
    navigate(`/tag/${newId}`);
  }

  function toggleHold() {
    mutate((db, dev) => updateTag(db, dev, id, { status: onHold ? 'active' : 'on-hold' }));
  }

  function setColor(c: string | null) {
    mutate((db, dev) => updateTag(db, dev, id, { color: c }));
  }

  function setGeo(geo: string | null) {
    mutate((db, dev) => updateTag(db, dev, id, { geo }));
  }

  function remove() {
    const n = data?.descendants ?? 0;
    const msg =
      n > 0
        ? `Delete "${abbreviateTagPath(tag!.name)}" and its ${n} nested tag${n === 1 ? '' : 's'}? Tasks keep their other tags.`
        : `Delete "${abbreviateTagPath(tag!.name)}"? Tasks keep their other tags.`;
    if (!window.confirm(msg)) return;
    mutate((db, dev) => {
      for (const did of descendantTagIds(db, id)) deleteTag(db, dev, did);
      deleteTag(db, dev, id);
    });
    select(null);
    navigate('/tags');
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-1 border-b border-border px-3 py-2">
        <button
          onClick={() => select(null)}
          className={cn(btnIcon, 'p-2')}
          aria-label="Close"
        >
          <X size={18} />
        </button>
        <span className="text-xs uppercase tracking-wide text-text-faint">Tag</span>
        <div className="flex-1" />
        <button
          onClick={toggleHold}
          className={cn(btnIcon, 'p-2', onHold && 'text-warning hover:text-warning')}
          aria-label={onHold ? 'Release hold' : 'Put on hold'}
          title={onHold ? 'On hold — release' : 'Put on hold'}
        >
          {onHold ? <Play size={17} /> : <Pause size={17} />}
        </button>
        <button
          onClick={remove}
          className={cn(btnIcon, 'p-2 hover:text-danger')}
          aria-label="Delete"
        >
          <Trash2 size={17} />
        </button>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <div className="flex items-center gap-2">
          <TagMark color={data?.effColor ?? null} className="text-lg" />
          <input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                (e.target as HTMLInputElement).blur();
              } else if (e.key === 'Escape') {
                setName(tagLeaf(tag.name));
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder="Tag name"
            className={cn(inputCls, 'w-full font-medium')}
          />
        </div>
        {parentPath && (
          <p className="-mt-2 text-xs text-text-faint">
            Under <span title={parentPath}>{abbreviateTagPath(parentPath)}</span> · type a{' '}
            <code>Parent:Child</code> path to move it
          </p>
        )}

        <p className="text-sm text-text-muted">
          {data?.rollupCount ?? 0} {data?.rollupCount === 1 ? 'task' : 'tasks'} (incl. nested)
        </p>

        <div>
          <Label>Status</Label>
          <SegmentedControl<'active' | 'on-hold'>
            value={onHold ? 'on-hold' : 'active'}
            onChange={(v) => {
              if ((v === 'on-hold') !== onHold) toggleHold();
            }}
            options={[
              { value: 'active', label: 'Active' },
              {
                value: 'on-hold',
                label: 'On hold',
                activeClassName: 'bg-warning/10 text-warning',
              },
            ]}
          />
          <p className="mt-1 text-xs text-text-faint">
            On hold fades these tasks, defers them out of Today, and mutes their reminders.
          </p>
        </div>

        <div>
          <Label>Colour</Label>
          <ColorSwatches value={tag.color} onChange={setColor} />
        </div>

        <GeoEditor value={tag.geo} resetKey={id} onChange={setGeo} label="Location" />
      </div>
    </div>
  );
}
