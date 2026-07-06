import { Plus, X, FolderPlus } from 'lucide-react';
import type { Item, Tag } from '@carbon/core';
import type { Condition, FilterExpr } from '@/lib/filter-expr';
import { abbreviateTagPath } from '@/lib/tagLabel';

const COND_OPTIONS: { kind: Condition['kind']; label: string }[] = [
  { kind: 'flagged', label: 'Flagged' },
  { kind: 'completed', label: 'Completed' },
  { kind: 'priority', label: 'Priority' },
  { kind: 'dueWithinDays', label: 'Due within (days)' },
  { kind: 'dueAfterDays', label: 'Due after (days)' },
  { kind: 'noDueDate', label: 'No due date' },
  { kind: 'overdue', label: 'Overdue' },
  { kind: 'deferred', label: 'Deferred' },
  { kind: 'blocked', label: 'Blocked' },
  { kind: 'onHold', label: 'On hold' },
  { kind: 'hasTag', label: 'Has tag' },
  { kind: 'inProject', label: 'In project' },
  { kind: 'isNote', label: 'Is a note' },
  { kind: 'titleContains', label: 'Title contains' },
  { kind: 'noteContains', label: 'Note contains' },
];

function defaultCond(kind: Condition['kind'], tags: Tag[], projects: Item[]): Condition {
  switch (kind) {
    case 'priority':
      return { kind, op: 'gte', value: 3 };
    case 'dueWithinDays':
      return { kind, days: 1 };
    case 'dueAfterDays':
      return { kind, days: 7 };
    case 'hasTag':
      return { kind, tagId: tags[0]?.id ?? '' };
    case 'inProject':
      return { kind, projectId: projects[0]?.id ?? '' };
    case 'titleContains':
      return { kind, text: '' };
    case 'noteContains':
      return { kind, text: '' };
    default:
      return { kind } as Condition;
  }
}

const inputCls =
  'rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs outline-none focus:border-accent';

function ConditionRow({
  cond,
  onChange,
  tags,
  projects,
}: {
  cond: Condition;
  onChange: (c: Condition) => void;
  tags: Tag[];
  projects: Item[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <select
        value={cond.kind}
        onChange={(e) => onChange(defaultCond(e.target.value as Condition['kind'], tags, projects))}
        className={inputCls}
      >
        {COND_OPTIONS.map((o) => (
          <option key={o.kind} value={o.kind}>
            {o.label}
          </option>
        ))}
      </select>

      {cond.kind === 'priority' && (
        <>
          <select
            value={cond.op}
            onChange={(e) => onChange({ ...cond, op: e.target.value as 'eq' | 'gte' | 'lte' })}
            className={inputCls}
          >
            <option value="gte">≥</option>
            <option value="eq">=</option>
            <option value="lte">≤</option>
          </select>
          <select
            value={cond.value}
            onChange={(e) => onChange({ ...cond, value: Number(e.target.value) })}
            className={inputCls}
          >
            <option value={0}>None</option>
            <option value={1}>Low</option>
            <option value={2}>Medium</option>
            <option value={3}>High</option>
          </select>
        </>
      )}

      {(cond.kind === 'dueWithinDays' || cond.kind === 'dueAfterDays') && (
        <input
          type="number"
          min={0}
          value={cond.days}
          onChange={(e) => onChange({ ...cond, days: Number(e.target.value) })}
          className={`${inputCls} w-16`}
        />
      )}

      {cond.kind === 'hasTag' && (
        <select
          value={cond.tagId}
          onChange={(e) => onChange({ ...cond, tagId: e.target.value })}
          className={inputCls}
        >
          {tags.length === 0 && <option value="">(no tags)</option>}
          {tags.map((t) => (
            <option key={t.id} value={t.id}>
              {abbreviateTagPath(t.name)}
            </option>
          ))}
        </select>
      )}

      {cond.kind === 'inProject' && (
        <select
          value={cond.projectId}
          onChange={(e) => onChange({ ...cond, projectId: e.target.value })}
          className={inputCls}
        >
          {projects.length === 0 && <option value="">(no projects)</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title || 'Untitled'}
            </option>
          ))}
        </select>
      )}

      {(cond.kind === 'titleContains' || cond.kind === 'noteContains') && (
        <input
          type="text"
          value={cond.text}
          placeholder="text…"
          onChange={(e) => onChange({ ...cond, text: e.target.value })}
          className={`${inputCls} w-32`}
        />
      )}
    </div>
  );
}

