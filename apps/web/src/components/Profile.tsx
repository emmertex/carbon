import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { useStore } from '@/lib/store';
import { updateProfile } from '@/lib/sync';
import { Avatar } from './Avatar';
import { cn } from '@/lib/cn';
import { SettingsSection } from './settings/SettingsSection';
import { Field, ErrorText, inputCls } from './settings/controls';
import { useSavedFlash } from './settings/useSavedFlash';
import { useDebouncedSave } from './settings/useDebouncedSave';

const AVATAR_COLORS = [
  '#ef4444',
  '#f59e0b',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#3b82f6',
  '#6366f1',
  '#8b5cf6',
  '#ec4899',
  '#a855f7',
  '#64748b',
];

export function Profile() {
  const currentUser = useStore((s) => s.currentUser);
  const [name, setName] = useState('');
  const [initial, setInitial] = useState('');
  const [color, setColor] = useState('');
  const [saved, flashSaved] = useSavedFlash();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(currentUser?.display_name ?? '');
    setInitial(currentUser?.avatar_initial ?? '');
    setColor(currentUser?.avatar_color ?? '');
  }, [currentUser?.id, currentUser?.display_name, currentUser?.avatar_initial, currentUser?.avatar_color]);

  if (!currentUser) return null;

  const preview = {
    display_name: name || null,
    username: currentUser.username,
    avatar_color: color || null,
    avatar_initial: initial || null,
  };

  async function save() {
    setError(null);
    try {
      await updateProfile({
        display_name: name.trim() || null,
        avatar_color: color || null,
        avatar_initial: initial.trim() || null,
      });
      flashSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const markDirty = useDebouncedSave(() => void save(), [name, initial, color]);

  return (
    <SettingsSection id="profile" title="Profile">
      <div className="flex items-start gap-4">
        <Avatar user={preview} size="lg" className="mt-5 h-12 w-12 text-lg" />
        <div className="flex-1 space-y-3">
          <Field
            label="Display name"
            hint={<>Shown instead of your login name “{currentUser.username}”.</>}
          >
            <input
              className={cn(inputCls, 'w-full max-w-xs')}
              placeholder={currentUser.username}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                markDirty();
              }}
            />
          </Field>

          <div className="flex flex-wrap items-end gap-3">
            <Field label="Avatar letter">
              <input
                className={cn(inputCls, 'w-16 text-center uppercase')}
                maxLength={2}
                placeholder={(name || currentUser.username).charAt(0).toUpperCase()}
                value={initial}
                onChange={(e) => {
                  setInitial(e.target.value);
                  markDirty();
                }}
              />
            </Field>
            <div>
              <span className="mb-1 block text-sm font-medium">Colour</span>
              <div className="flex flex-wrap gap-1.5">
                {AVATAR_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => {
                      setColor(c);
                      markDirty();
                    }}
                    title={c}
                    className={cn(
                      'h-6 w-6 rounded-full border transition-transform hover:scale-110',
                      color === c ? 'border-text ring-2 ring-text/30' : 'border-border',
                    )}
                    style={{ background: c }}
                  />
                ))}
              </div>
            </div>
          </div>

          <p className="flex h-5 items-center gap-1 text-xs text-text-faint">
            {saved ? (
              <>
                <Check size={14} className="text-success" /> Saved
              </>
            ) : (
              'Changes save automatically.'
            )}
          </p>
          <ErrorText>{error}</ErrorText>
        </div>
      </div>
    </SettingsSection>
  );
}
