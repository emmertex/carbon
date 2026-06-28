import { Navigate } from 'react-router-dom';
import { MapPin } from 'lucide-react';
import { tasksNearLocation } from '@carbon/core';
import { useQuery } from '@/hooks/useQuery';
import { useWhere } from '@/hooks/useWhere';
import { PlanList, GroupingToggle, planEntry } from '@/components/PlanList';
import { LocationSources } from '@/components/LocationSources';

/** Round a coordinate to ~5 decimal places (≈1m) for display. */
const fmtCoord = (n: number) => n.toFixed(5);

export function NearbyView() {
  const where = useWhere();

  const data = useQuery(
    (db) => {
      if (!where.zone && !where.point) return { entries: [] };
      const tasks = tasksNearLocation(db, { zone: where.zone, point: where.point });
      return { entries: tasks.map((t) => planEntry(db, t)) };
    },
    [where.zone, where.point?.lat, where.point?.lng],
  );

  // The nav item is hidden when there's no location, but a user could still hit the
  // route directly — redirect there is nothing to show. Wait until resolution has
  // run at least once so we don't bounce away before the first fetch lands.
  if (where.resolved && !where.hasLocation) return <Navigate to="/today" replace />;

  const gpsLabel = where.point
    ? where.place ?? `${fmtCoord(where.point.lat)}, ${fmtCoord(where.point.lng)}`
    : null;

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
      <div className="mb-3">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <MapPin size={22} className="text-accent" />
          Nearby
        </h1>
        <div className="mt-1 text-sm text-text-muted">
          {where.zone ? (
            <p>
              You appear to be at <span className="font-semibold text-text">{where.zone}</span>.
            </p>
          ) : (
            <p>Tasks for where you are right now.</p>
          )}
          {gpsLabel && <p className="mt-0.5 text-text-faint">{gpsLabel}</p>}
        </div>
        <LocationSources where={where} />
      </div>

      {data && data.entries.length > 0 && <GroupingToggle className="mb-3" />}

      {!data || data.entries.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-text-muted">
          No tasks for where you are.
        </div>
      ) : (
        <PlanList entries={data.entries} />
      )}
    </div>
  );
}
