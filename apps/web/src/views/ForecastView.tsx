import { useState, useRef, useLayoutEffect } from 'react';
import {
  format,
  isToday,
  isTomorrow,
  addDays,
  addMonths,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import { ChevronLeft, ChevronRight, Lock, ArrowRight } from 'lucide-react';
import {
  allItems,
  isActive,
  isOverdue,
  getPredecessors,
  getSuccessors,
  type Item,
} from '@carbon/core';
import { useQuery } from '@/hooks/useQuery';
import { enrichItems } from '@/lib/enrich';
import { PlanList, GroupingToggle, planEntry } from '@/components/PlanList';
import { TaskRow, type TaskRowData } from '@/components/TaskRow';
import { cn } from '@/lib/cn';
import { Chip } from '@/components/Chip';
import { SegmentedControl } from '@/components/ui/SegmentedControl';

const SEQ_DAYS = 7;
/** Parse a 'yyyy-MM-dd' key as a *local* midnight (avoids UTC day-drift). */
const keyToLocalDate = (k: string) => new Date(`${k}T00:00:00`);

interface DepRef {
  id: string;
  title: string;
  done?: boolean;
  inView: boolean;
}
interface DepInfo {
  predecessors: DepRef[];
  successors: DepRef[];
}

const DAYS = 14;
const dayKey = (iso: string) => format(new Date(iso), 'yyyy-MM-dd');
const byTime = (a: Item, b: Item, field: 'due_date' | 'defer_date') =>
  new Date(a[field]!).getTime() - new Date(b[field]!).getTime();

function dayLabel(date: Date): string {
  if (isToday(date)) return 'Today';
  if (isTomorrow(date)) return 'Tomorrow';
  return format(date, 'EEE d');
}

const todayKey = () => format(startOfDay(new Date()), 'yyyy-MM-dd');

export function ForecastView() {
  const [selected, setSelected] = useState<string>(todayKey);
  const [view, setView] = useState<'ribbon' | 'month' | 'sequence'>('ribbon');
  const [monthOffset, setMonthOffset] = useState(0);

  const data = useQuery(
    (db) => {
      const tasks = allItems(db).filter((i) => i.type === 'task' && isActive(i) && !i.deleted);
      const overdue = tasks.filter((t) => isOverdue(t));
      const overdueIds = new Set(overdue.map((t) => t.id));

      // Per-day counts across every scheduled task (drives both ribbon and grid).
      const counts = new Map<string, { due: number; defer: number }>();
      const bump = (k: string, f: 'due' | 'defer') => {
        const c = counts.get(k) ?? { due: 0, defer: 0 };
        c[f]++;
        counts.set(k, c);
      };
      for (const t of tasks) {
        if (t.due_date && !overdueIds.has(t.id)) bump(dayKey(t.due_date), 'due');
        if (t.defer_date) bump(dayKey(t.defer_date), 'defer');
      }
      const dayCount = (k: string) => {
        const c = counts.get(k);
        return (c?.due ?? 0) + (c?.defer ?? 0);
      };

      const today = startOfDay(new Date());
      const ribbon = Array.from({ length: DAYS }, (_, i) => {
        const date = addDays(today, i);
        const key = format(date, 'yyyy-MM-dd');
        return { key, label: dayLabel(date), count: dayCount(key) };
      });

      // 6-week grid for the displayed month (Sunday-first), with leading/trailing days.
      const monthBase = startOfMonth(addMonths(today, monthOffset));
      const gridStart = startOfWeek(monthBase);
      const weeks = Array.from({ length: 6 }, (_, w) =>
        Array.from({ length: 7 }, (_, d) => {
          const date = addDays(gridStart, w * 7 + d);
          const key = format(date, 'yyyy-MM-dd');
          return {
            key,
            day: date.getDate(),
            inMonth: date.getMonth() === monthBase.getMonth(),
            today: isToday(date),
            count: dayCount(key),
          };
        }),
      );

      const sel = selected;
      const selDue =
        sel === 'overdue'
          ? []
          : tasks
              .filter((t) => t.due_date && !overdueIds.has(t.id) && dayKey(t.due_date) === sel)
              .sort((a, b) => byTime(a, b, 'due_date'))
              .map((t) => planEntry(db, t));
      const selDefer =
        sel === 'overdue'
          ? []
          : tasks
              .filter((t) => t.defer_date && dayKey(t.defer_date) === sel)
              .sort((a, b) => byTime(a, b, 'defer_date'))
              .map((t) => planEntry(db, t));

      // Sequence: the selected day + the following SEQ_DAYS-1 days, each day a
      // group of its scheduled (due or becoming-available) tasks, annotated with
      // dependency links so the chain of work is visible.
      const seqStart = sel === 'overdue' ? today : startOfDay(keyToLocalDate(sel));
      const seqDays = Array.from({ length: SEQ_DAYS }, (_, i) => {
        const date = addDays(seqStart, i);
        const key = format(date, 'yyyy-MM-dd');
        const dayTasks = tasks.filter(
          (t) =>
            (t.due_date && !overdueIds.has(t.id) && dayKey(t.due_date) === key) ||
            (t.defer_date && dayKey(t.defer_date) === key),
        );
        // A task could match by both due and defer on the same day — dedupe.
        const seen = new Set<string>();
        const unique = dayTasks.filter((t) => (seen.has(t.id) ? false : seen.add(t.id)));
        return { key, label: dayLabel(date), items: enrichItems(db, unique) };
      });

      const visibleIds = new Set(seqDays.flatMap((d) => d.items.map((r) => r.item.id)));
      const deps: Record<string, DepInfo> = {};
      for (const d of seqDays) {
        for (const row of d.items) {
          deps[row.item.id] = {
            predecessors: getPredecessors(db, row.item.id).map((p) => ({
              id: p.id,
              title: p.title,
              done: p.status === 'done',
              inView: visibleIds.has(p.id),
            })),
            successors: getSuccessors(db, row.item.id).map((s) => ({
              id: s.id,
              title: s.title,
              inView: visibleIds.has(s.id),
            })),
          };
        }
      }

      return {
        overdue: [...overdue]
          .sort((a, b) => byTime(a, b, 'due_date'))
          .map((t) => planEntry(db, t)),
        ribbon,
        weeks,
        monthLabel: format(monthBase, 'MMMM yyyy'),
        sel,
        selDue,
        selDefer,
        seqDays,
        deps,
      };
    },
    [selected, monthOffset],
    'forecast.data',
  );

  if (!data) return null;
  const showOverdue = selected === 'overdue';

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Forecast</h1>
          <p className="mt-0.5 text-sm text-text-muted">Due and deferred tasks by day.</p>
        </div>
        <SegmentedControl<'ribbon' | 'month' | 'sequence'>
          value={view}
          onChange={setView}
          segmentClassName="px-2.5 capitalize"
          options={[
            { value: 'ribbon', label: 'ribbon' },
            { value: 'month', label: 'month' },
            { value: 'sequence', label: 'sequence' },
          ]}
        />
      </div>

      {view !== 'month' ? (
        <div className="mb-4 flex gap-1.5 overflow-x-auto pb-1">
          {data.overdue.length > 0 && view === 'ribbon' && (
            <DayChip
              label="Overdue"
              count={data.overdue.length}
              active={showOverdue}
              danger
              onClick={() => setSelected('overdue')}
            />
          )}
          {data.ribbon.map((d) => (
            <DayChip
              key={d.key}
              label={d.label}
              count={d.count}
              active={!showOverdue && data.sel === d.key}
              onClick={() => setSelected(d.key)}
            />
          ))}
        </div>
      ) : (
        <div className="mb-4">
          <div className="mb-2 flex items-center justify-between">
            <button
              onClick={() => setMonthOffset((m) => m - 1)}
              className="rounded-lg p-1 text-text-muted hover:bg-surface-2"
              aria-label="Previous month"
            >
              <ChevronLeft size={18} />
            </button>
            <span className="text-sm font-semibold">{data.monthLabel}</span>
            <button
              onClick={() => setMonthOffset((m) => m + 1)}
              className="rounded-lg p-1 text-text-muted hover:bg-surface-2"
              aria-label="Next month"
            >
              <ChevronRight size={18} />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-text-faint">
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
              <div key={i}>{d}</div>
            ))}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-1">
            {data.weeks.flat().map((c) => {
              const active = !showOverdue && data.sel === c.key;
              return (
                <button
                  key={c.key}
                  onClick={() => setSelected(c.key)}
                  className={cn(
                    'flex aspect-square flex-col items-center justify-center rounded-lg border text-xs',
                    active
                      ? 'border-accent bg-accent-soft text-accent'
                      : 'border-transparent hover:bg-surface-2',
                    !c.inMonth && 'text-text-faint',
                    c.today && !active && 'border-border',
                  )}
                >
                  <span className={cn(c.today && 'font-bold')}>{c.day}</span>
                  {c.count > 0 && (
                    <span
                      className={cn('mt-0.5 h-1.5 w-1.5 rounded-full', active ? 'bg-accent' : 'bg-accent/60')}
                      title={`${c.count} scheduled`}
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {view === 'sequence' ? (
        <SequenceList days={data.seqDays} deps={data.deps} />
      ) : showOverdue ? (
        <>
          <GroupingToggle className="mb-3" />
          <PlanList entries={data.overdue} />
        </>
      ) : (
        <>
          {(data.selDue.length > 0 || data.selDefer.length > 0) && (
            <GroupingToggle className="mb-3" />
          )}
          {data.selDue.length > 0 && (
            <Group label="Due">
              <PlanList entries={data.selDue} />
            </Group>
          )}
          {data.selDefer.length > 0 && (
            <Group label="Becomes available">
              <PlanList entries={data.selDefer} />
            </Group>
          )}
          {data.selDue.length === 0 && data.selDefer.length === 0 && (
            <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-text-muted">
              Nothing scheduled for this day.
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** The Sequence body: days stacked vertically, each task annotated with its
 *  dependency links. In-view edges are drawn as connectors in the left gutter;
 *  links whose other end isn't in the current window show as labelled chips. */
function SequenceList({
  days,
  deps,
}: {
  days: { key: string; label: string; items: TaskRowData[] }[];
  deps: Record<string, DepInfo>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const empty = days.every((d) => d.items.length === 0);
  if (empty) {
    return (
      <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-text-muted">
        Nothing scheduled in this window.
      </div>
    );
  }
  return (
    <div ref={containerRef} className="relative pl-6">
      <DepConnectors containerRef={containerRef} deps={deps} />
      {days.map((d) => (
        <div key={d.key} className="mb-4">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-faint">
            {d.label}
          </h3>
          {d.items.length === 0 ? (
            <p className="px-3 py-1 text-xs text-text-faint">—</p>
          ) : (
            d.items.map((row) => {
              const dep = deps[row.item.id];
              const offPreds = dep?.predecessors.filter((p) => !p.inView && !p.done) ?? [];
              const offSuccs = dep?.successors.filter((s) => !s.inView) ?? [];
              return (
                <div key={row.item.id} data-dep-id={row.item.id}>
                  <TaskRow {...row} showProject />
                  {(offPreds.length > 0 || offSuccs.length > 0) && (
                    <div className="flex flex-wrap gap-1.5 px-3 pb-1 pl-9 text-[11px] text-text-faint">
                      {offPreds.map((p) => (
                        <span key={p.id} className="flex items-center gap-1">
                          <Lock size={10} /> blocked by “{p.title || 'Untitled'}”
                        </span>
                      ))}
                      {offSuccs.map((s) => (
                        <span key={s.id} className="flex items-center gap-1">
                          <ArrowRight size={10} /> blocks “{s.title || 'Untitled'}”
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      ))}
    </div>
  );
}

/** SVG overlay drawing predecessor->successor curves in the left gutter for
 *  edges whose both endpoints are rendered in the current Sequence window. */
function DepConnectors({
  containerRef,
  deps,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  deps: Record<string, DepInfo>;
}) {
  const [paths, setPaths] = useState<{ d: string }[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const centerY = (id: string): number | null => {
        const el = container.querySelector<HTMLElement>(`[data-dep-id="${id}"]`);
        if (!el) return null;
        return el.offsetTop + el.offsetHeight / 2;
      };
      const next: { d: string }[] = [];
      // Draw each in-view edge once (keyed off the successor's predecessors).
      for (const [succId, info] of Object.entries(deps)) {
        const ys = centerY(succId);
        if (ys === null) continue;
        for (const pred of info.predecessors) {
          if (!pred.inView) continue;
          const yp = centerY(pred.id);
          if (yp === null) continue;
          // A curve hugging the left gutter from predecessor down to successor.
          const x = 10;
          next.push({ d: `M ${x} ${yp} C ${x - 8} ${(yp + ys) / 2}, ${x - 8} ${(yp + ys) / 2}, ${x} ${ys}` });
        }
      }
      setPaths(next);
      setSize({ w: container.offsetWidth, h: container.offsetHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    return () => ro.disconnect();
  }, [containerRef, deps]);

  if (!paths.length) return null;
  return (
    <svg
      className="pointer-events-none absolute left-0 top-0"
      width={size.w}
      height={size.h}
      aria-hidden
    >
      <defs>
        <marker id="dep-arrow" markerWidth="6" markerHeight="6" refX="4" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="var(--accent)" />
        </marker>
      </defs>
      {paths.map((p, i) => (
        <path
          key={i}
          d={p.d}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={1.5}
          opacity={0.7}
          markerEnd="url(#dep-arrow)"
        />
      ))}
    </svg>
  );
}

function DayChip({
  label,
  count,
  active,
  danger,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <Chip
      active={active}
      onClick={onClick}
      className={cn(
        'shrink-0 flex-col gap-0.5 rounded-lg px-3 py-1.5',
        danger && !active && 'text-danger',
      )}
    >
      <span className="font-medium">{label}</span>
      <span className={cn('font-normal tabular-nums', count === 0 && 'text-text-faint')}>
        {count}
      </span>
    </Chip>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-faint">
        {label}
      </div>
      {children}
    </div>
  );
}
