import { useEffect, useState } from 'react';
import { MapPin, Search } from 'lucide-react';
import { parseGeo } from '@carbon/core';
import { getCurrentPosition } from '../lib/location';
import { searchPlaces, type PlaceHit } from '../lib/geocode';

const inputCls =
  'w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent';

/**
 * Place-name / lat / lng / radius location editor, shared by the task and tag
 * detail panes. Inputs are edited as a set and only re-seeded when `resetKey`
 * changes (switching item), so an inbound remote edit mid-edit won't wipe
 * unsaved keystrokes. Commits the assembled GeoReminder JSON (or null to clear)
 * via `onChange` on blur / "Use my location" / "Clear".
 *
 * The name box doubles as a place search: type "Coles", hit search (button or
 * Enter), and pick a nearby match to fill lat/lng/radius with a "Name, Suburb"
 * label. Search is button/Enter-driven (not type-ahead) to respect the public
 * OSM geocoder's no-autocomplete rate policy.
 */
export function GeoEditor({
  value,
  resetKey,
  onChange,
  label = 'Location reminder',
}: {
  value: string | null;
  resetKey: string;
  onChange: (geo: string | null) => void;
  label?: string;
}) {
  const [geoLabel, setGeoLabel] = useState('');
  const [geoLat, setGeoLat] = useState('');
  const [geoLng, setGeoLng] = useState('');
  const [geoRadius, setGeoRadius] = useState('');
  const [candidates, setCandidates] = useState<PlaceHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchMsg, setSearchMsg] = useState<string | null>(null);

  useEffect(() => {
    const g = parseGeo(value);
    setGeoLabel(g?.label ?? '');
    setGeoLat(g ? String(g.lat) : '');
    setGeoLng(g ? String(g.lng) : '');
    setGeoRadius(g ? String(g.radius) : '');
    setCandidates([]);
    setSearchMsg(null);
    // Re-seed only when switching item, not on every prop tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  function commit() {
    if (!geoLat && !geoLng && !geoLabel) {
      if (value) onChange(null);
      return;
    }
    onChange(
      JSON.stringify({
        lat: Number(geoLat) || 0,
        lng: Number(geoLng) || 0,
        radius: Number(geoRadius) || 150,
        label: geoLabel.trim() || undefined,
      }),
    );
  }
  async function useMyLocation() {
    // Route through the shared helper so native (Capacitor) permission prompts work and a
    // denial/timeout surfaces a message instead of silently doing nothing.
    setSearchMsg(null);
    const pos = await getCurrentPosition({ highAccuracy: true, timeout: 15_000, maximumAge: 60_000 });
    if (!pos) {
      setSearchMsg('Couldn’t get your location — check permissions');
      return;
    }
    const lat = Number(pos.lat.toFixed(6));
    const lng = Number(pos.lng.toFixed(6));
    const radius = Number(geoRadius) || 150;
    setGeoLat(String(lat));
    setGeoLng(String(lng));
    setGeoRadius(String(radius));
    onChange(JSON.stringify({ lat, lng, radius, label: geoLabel.trim() || undefined }));
  }
  function clearGeo() {
    setGeoLabel('');
    setGeoLat('');
    setGeoLng('');
    setGeoRadius('');
    setCandidates([]);
    setSearchMsg(null);
    onChange(null);
  }

  async function runSearch() {
    const q = geoLabel.trim();
    if (!q || searching) return;
    setSearching(true);
    setSearchMsg(null);
    setCandidates([]);
    try {
      // Bias the lookup to where we are now; fall back to coords already in the box.
      let near = await getCurrentPosition({ highAccuracy: false, timeout: 15_000, maximumAge: 60_000 });
      if (!near) {
        const lat = Number(geoLat);
        const lng = Number(geoLng);
        if (Number.isFinite(lat) && Number.isFinite(lng) && (geoLat || geoLng)) {
          near = { lat, lng };
        }
      }
      if (!near) {
        setSearchMsg('Enable location to search');
        return;
      }
      const { candidates: hits, error } = await searchPlaces(q, near);
      if (error === 'geocoding_disabled') {
        setSearchMsg('Place search is turned off on this server');
      } else if (error) {
        setSearchMsg('Search failed — try again');
      } else if (hits.length === 0) {
        setSearchMsg('No matches near you');
      } else {
        setCandidates(hits);
      }
    } finally {
      setSearching(false);
    }
  }

  function pick(c: PlaceHit) {
    setGeoLat(String(c.lat));
    setGeoLng(String(c.lng));
    setGeoLabel(c.label);
    // Keep a user-entered radius; otherwise take the candidate's default.
    const radius = geoRadius || String(c.radius);
    setGeoRadius(radius);
    setCandidates([]);
    setSearchMsg(null);
    onChange(JSON.stringify({ lat: c.lat, lng: c.lng, radius: Number(radius) || 150, label: c.label }));
  }

  return (
    <div>
      <div className="mb-1 text-xs font-medium text-text-muted">
        <span className="inline-flex items-center gap-1">
          <MapPin size={12} /> {label}
        </span>
      </div>
      <div className="flex gap-2">
        <input
          className={inputCls}
          placeholder="Place or HA zone name (e.g. Home)"
          value={geoLabel}
          onChange={(e) => setGeoLabel(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void runSearch();
            }
          }}
        />
        <button
          onClick={() => void runSearch()}
          disabled={!geoLabel.trim() || searching}
          title="Search for this place near you"
          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs hover:bg-surface-2 disabled:opacity-50"
        >
          <Search size={14} /> {searching ? 'Searching…' : 'Search'}
        </button>
      </div>
      {searchMsg && <div className="mt-1 text-xs text-text-muted">{searchMsg}</div>}
      {candidates.length > 0 && (
        <ul className="mt-1 overflow-hidden rounded-lg border border-border">
          {candidates.map((c, i) => (
            <li key={i}>
              <button
                onClick={() => pick(c)}
                className="block w-full border-b border-border px-2.5 py-1.5 text-left text-sm last:border-b-0 hover:bg-surface-2"
              >
                {c.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 grid grid-cols-3 gap-2">
        <input
          className={inputCls}
          placeholder="lat"
          value={geoLat}
          onChange={(e) => setGeoLat(e.target.value)}
          onBlur={commit}
        />
        <input
          className={inputCls}
          placeholder="lng"
          value={geoLng}
          onChange={(e) => setGeoLng(e.target.value)}
          onBlur={commit}
        />
        <input
          className={inputCls}
          placeholder="radius m"
          value={geoRadius}
          onChange={(e) => setGeoRadius(e.target.value)}
          onBlur={commit}
        />
      </div>
      <div className="mt-2 flex gap-2">
        <button
          onClick={() => void useMyLocation()}
          className="rounded-lg border border-border px-2.5 py-1 text-xs hover:bg-surface-2"
        >
          Use my location
        </button>
        {(geoLat || geoLabel) && (
          <button
            onClick={clearGeo}
            className="rounded-lg border border-border px-2.5 py-1 text-xs text-text-muted hover:bg-surface-2"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
