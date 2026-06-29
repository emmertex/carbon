import { useState, type ReactNode } from 'react';
import { Home, Satellite, Smartphone, Laptop } from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  GPS_ACCURACY_LIMIT_M,
  ZONE_KEY,
  isFixStale,
  isFixTooInaccurate,
  toggleSource,
  type DeviceFix,
  type SourceKey,
  type WhereState,
} from '@/lib/where';

/** Round a coordinate to ~5 decimal places (≈1m) for display. */
const fmtCoord = (n: number) => n.toFixed(5);

/** Human accuracy, e.g. "±42 m" or "±8.3 km". */
function fmtAccuracy(accuracy: number | null): string {
  if (accuracy == null) return 'accuracy unknown';
  return accuracy >= 1000 ? `±${(accuracy / 1000).toFixed(1)} km` : `±${Math.round(accuracy)} m`;
}

/** Compact human age, e.g. "just now", "4 min ago", "2 h ago". */
function ago(updatedAt: number): string {
  const s = Math.max(0, Math.round((Date.now() - updatedAt) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

interface Source {
  key: SourceKey;
  label: string;
  icon: ReactNode;
  active: boolean;
  /** Detail lines shown in the hover tooltip. */
  lines: string[];
  /** Why the source is auto on/off, shown under the detail lines. */
  status: string;
}

/** Build the tooltip detail lines + auto-status note for a device GPS source. */
function gpsSource(
  key: SourceKey,
  label: string,
  icon: ReactNode,
  g: Pick<DeviceFix, 'lat' | 'lng' | 'accuracy' | 'updatedAt'>,
  active: boolean,
  overridden: boolean,
): Source {
  const stale = isFixStale(g.updatedAt);
  const inaccurate = isFixTooInaccurate(g.accuracy);
  let status: string;
  if (overridden) {
    status = active ? 'Manually enabled' : 'Manually disabled';
  } else if (inaccurate) {
    status = `Auto-disabled — exceeds ${GPS_ACCURACY_LIMIT_M / 1000} km accuracy limit`;
  } else if (stale) {
    status = 'Auto-disabled — fix is stale';
  } else {
    status = 'Active (automatic)';
  }
  return {
    key,
    label,
    icon,
    active,
    lines: [`${fmtCoord(g.lat)}, ${fmtCoord(g.lng)}`, fmtAccuracy(g.accuracy), `updated ${ago(g.updatedAt)}`],
    status,
  };
}

/** Pill label + icon for a device by its provenance. */
function deviceLabel(d: DeviceFix): { label: string; icon: ReactNode } {
  if (d.source === 'ha') return { label: d.name || 'HA GPS', icon: <Satellite size={15} /> };
  if (d.source === 'self') return { label: d.name || 'This device', icon: <Smartphone size={15} /> };
  return { label: d.name || 'Device', icon: <Laptop size={15} /> };
}

/**
 * Toggleable location-source pills for the Nearby view: the HA zone plus one pill per
 * fresh device (HA tracker, this device, other signed-in devices). Tapping a pill
 * enables/disables that source, overriding the automatic hierarchy. Sources are active
 * by default when fresh + accurate enough; a stale or too-inaccurate fix is auto-disabled.
 * Hover/focus reveals coordinates, accuracy, age, and why the source is on or off.
 */
export function LocationSources({ where }: { where: WhereState }) {
  const sources: Source[] = [];

  if (where.haZone) {
    const overridden = where.overrides[ZONE_KEY] !== undefined;
    sources.push({
      key: ZONE_KEY,
      label: 'HA Zone',
      icon: <Home size={15} />,
      active: !!where.active[ZONE_KEY],
      lines: [where.haZone.name, `updated ${ago(where.haZone.updatedAt)}`],
      status: overridden
        ? where.active[ZONE_KEY]
          ? 'Manually enabled'
          : 'Manually disabled'
        : 'Active (automatic)',
    });
  }

  for (const d of where.devices) {
    const { label, icon } = deviceLabel(d);
    sources.push(
      gpsSource(
        d.deviceId,
        label,
        icon,
        d,
        !!where.active[d.deviceId],
        where.overrides[d.deviceId] !== undefined,
      ),
    );
  }

  if (sources.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {sources.map((s) => (
        <SourcePill key={s.key} source={s} />
      ))}
    </div>
  );
}

function SourcePill({ source }: { source: Source }) {
  const [open, setOpen] = useState(false);
  const { active } = source;

  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={() => toggleSource(source.key)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        aria-pressed={active}
        title={`${source.label} — tap to ${active ? 'disable' : 'enable'}`}
        className={cn(
          'flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium',
          active
            ? 'border-accent bg-accent-soft text-accent'
            : 'border-border text-text-faint hover:bg-surface-2',
        )}
      >
        <span className={active ? '' : 'opacity-70'}>{source.icon}</span>
        <span className={active ? '' : 'line-through decoration-1'}>{source.label}</span>
      </button>
      {open && (
        <div
          role="tooltip"
          className="absolute left-0 top-full z-30 mt-1 w-max max-w-[16rem] rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-lg"
        >
          <p className="font-semibold text-text">{source.label}</p>
          {source.lines.map((line, i) => (
            <p key={i} className="mt-0.5 tabular-nums text-text-muted">
              {line}
            </p>
          ))}
          <p className={'mt-1 ' + (active ? 'text-accent' : 'text-text-faint')}>{source.status}</p>
        </div>
      )}
    </div>
  );
}
