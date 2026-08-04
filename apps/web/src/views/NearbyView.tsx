import { useState } from 'react';
import { MapPin } from 'lucide-react';
import { tasksNearLocation } from '@carbon/core';
import { useQuery } from '@/hooks/useQuery';
import { useWhere } from '@/hooks/useWhere';
import { PlanList, GroupingToggle, planEntry } from '@/components/PlanList';
import { LocationSources } from '@/components/LocationSources';
import { refreshWhere } from '@/lib/where';
import { geolocationSupported } from '@/lib/location';
import { btnPrimary } from '@/components/ui/controls';
import { cn } from '@/lib/cn';

/** Round a coordinate to ~5 decimal places (≈1m) for display. */
const fmtCoord = (n: number) => n.toFixed(5);

export function NearbyView() {
  const where = useWhere();
  const [requesting, setRequesting] = useState(false);

  const data = useQuery(
    (db) => {
      if (!where.zone && !where.point) return { entries: [] };
      const tasks = tasksNearLocation(db, { zone: where.zone, point: where.point });
      return { entries: tasks.map((t) => planEntry(db, t)) };
    },
    [where.zone, where.point?.lat, where.point?.lng],
  );

  const gpsLabel = where.point
    ? where.place ?? `${fmtCoord(where.point.lat)}, ${fmtCoord(where.point.lng)}`
    : null;

  async function enableLocation() {
    setRequesting(true);
    try {
      refreshWhere();
      // Give the async resolve a moment so the button isn't a no-op flash.
      await new Promise((r) => setTimeout(r, 800));
    } finally {
      setRequesting(false);
    }
  }

  // Wait until resolution has run at least once so we don't flash the empty
  // state before the first GPS/HA fetch lands.
  if (!where.resolved) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <MapPin size={22} className="text-accent" />
          Nearby
        </h1>
        <p className="mt-4 text-sm text-text-muted">Finding your location…</p>
      </div>
    );
  }

  if (!where.hasLocation) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <MapPin size={22} className="text-accent" />
          Nearby
        </h1>
        <div className="mt-6 rounded-xl border border-dashed border-border px-4 py-10 text-center">
          <p className="text-sm text-text-muted">
            Nearby shows tasks tagged or located near where you are. Carbon needs
            location access (this device&apos;s GPS, or a linked Home Assistant
            zone) to match them.
          </p>
          {geolocationSupported() && (
            <button
              type="button"
              className={cn(btnPrimary, 'mt-4')}
              disabled={requesting}
              onClick={() => void enableLocation()}
            >
              {requesting ? 'Requesting…' : 'Enable location'}
            </button>
          )}
          {!geolocationSupported() && (
            <p className="mt-3 text-xs text-text-faint">
              This browser doesn&apos;t support geolocation. Link a location source
              in Settings, or open Carbon on a device that can share GPS.
            </p>
          )}
        </div>
      </div>
    );
  }

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
