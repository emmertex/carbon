import { useEffect, useState } from 'react';
import { Smartphone, Satellite, Laptop, Trash2, RotateCcw, Check } from 'lucide-react';
import {
  getDeviceId,
  getDeviceName,
  setDeviceName,
  regenerateDeviceId,
} from '@/lib/device';
import { fetchDevices, removeDevice, refreshWhere, type DeviceFix } from '@/lib/where';
import { cn } from '@/lib/cn';
import { SettingsSection } from './settings/SettingsSection';
import { inputCls, ErrorText } from './settings/controls';
import { useSavedFlash } from './settings/useSavedFlash';

function ago(updatedAt: number): string {
  const s = Math.max(0, Math.round((Date.now() - updatedAt) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function icon(source: DeviceFix['source']) {
  if (source === 'ha') return <Satellite size={15} className="text-text-muted" />;
  if (source === 'self') return <Smartphone size={15} className="text-accent" />;
  return <Laptop size={15} className="text-text-muted" />;
}

/**
 * "This device" settings: name + id for the current browser/install (a location source
 * the user can label), plus the list of all the account's known devices with a remove
 * button. Each device pushes its own GPS to the server so the Nearby view can show one
 * pill per device.
 */
export function ThisDevice() {
  const [name, setName] = useState(getDeviceName());
  const [devices, setDevices] = useState<DeviceFix[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, flashSaved] = useSavedFlash();
  const myId = getDeviceId();

  async function reload() {
    try {
      setDevices(await fetchDevices());
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    void reload();
  }, []);

  function saveName() {
    setDeviceName(name.trim() || null);
    refreshWhere(); // re-report this device under the new name
    flashSaved();
  }

  function regenerate() {
    if (!window.confirm('Generate a new id for this device? The old entry will age out.')) return;
    regenerateDeviceId();
    refreshWhere();
    void reload();
  }

  async function remove(deviceId: string) {
    setError(null);
    try {
      await removeDevice(deviceId);
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <SettingsSection
      id="this-device"
      title="This device"
      description="Name this device and manage the devices that report your location for the Nearby view. Each device sends its own GPS to the server so they appear as separate, toggleable sources."
    >
      <div className="space-y-4">
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Device name</span>
          <div className="flex items-center gap-2">
            <input
              className={cn(inputCls, 'flex-1')}
              placeholder="e.g. Andrew's Pixel"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => e.key === 'Enter' && saveName()}
            />
            <span className="flex h-5 w-14 items-center gap-1 text-xs text-text-faint">
              {saved && (
                <>
                  <Check size={14} className="text-success" /> Saved
                </>
              )}
            </span>
          </div>
          <span className="mt-1 block font-mono text-xs text-text-faint">
            id {myId.slice(0, 8)}…
            <button onClick={regenerate} className="ml-2 inline-flex items-center gap-1 underline hover:text-text">
              <RotateCcw size={11} /> regenerate
            </button>
          </span>
        </label>

        <div>
          <span className="mb-1 block text-xs text-text-muted">Known devices</span>
          <div className="divide-y divide-border rounded-xl border border-border">
            {devices.length === 0 && (
              <p className="px-3 py-2 text-sm text-text-faint">No devices reporting yet.</p>
            )}
            {devices.map((d) => (
              <div key={d.deviceId} className="flex items-center gap-2 px-3 py-2 text-sm">
                {icon(d.source)}
                <span className="font-medium">
                  {d.name || (d.source === 'ha' ? 'HA GPS' : 'Device')}
                </span>
                {d.deviceId === myId && <span className="text-xs text-accent">(this device)</span>}
                <span className="text-xs text-text-faint">· seen {ago(d.updatedAt)}</span>
                <div className="flex-1" />
                <button
                  onClick={() => remove(d.deviceId)}
                  className="rounded-lg p-1.5 text-text-muted hover:bg-surface-2 hover:text-danger"
                  title="Remove device"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        </div>

        <ErrorText>{error}</ErrorText>
      </div>
    </SettingsSection>
  );
}
