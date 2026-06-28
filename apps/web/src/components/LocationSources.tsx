import { useState, type ReactNode } from 'react';
import { Home, Satellite, Smartphone } from 'lucide-react';
import { isFixStale, type WhereState } from '@/lib/where';

/** Round a coordinate to ~5 decimal places (≈1m) for display. */
const fmtCoord = (n: number) => n.toFixed(5);

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
  key: string;
  label: string;
  icon: ReactNode;
  lines: string[];
}

/**
 * Up to three location-source pills (HA Zone, HA GPS, Device GPS) for the Nearby
 * view. Each reveals its accuracy / exact coordinates / age on hover (desktop) or
 * tap (touch). A source is omitted entirely when it has no data, and GPS sources
 * are omitted when their fix is stale (see GPS_STALE_MS). Zones are event-driven
 * (cleared on leave) so they show whenever present.
 */
export function LocationSources({ where }: { where: WhereState }) {
  const sources: Source[] = [];

  if (where.haZone) {
    sources.push({
      key: 'ha-zone',
      label: 'HA Zone',
      icon: <Home size={15} />,
      lines: [where.haZone.name, `updated ${ago(where.haZone.updatedAt)}`],
    });
  }

  if (where.haGps && !isFixStale(where.haGps.updatedAt)) {
    const g = where.haGps;
    sources.push({
      key: 'ha-gps',
      label: 'HA GPS',
      icon: <Satellite size={15} />,
      lines: [
        `${fmtCoord(g.lat)}, ${fmtCoord(g.lng)}`,
        g.accuracy != null ? `±${Math.round(g.accuracy)} m accuracy` : 'accuracy unknown',
        `updated ${ago(g.updatedAt)}`,
      ],
    });
  }

  if (where.deviceGps && !isFixStale(where.deviceGps.updatedAt)) {
    const g = where.deviceGps;
    sources.push({
      key: 'device-gps',
      label: 'Device GPS',
      icon: <Smartphone size={15} />,
      lines: [
        `${fmtCoord(g.lat)}, ${fmtCoord(g.lng)}`,
        g.accuracy != null ? `±${Math.round(g.accuracy)} m accuracy` : 'accuracy unknown',
        `updated ${ago(g.updatedAt)}`,
      ],
    });
  }

  if (sources.length === 0) return null;

  return (
    <div className="mt-2 flex items-center gap-1.5">
      {sources.map((s) => (
        <SourcePill key={s.key} source={s} />
      ))}
    </div>
  );
}

function SourcePill({ source }: { source: Source }) {
  const [open, setOpen] = useState(false);

  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={source.label}
        aria-expanded={open}
        className="flex h-7 w-7 items-center justify-center rounded-full border border-border bg-surface text-text-muted hover:border-accent hover:text-accent"
      >
        {source.icon}
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
        </div>
      )}
    </div>
  );
}
