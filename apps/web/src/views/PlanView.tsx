import {
  listPlan,
  getItem,
  PLAN_DEFAULT_STARTUP_MIN,
  PLAN_DEFAULT_ESTIMATE_MIN,
  type Item,
} from '@carbon/core';
import { useQuery } from '@/hooks/useQuery';
import { useStore, getCurrentUserId } from '@/lib/store';
import { PlanList, GroupingToggle, planEntry } from '@/components/PlanList';
import { formatMinutes } from '@/lib/date';

export function PlanView() {
  const startup = useStore((s) => s.currentUser?.plan_startup_min ?? PLAN_DEFAULT_STARTUP_MIN);
  const defaultEst = useStore(
    (s) => s.currentUser?.plan_default_estimate_min ?? PLAN_DEFAULT_ESTIMATE_MIN,
  );

  const data = useQuery((db) => {
    const uid = getCurrentUserId();
    const today = new Date().toISOString().slice(0, 10);
    const rows = listPlan(db, uid)
      .map((p) => ({ item: getItem(db, p.item_id), added: p.added_at }))
      .filter(
        (x): x is { item: Item; added: string } =>
          !!x.item && !x.item.deleted && x.item.status === 'active',
      );
    const carried = rows.filter((x) => x.added.slice(0, 10) < today).map((x) => planEntry(db, x.item));
    const todays = rows.filter((x) => x.added.slice(0, 10) >= today).map((x) => planEntry(db, x.item));
    const all = rows.map((x) => x.item);

    return {
      carried,
      todays,
      budgetMin: all.reduce((s, it) => s + startup + (it.estimate_minutes ?? defaultEst), 0),
      count: all.length,
    };
  }, [startup, defaultEst]);

  if (!data) return null;
  const empty = data.carried.length === 0 && data.todays.length === 0;

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Plan</h1>
          <p className="mt-0.5 text-sm text-text-muted">
            Hand-picked tasks for focus. Unfinished ones carry to the next day.
          </p>
        </div>
        {data.count > 0 && (
          <div className="shrink-0 text-right text-sm">
            <div className="font-semibold tabular-nums text-text">{formatMinutes(data.budgetMin)}</div>
            <div className="text-xs text-text-faint">
              {data.count} task{data.count === 1 ? '' : 's'} budgeted
            </div>
          </div>
        )}
      </div>

      {!empty && <GroupingToggle className="mb-3" />}

      {empty ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-text-muted">
          Nothing planned yet. Add tasks from their detail pane or the row ⋯ menu.
        </div>
      ) : (
        <div className="space-y-4">
          {data.carried.length > 0 && (
            <section>
              <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-warning">
                Carried over
                <span className="rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium normal-case">
                  {data.carried.length}
                </span>
              </div>
              <PlanList entries={data.carried} />
            </section>
          )}
          {data.todays.length > 0 && (
            <section>
              {data.carried.length > 0 && (
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-faint">
                  Added today
                </div>
              )}
              <PlanList entries={data.todays} />
            </section>
          )}
        </div>
      )}

      <p className="mt-4 text-xs text-text-faint">
        Budget = per-task start-up ({startup}m) + estimate (or {defaultEst}m default). Adjust in
        Settings.
      </p>
    </div>
  );
}
