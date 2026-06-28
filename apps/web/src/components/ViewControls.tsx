import { useState } from 'react';
import { ArrowUpDown, Check, Flag, BookmarkPlus, SlidersHorizontal, Ban } from 'lucide-react';
import { cn } from '@/lib/cn';
import { SORT_LABELS, anyFilterActive, DEFAULT_FILTERS, type Filters, type SortKey, type ViewPrefs } from '@/lib/views';
import { tagId, type Item, type Tag } from '@carbon/core';
import { TagMark } from './TagMark';
import { abbreviateTagPath } from '@/lib/tagLabel';
import { X } from 'lucide-react';

const PRIORITIES = [
  { value: 3, label: 'High' },
  { value: 2, label: 'Medium' },
  { value: 1, label: 'Low' },
  { value: 0, label: 'None' },
];

function toggle<T>(arr: T[], v: T): T[] {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium',
        active
          ? 'border-accent bg-accent-soft text-accent'
          : 'border-border text-text-muted hover:bg-surface-2',
      )}
    >
      {children}
    </button>
  );
}

export function ViewControls({
  prefs,
  onChange,
  onSavePerspective,
  tags = [],
  projects = [],
}: {
  prefs: ViewPrefs;
  onChange: (p: ViewPrefs) => void;
  onSavePerspective?: (name: string) => void;
  tags?: Tag[];
  projects?: Item[];
}) {
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [open, setOpen] = useState(false);
  const f = prefs.filters;

  const setFilters = (patch: Partial<ViewPrefs['filters']>) =>
    onChange({ ...prefs, filters: { ...f, ...patch } });

  return (
    <div className="mb-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-text-muted">
          <ArrowUpDown size={13} />
          <select
            value={prefs.sort}
            onChange={(e) => onChange({ ...prefs, sort: e.target.value as SortKey })}
            className="bg-transparent text-xs font-medium text-text outline-none"
          >
            {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
              <option key={k} value={k}>
                {SORT_LABELS[k]}
              </option>
            ))}
          </select>
        </div>

        <Chip active={f.showCompleted} onClick={() => setFilters({ showCompleted: !f.showCompleted })}>
          <Check size={12} /> Completed
        </Chip>
        <Chip active={f.flaggedOnly} onClick={() => setFilters({ flaggedOnly: !f.flaggedOnly })}>
          <Flag size={12} /> Flagged
        </Chip>

        <Chip active={open || anyFilterActive(f)} onClick={() => setOpen((o) => !o)}>
          <SlidersHorizontal size={12} /> Filters
        </Chip>

        <div className="flex-1" />

        {onSavePerspective &&
          (saving ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) onSavePerspective(name.trim());
                setName('');
                setSaving(false);
              }}
              className="flex items-center gap-1"
            >
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setSaving(false)}
                placeholder="View name…"
                className="w-32 rounded-lg border border-accent bg-surface px-2 py-1 text-xs outline-none"
              />
            </form>
          ) : (
            <button
              onClick={() => setSaving(true)}
              className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-text-muted hover:bg-surface-2"
            >
              <BookmarkPlus size={13} /> Save view
            </button>
          ))}
      </div>

      {open && (
        <div className="mt-2 space-y-3 rounded-lg border border-border bg-surface p-3">
          {tags.length > 0 && (
            <Group label="Tags">
              <TagFilterField tags={tags} f={f} setFilters={setFilters} />
              <Chip active={f.noTags} onClick={() => setFilters({ noTags: !f.noTags })}>
                No tags
              </Chip>
            </Group>
          )}

          <Group label="Priority">
            {PRIORITIES.map((p) => (
              <Chip
                key={p.value}
                active={f.priorities.includes(p.value)}
                onClick={() => setFilters({ priorities: toggle(f.priorities, p.value) })}
              >
                {p.label}
              </Chip>
            ))}
          </Group>

          {projects.length > 0 && (
            <Group label="Project">
              {projects.map((p) => (
                <Chip
                  key={p.id}
                  active={f.projectIds.includes(p.id)}
                  onClick={() => setFilters({ projectIds: toggle(f.projectIds, p.id) })}
                >
                  {p.title || 'Untitled'}
                </Chip>
              ))}
              <Chip active={f.noProject} onClick={() => setFilters({ noProject: !f.noProject })}>
                No project
              </Chip>
            </Group>
          )}

          <Group label="Dates">
            <Chip active={f.noDueDate} onClick={() => setFilters({ noDueDate: !f.noDueDate })}>
              No due date
            </Chip>
            <Chip active={f.hideDeferred} onClick={() => setFilters({ hideDeferred: !f.hideDeferred })}>
              Hide deferred
            </Chip>
            <Chip active={f.hideBlocked} onClick={() => setFilters({ hideBlocked: !f.hideBlocked })}>
              <Ban size={12} /> Hide blocked
            </Chip>
            <label className="flex items-center gap-1 text-text-muted">
              Due after
              <input
                type="date"
                value={f.dueAfter ?? ''}
                onChange={(e) => setFilters({ dueAfter: e.target.value || null })}
                className="rounded-lg border border-border bg-surface px-2 py-1 outline-none focus:border-accent"
              />
            </label>
            <label className="flex items-center gap-1 text-text-muted">
              Due before
              <input
                type="date"
                value={f.dueBefore ?? ''}
                onChange={(e) => setFilters({ dueBefore: e.target.value || null })}
                className="rounded-lg border border-border bg-surface px-2 py-1 outline-none focus:border-accent"
              />
            </label>
          </Group>

          {anyFilterActive(f) && (
            <button
              onClick={() => onChange({ ...prefs, filters: { ...DEFAULT_FILTERS } })}
              className="text-xs font-medium text-accent hover:underline"
            >
              Clear all filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}

type TagMode = 'any' | 'all' | 'none';
const MODE_NEXT: Record<TagMode, TagMode | null> = { any: 'all', all: 'none', none: null };
const MODE_LABEL: Record<TagMode, string> = { any: 'any', all: 'all', none: 'excl' };

function tagModeOf(f: Filters, id: string): TagMode | null {
  if (f.tagAll.includes(id)) return 'all';
  if (f.tagNone.includes(id)) return 'none';
  if (f.tagAny.includes(id)) return 'any';
  return null;
}

/** Move a tag id into exactly one mode set (or drop it when mode is null). */
function withTagMode(f: Filters, id: string, mode: TagMode | null): Partial<Filters> {
  const tagAny = f.tagAny.filter((x) => x !== id);
  const tagAll = f.tagAll.filter((x) => x !== id);
  const tagNone = f.tagNone.filter((x) => x !== id);
  if (mode === 'any') tagAny.push(id);
  else if (mode === 'all') tagAll.push(id);
  else if (mode === 'none') tagNone.push(id);
  return { tagAny, tagAll, tagNone };
}

/** Typeahead tag filter: add tags by name, each assignable to any / all / excl. */
function TagFilterField({
  tags,
  f,
  setFilters,
}: {
  tags: Tag[];
  f: Filters;
  setFilters: (patch: Partial<Filters>) => void;
}) {
  const [text, setText] = useState('');
  const byId = new Map(tags.map((t) => [t.id, t]));
  const selected = [...f.tagAny, ...f.tagAll, ...f.tagNone];

  function add(name: string) {
    const id = tagId(name);
    if (!byId.has(id)) return; // only filter by tags that exist
    if (tagModeOf(f, id)) return; // already selected
    setFilters(withTagMode(f, id, 'any'));
    setText('');
  }

  return (
    <div className="flex w-full flex-wrap items-center gap-1.5">
      {selected.map((id) => {
        const t = byId.get(id);
        if (!t) return null;
        const mode = tagModeOf(f, id)!;
        return (
          <span
            key={id}
            className="flex items-center gap-1 rounded-full border border-accent bg-accent-soft px-2 py-0.5 text-xs text-accent"
            title={t.name}
          >
            <TagMark color={t.color} />
            {abbreviateTagPath(t.name)}
            <button
              onClick={() => setFilters(withTagMode(f, id, MODE_NEXT[mode]))}
              className="rounded bg-surface px-1 text-[10px] font-semibold uppercase text-text-muted hover:text-text"
              title="Cycle match: any → all → exclude → remove"
            >
              {MODE_LABEL[mode]}
            </button>
            <button onClick={() => setFilters(withTagMode(f, id, null))} aria-label={`Remove ${t.name}`}>
              <X size={11} />
            </button>
          </span>
        );
      })}
      <input
        list="viewcontrols-tags"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add(text);
          }
        }}
        placeholder="Filter by tag…"
        className="min-w-[7rem] flex-1 rounded-lg border border-border bg-surface px-2 py-1 text-xs outline-none focus:border-accent"
      />
      <datalist id="viewcontrols-tags">
        {tags.map((t) => (
          <option key={t.id} value={t.name} />
        ))}
      </datalist>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-faint">
        {label}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}
