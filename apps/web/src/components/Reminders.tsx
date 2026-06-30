import { useEffect, useState } from 'react';
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
import { SettingsSection } from './settings/SettingsSection';
import { SettingsToggle } from './settings/controls';

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

  const remindersSupported = pushMode ? pushSupported() : localRemindersSupported();
  const remindersHint = !pushSupported() ? (
    "Notifications aren't supported in this browser."
  ) : pushMode ? (
    pushDeliversWhenClosed() ? (
      'Push reminders are sent by the server, so they arrive even when the app is closed.'
    ) : (
      'Notifications show on this device while the app is running.'
    )
  ) : (
    <>
      Reminders fire on this device while the app is open — no server needed.
      {hasServer && ' Sign in to a server for push reminders that arrive when it is closed.'}
    </>
  );

  return (
    <SettingsSection id="reminders" title="Reminders & location">
      <div className="space-y-4">
        <div>
          <SettingsToggle
            label={pushMode ? 'Push reminders (this device)' : 'Reminders (this device)'}
            checked={pushMode ? pushOn : localOn}
            disabled={!remindersSupported}
            onChange={() => (pushMode ? togglePush() : toggleLocal())}
            hint={remindersHint}
          />
          {msg && <p className="mt-1 text-xs text-text-muted">{msg}</p>}
        </div>

        <SettingsToggle
          label="Location reminders (this device)"
          checked={geoOn}
          disabled={!geofencingSupported()}
          onChange={() => toggleGeo()}
          hint="Uses this device's location while the app is open — no server needed. For background geofencing, link your Home Assistant person (under Home Assistant below) and let HA call the server on zone changes."
        />
      </div>
    </SettingsSection>
  );
}
