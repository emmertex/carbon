import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { useStore } from '@/lib/store';
import { updateHaPerson } from '@/lib/sync';
import { SettingsSection } from './settings/SettingsSection';
import { ErrorText, inputCls } from './settings/controls';
import { useSavedFlash } from './settings/useSavedFlash';

export function HaPerson() {
  const currentUser = useStore((s) => s.currentUser);
  const [person, setPerson] = useState(currentUser?.ha_person ?? '');
  const [saved, flashSaved] = useSavedFlash();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setPerson(currentUser?.ha_person ?? ''), [currentUser?.ha_person]);

  async function save() {
    setError(null);
    try {
      await updateHaPerson(person.trim() || null);
      flashSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <SettingsSection id="ha-person" title="Home Assistant">
      <span className="mb-1 block text-sm font-medium">Home Assistant person</span>
      <div className="flex items-center gap-2">
        <input
          className={inputCls}
          placeholder="person.name"
          value={person}
          onChange={(e) => setPerson(e.target.value)}
        />
        <button
          onClick={save}
          className="flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover"
        >
          {saved ? <Check size={15} /> : null} Save
        </button>
        <ErrorText>{error}</ErrorText>
      </div>
      <p className="mt-1 text-xs text-text-faint">
        HA posts zone changes to <code>/api/geo/event</code>; matching this person fires location
        reminders for tasks tagged with that zone/place.
      </p>
    </SettingsSection>
  );
}
