import {
  getItemTags,
  getChildren,
  expandTagIds,
  onHoldTagIds,
  isBlocked,
  type Db,
  type Item,
} from '@carbon/core';
import { applyFilters } from './filter';
import type { ViewPrefs } from './views';

// ----- the advanced filter expression tree ---------------------------------
//
// A nested boolean expression over a small, closed set of conditions. Kept as a
// discriminated union (not a generic field/op/value matrix) so both the builder UI
// and the LLM-emitted JSON stay tightly typed and easy to validate.

export type Condition =
  | { kind: 'flagged' }
  | { kind: 'completed' } // status === 'done'
  | { kind: 'priority'; op: 'eq' | 'gte' | 'lte'; value: number } // 0..3
  | { kind: 'dueWithinDays'; days: number } // due on/before now + N days (incl. overdue)
  | { kind: 'dueAfterDays'; days: number } // due strictly after now + N days
  | { kind: 'noDueDate' }
  | { kind: 'overdue' }
  | { kind: 'deferred' } // defer_date in the future
  | { kind: 'blocked' } // sequential gating / unmet deps
  | { kind: 'onHold' } // carries an on-hold tag
  | { kind: 'hasTag'; tagId: string } // tag or any descendant
  | { kind: 'inProject'; projectId: string } // descends from project
  | { kind: 'isNote' } // item is a note (type === 'note')
  | { kind: 'titleContains'; text: string }
  | { kind: 'noteContains'; text: string };

export type FilterExpr =
  | { type: 'and'; children: FilterExpr[] }
  | { type: 'or'; children: FilterExpr[] }
  | { type: 'not'; child: FilterExpr }
  | { type: 'cond'; cond: Condition };

export const DAY_MS = 86_400_000;

// ----- evaluation -----------------------------------------------------------

export interface EvalCtx {
  db: Db;
  now: number;
  blockedCache: Map<string, boolean>;
  heldSet: Set<string>;
  tagExpand: (tagId: string) => Set<string>;
  projDesc: (projectId: string) => Set<string>;
  tagIdsOf: (item: Item) => Set<string>;
}

function descendantIds(db: Db, rootId: string): Set<string> {
  const set = new Set<string>();
  const queue = [rootId];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const c of getChildren(db, parent)) {
      if (!set.has(c.id)) {
        set.add(c.id);
        queue.push(c.id);
      }
    }
  }
  return set;
}

/** A reusable evaluation context with the same caches `applyFilters` keeps, so a
 *  whole filter pass shares tag/project expansion and blocking computation. */
export function makeEvalCtx(db: Db, now: number = Date.now()): EvalCtx {
  const tagCache = new Map<string, Set<string>>();
  const projCache = new Map<string, Set<string>>();
  const itemTagCache = new Map<string, Set<string>>();
  return {
    db,
    now,
    blockedCache: new Map(),
    heldSet: expandTagIds(db, [...onHoldTagIds(db)]),
    tagExpand: (tagId) => {
      let s = tagCache.get(tagId);
      if (!s) tagCache.set(tagId, (s = expandTagIds(db, [tagId])));
      return s;
    },
    projDesc: (projectId) => {
      let s = projCache.get(projectId);
      if (!s) projCache.set(projectId, (s = descendantIds(db, projectId)));
      return s;
    },
    tagIdsOf: (item) => {
      let s = itemTagCache.get(item.id);
      if (!s) itemTagCache.set(item.id, (s = new Set(getItemTags(db, item.id).map((t) => t.id))));
      return s;
    },
  };
}

function evalCondition(ctx: EvalCtx, item: Item, c: Condition): boolean {
  const dueTime = item.due_date ? new Date(item.due_date).getTime() : null;
  switch (c.kind) {
    case 'flagged':
      return item.flagged;
    case 'completed':
      return item.status === 'done';
    case 'priority':
      if (c.op === 'eq') return item.priority === c.value;
      if (c.op === 'gte') return item.priority >= c.value;
      return item.priority <= c.value;
    case 'dueWithinDays':
      return dueTime !== null && dueTime <= ctx.now + c.days * DAY_MS;
    case 'dueAfterDays':
      return dueTime !== null && dueTime > ctx.now + c.days * DAY_MS;
    case 'noDueDate':
      return dueTime === null;
    case 'overdue':
      return dueTime !== null && dueTime < ctx.now && item.status === 'active';
    case 'deferred':
      return !!item.defer_date && new Date(item.defer_date).getTime() > ctx.now;
    case 'blocked':
      return isBlocked(ctx.db, item.id, ctx.blockedCache);
    case 'onHold': {
      if (!ctx.heldSet.size) return false;
      const ids = ctx.tagIdsOf(item);
      for (const id of ids) if (ctx.heldSet.has(id)) return true;
      return false;
    }
    case 'hasTag': {
      const want = ctx.tagExpand(c.tagId);
      const ids = ctx.tagIdsOf(item);
      for (const id of ids) if (want.has(id)) return true;
      return false;
    }
    case 'inProject':
      return ctx.projDesc(c.projectId).has(item.id);
    case 'isNote':
      return item.type === 'note';
    case 'titleContains':
      return (item.title || '').toLowerCase().includes(c.text.toLowerCase());
    case 'noteContains':
      return (item.note || '').toLowerCase().includes(c.text.toLowerCase());
  }
}

