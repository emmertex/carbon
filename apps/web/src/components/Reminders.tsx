import { useEffect, useState } from 'react';
import { Bell, MapPin, Smartphone } from 'lucide-react';
import { useStore } from '@/lib/store';
import { getServerConfig } from '@/lib/config';
import {
  enablePush,
  disablePush,
  isPushEnabled,
  pushSupported,
  pushDeliversWhenClosed,
} from '@/lib/notify';
import {
  localRemindersSupported,
  localRemindersPref,
  startLocalReminders,
  stopLocalReminders,
} from '@/lib/localReminders';
import { startGeofencing, stopGeofencing, geofencePref, geofencingSupported } from '@/lib/geo';
import { requestNativePermission } from '@/lib/nativeReminders';
import { isCapacitor } from '@/lib/platform';
import { cn } from '@/lib/cn';
import { SettingsSection } from './settings/SettingsSection';

// Ensure an OS-level notification permission for foreground geofence alerts: the
// native channel on Capacitor, else the browser Notification API.
async function ensureNotificationPermission(): Promise<boolean> {
  if (isCapacitor) return requestNativePermission();
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  return (await Notification.requestPermission()) === 'granted';
}

export function Reminders() {
  const currentUser = useStore((s) => s.currentUser);
  const hasServer = !!getServerConfig().url;
  const signedIn = !!currentUser && !currentUser.open;
  // Server push only works when signed in to a server; otherwise reminders run
  // locally on this device (no server needed).
  const pushMode = hasServer && signedIn;

  const [pushOn, setPushOn] = useState(false);
  const [localOn, setLocalOn] = useState(localRemindersPref());
  const [msg, setMsg] = useState<string | null>(null);
  const [geoOn, setGeoOn] = useState(geofencePref());

  useEffect(() => {
    void isPushEnabled().then(setPushOn);
  }, []);

  async function togglePush() {
    if (pushOn) {
      await disablePush();
      setPushOn(false);
      setMsg('Push reminders disabled on this device');
    } else {
      const r = await enablePush();
      setPushOn(r.ok);
      setMsg(r.message);
    }
  }

  async function toggleLocal() {
    if (localOn) {
      stopLocalReminders();
      setLocalOn(false);
      setMsg('Reminders off');
    } else {
      // On Capacitor startLocalReminders requests the native permission itself; on
      // web we need the Notification permission before scanning.
      if (!isCapacitor && !(await ensureNotificationPermission())) {
        setMsg('Notification permission denied');
        return;
      }
      const ok = await startLocalReminders();
      setLocalOn(ok);
      setMsg(
        !ok
          ? 'Notification permission denied'
          : isCapacitor
            ? 'Reminders on — they fire even when the app is closed'
            : 'Reminders on (this device, while the app is open)',
      );
    }
  }

  async function toggleGeo() {
    if (geoOn) {
      stopGeofencing();
      setGeoOn(false);
    } else {
      await ensureNotificationPermission(); // so alerts can actually show
      setGeoOn(await startGeofencing());
    }
  }

  return (
    <SettingsSection id="reminders" title="Reminders & location">
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          {pushMode ? (
            <button
              onClick={togglePush}
              disabled={!pushSupported()}
              className={cn(
                'flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50',
                pushOn
                  ? 'border border-border hover:bg-surface-2'
                  : 'bg-accent text-accent-fg hover:bg-accent-hover',
              )}
            >
              <Bell size={15} /> {pushOn ? 'Disable push reminders' : 'Enable push reminders'}
            </button>
          ) : (
            <button
              onClick={toggleLocal}
              disabled={!localRemindersSupported()}
              className={cn(
                'flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50',
                localOn
                  ? 'border border-border hover:bg-surface-2'
                  : 'bg-accent text-accent-fg hover:bg-accent-hover',
              )}
            >
              <Smartphone size={15} />{' '}
              {localOn ? 'Disable reminders (this device)' : 'Enable reminders (this device)'}
            </button>
          )}
          {msg && <span className="text-sm text-text-muted">{msg}</span>}
        </div>

        {!pushSupported() && (
          <p className="text-xs text-text-faint">Notifications aren't supported in this browser.</p>
        )}
        {pushMode ? (
          <p className="text-xs text-text-faint">
            {pushDeliversWhenClosed()
              ? 'Push reminders are sent by the server, so they arrive even when the app is closed.'
              : 'Notifications show on this device while the app is running.'}
          </p>
        ) : (
          <p className="text-xs text-text-faint">
            Reminders fire on this device while the app is open — no server needed.
            {hasServer && ' Sign in to a server for push reminders that arrive when it is closed.'}
          </p>
        )}

        <div className="flex items-center gap-3">
          <button
            onClick={toggleGeo}
            disabled={!geofencingSupported()}
            className={cn(
              'flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-surface-2 disabled:opacity-50',
              geoOn && 'border-accent bg-accent-soft text-accent',
            )}
          >
            <MapPin size={15} /> Location reminders (this device): {geoOn ? 'On' : 'Off'}
          </button>
        </div>
        <p className="text-xs text-text-faint">
          Uses this device's location while the app is open — no server needed. For background
          geofencing, link your Home Assistant person (under Home Assistant below) and let HA call
          the server on zone changes.
        </p>
      </div>
    </SettingsSection>
  );
}
