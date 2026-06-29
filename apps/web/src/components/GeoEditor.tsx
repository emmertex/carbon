import { useEffect, useState } from 'react';
import { MapPin } from 'lucide-react';
import { parseGeo } from '@carbon/core';

const inputCls =
  'w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent';

/**
 * Place-name / lat / lng / radius location editor, shared by the task and tag
 * detail panes. Inputs are edited as a set and only re-seeded when `resetKey`
 * changes (switching item), so an inbound remote edit mid-edit won't wipe
 * unsaved keystrokes. Commits the assembled GeoReminder JSON (or null to clear)
 * via `onChange` on blur / "Use my location" / "Clear".
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

  useEffect(() => {
    const g = parseGeo(value);
    setGeoLabel(g?.label ?? '');
    setGeoLat(g ? String(g.lat) : '');
    setGeoLng(g ? String(g.lng) : '');
    setGeoRadius(g ? String(g.radius) : '');
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
  function useMyLocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((pos) => {
      const lat = Number(pos.coords.latitude.toFixed(6));
      const lng = Number(pos.coords.longitude.toFixed(6));
      const radius = Number(geoRadius) || 150;
      setGeoLat(String(lat));
      setGeoLng(String(lng));
      setGeoRadius(String(radius));
      onChange(JSON.stringify({ lat, lng, radius, label: geoLabel.trim() || undefined }));
    });
  }
  function clearGeo() {
    setGeoLabel('');
    setGeoLat('');
    setGeoLng('');
    setGeoRadius('');
    onChange(null);
  }

  return (
    <div>
      <div className="mb-1 text-xs font-medium text-text-muted">
        <span className="inline-flex items-center gap-1">
          <MapPin size={12} /> {label}
        </span>
      </div>
      <input
        className={inputCls}
        placeholder="Place or HA zone name (e.g. Home)"
        value={geoLabel}
        onChange={(e) => setGeoLabel(e.target.value)}
        onBlur={commit}
      />
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
          onClick={useMyLocation}
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