export function evalExpr(ctx: EvalCtx, item: Item, expr: FilterExpr): boolean {
  switch (expr.type) {
    case 'and':
      return expr.children.every((c) => evalExpr(ctx, item, c));
    case 'or':
      return expr.children.length === 0 ? false : expr.children.some((c) => evalExpr(ctx, item, c));
    case 'not':
      return !evalExpr(ctx, item, expr.child);
    case 'cond':
      return evalCondition(ctx, item, expr.cond);
  }
}

/** Filter a candidate set by a view's prefs: the advanced expression when the view
 *  is in advanced mode (and has one), otherwise the basic flat filters. */
export function filterByPrefs(db: Db, items: Item[], prefs: ViewPrefs): Item[] {
  if (prefs.mode === 'advanced' && prefs.expr) {
    const ctx = makeEvalCtx(db);
    return items.filter((i) => evalExpr(ctx, i, prefs.expr!));
  }
  return applyFilters(db, items, prefs.filters);
}

// ----- validation (for LLM-emitted JSON) ------------------------------------

const COND_KINDS = new Set<Condition['kind']>([
  'flagged',
  'completed',
  'priority',
  'dueWithinDays',
  'dueAfterDays',
  'noDueDate',
  'overdue',
  'deferred',
  'blocked',
  'onHold',
  'hasTag',
  'inProject',
  'isNote',
  'titleContains',
  'noteContains',
]);

/** Structurally validate untrusted JSON (e.g. from the LLM helper) as a FilterExpr.
 *  Returns the typed tree or null. Bounds depth so a malicious blob can't blow the stack. */
export function validateFilterExpr(raw: unknown, depth = 0): FilterExpr | null {
  if (depth > 50 || !raw || typeof raw !== 'object') return null;
  const node = raw as Record<string, unknown>;
  switch (node.type) {
    case 'and':
    case 'or': {
      if (!Array.isArray(node.children)) return null;
      const children: FilterExpr[] = [];
      for (const c of node.children) {
        const v = validateFilterExpr(c, depth + 1);
        if (!v) return null;
        children.push(v);
      }
      return { type: node.type, children };
    }
    case 'not': {
      const child = validateFilterExpr(node.child, depth + 1);
      return child ? { type: 'not', child } : null;
    }
    case 'cond': {
      const cond = node.cond as Record<string, unknown> | undefined;
      if (!cond || typeof cond !== 'object') return null;
      if (!COND_KINDS.has(cond.kind as Condition['kind'])) return null;
      // Light per-kind coercion for the value-bearing conditions.
      if (cond.kind === 'priority') {
        const value = Number(cond.value);
        if (!Number.isFinite(value) || (cond.op !== 'eq' && cond.op !== 'gte' && cond.op !== 'lte'))
          return null;
        return { type: 'cond', cond: { kind: 'priority', op: cond.op, value } };
      }
      if (cond.kind === 'dueWithinDays' || cond.kind === 'dueAfterDays') {
        const days = Number(cond.days);
        if (!Number.isFinite(days)) return null;
        return { type: 'cond', cond: { kind: cond.kind, days } };
      }
      if (cond.kind === 'hasTag') {
        if (typeof cond.tagId !== 'string') return null;
        return { type: 'cond', cond: { kind: 'hasTag', tagId: cond.tagId } };
      }
      if (cond.kind === 'inProject') {
        if (typeof cond.projectId !== 'string') return null;
        return { type: 'cond', cond: { kind: 'inProject', projectId: cond.projectId } };
      }
      if (cond.kind === 'titleContains' || cond.kind === 'noteContains') {
        if (typeof cond.text !== 'string') return null;
        return { type: 'cond', cond: { kind: cond.kind, text: cond.text } };
      }
      // Nullary conditions.
      return { type: 'cond', cond: { kind: cond.kind as Condition['kind'] } as Condition };
    }
    default:
      return null;
  }
}

/** A short human-readable summary of an expression (for chips / previews). */
export function describeExpr(expr: FilterExpr): string {
  switch (expr.type) {
    case 'and':
      return expr.children.map(describeExpr).join(' AND ');
    case 'or':
      return '(' + expr.children.map(describeExpr).join(' OR ') + ')';
    case 'not':
      return 'NOT ' + describeExpr(expr.child);
    case 'cond':
      return describeCondition(expr.cond);
  }
}

function describeCondition(c: Condition): string {
  switch (c.kind) {
    case 'flagged':
      return 'flagged';
    case 'completed':
      return 'completed';
    case 'priority':
      return `priority ${c.op === 'eq' ? '=' : c.op === 'gte' ? '≥' : '≤'} ${c.value}`;
    case 'dueWithinDays':
      return `due within ${c.days}d`;
    case 'dueAfterDays':
      return `due after ${c.days}d`;
    case 'noDueDate':
      return 'no due date';
    case 'overdue':
      return 'overdue';
    case 'deferred':
      return 'deferred';
    case 'blocked':
      return 'blocked';
    case 'onHold':
      return 'on hold';
    case 'hasTag':
      return `tagged`;
    case 'inProject':
      return `in project`;
    case 'isNote':
      return 'is a note';
    case 'titleContains':
      return `title ~ "${c.text}"`;
    case 'noteContains':
      return `note ~ "${c.text}"`;
  }
}