/** One node: a condition or a sub-group, optionally negated (wrapped in NOT). */
function FilterNode({
  node,
  onChange,
  onRemove,
  tags,
  projects,
  depth,
}: {
  node: FilterExpr;
  onChange: (n: FilterExpr) => void;
  onRemove: () => void;
  tags: Tag[];
  projects: Item[];
  depth: number;
}) {
  const negated = node.type === 'not';
  const inner = negated ? node.child : node;
  const setInner = (n: FilterExpr) => onChange(negated ? { type: 'not', child: n } : n);
  const toggleNot = () => onChange(negated ? inner : { type: 'not', child: inner });

  const notChip = (
    <button
      type="button"
      onClick={toggleNot}
      className={`rounded-md border px-1.5 py-0.5 text-xs font-medium ${
        negated ? 'border-danger bg-danger/10 text-danger' : 'border-border text-text-muted'
      }`}
      title="Negate"
    >
      NOT
    </button>
  );

  if (inner.type === 'and' || inner.type === 'or') {
    return (
      <GroupBox
        group={inner}
        onChange={setInner}
        onRemove={onRemove}
        notChip={notChip}
        tags={tags}
        projects={projects}
        depth={depth}
      />
    );
  }

  // Double negation (not → not), only reachable from loaded/LLM expressions: recurse
  // so it stays editable rather than crashing.
  if (inner.type === 'not') {
    return (
      <FilterNode
        node={inner}
        onChange={setInner}
        onRemove={onRemove}
        tags={tags}
        projects={projects}
        depth={depth}
      />
    );
  }

  // condition row
  return (
    <div className="flex items-center gap-1.5">
      {notChip}
      <ConditionRow
        cond={inner.cond}
        onChange={(c) => setInner({ type: 'cond', cond: c })}
        tags={tags}
        projects={projects}
      />
      <button
        type="button"
        onClick={onRemove}
        className="rounded p-1 text-text-faint hover:text-danger"
        aria-label="Remove condition"
      >
        <X size={13} />
      </button>
    </div>
  );
}

function GroupBox({
  group,
  onChange,
  onRemove,
  notChip,
  tags,
  projects,
  depth,
}: {
  group: { type: 'and' | 'or'; children: FilterExpr[] };
  onChange: (n: FilterExpr) => void;
  onRemove: () => void;
  notChip?: React.ReactNode;
  tags: Tag[];
  projects: Item[];
  depth: number;
}) {
  const setChild = (i: number, n: FilterExpr) =>
    onChange({ ...group, children: group.children.map((c, j) => (j === i ? n : c)) });
  const removeChild = (i: number) =>
    onChange({ ...group, children: group.children.filter((_, j) => j !== i) });
  const addCond = () =>
    onChange({
      ...group,
      children: [...group.children, { type: 'cond', cond: defaultCond('flagged', tags, projects) }],
    });
  const addGroup = () =>
    onChange({ ...group, children: [...group.children, { type: 'and', children: [] }] });

  return (
    <div className="rounded-lg border border-border bg-surface-2/40 p-2">
      <div className="mb-2 flex items-center gap-1.5">
        {notChip}
        <div className="flex overflow-hidden rounded-md border border-border text-xs">
          {(['and', 'or'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => onChange({ ...group, type: t })}
              className={`px-2 py-0.5 font-medium uppercase ${
                group.type === t ? 'bg-accent text-accent-fg' : 'text-text-muted hover:bg-surface-2'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <span className="text-xs text-text-faint">
          {group.type === 'and' ? 'all of' : 'any of'}
        </span>
        <div className="flex-1" />
        {depth > 0 && (
          <button
            type="button"
            onClick={onRemove}
            className="rounded p-1 text-text-faint hover:text-danger"
            aria-label="Remove group"
          >
            <X size={13} />
          </button>
        )}
      </div>

      <div className="space-y-1.5 pl-2">
        {group.children.length === 0 && (
          <p className="text-xs text-text-faint">No conditions yet.</p>
        )}
        {group.children.map((child, i) => (
          <FilterNode
            key={i}
            node={child}
            onChange={(n) => setChild(i, n)}
            onRemove={() => removeChild(i)}
            tags={tags}
            projects={projects}
            depth={depth + 1}
          />
        ))}
      </div>

      <div className="mt-2 flex gap-2 pl-2">
        <button
          type="button"
          onClick={addCond}
          className="flex items-center gap-1 text-xs text-accent hover:underline"
        >
          <Plus size={12} /> Condition
        </button>
        <button
          type="button"
          onClick={addGroup}
          className="flex items-center gap-1 text-xs text-accent hover:underline"
        >
          <FolderPlus size={12} /> Group
        </button>
      </div>
    </div>
  );
}

/** Editor for a nested boolean filter expression. A null expression starts as an
 *  empty AND group. */
export function AdvancedFilterBuilder({
  expr,
  onChange,
  tags = [],
  projects = [],
}: {
  expr: FilterExpr | null;
  onChange: (e: FilterExpr | null) => void;
  tags?: Tag[];
  projects?: Item[];
}) {
  const root: FilterExpr =
    expr && (expr.type === 'and' || expr.type === 'or') ? expr : { type: 'and', children: expr ? [expr] : [] };

  return (
    <GroupBox
      group={root as { type: 'and' | 'or'; children: FilterExpr[] }}
      onChange={(n) => onChange(n)}
      onRemove={() => onChange(null)}
      tags={tags}
      projects={projects}
      depth={0}
    />
  );
}
