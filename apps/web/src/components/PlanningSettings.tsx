import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { PLAN_DEFAULT_STARTUP_MIN, PLAN_DEFAULT_ESTIMATE_MIN } from '@carbon/core';
import { useStore } from '@/lib/store';
import { updateProfile } from '@/lib/sync';
import { cn } from '@/lib/cn';
import { SettingsSection } from './settings/SettingsSection';
import { Field, ErrorText, inputCls, btnPrimary } from './settings/controls';
import { useSavedFlash } from './settings/useSavedFlash';

const numInputCls = cn(inputCls, 'w-20');

/** Per-user planning budget (start-up overhead + default estimate). Signed-in only. */
export function PlanningSettings() {
  const currentUser = useStore((s) => s.currentUser);
  const [startup, setStartup] = useState('');
  const [defaultEst, setDefaultEst] = useState('');
  const [saved, flashSaved] = useSavedFlash();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setStartup(currentUser?.plan_startup_min != null ? String(currentUser.plan_startup_min) : '');
    setDefaultEst(
      currentUser?.plan_default_estimate_min != null
        ? String(currentUser.plan_default_estimate_min)
        : '',
    );
  }, [currentUser?.id, currentUser?.plan_startup_min, currentUser?.plan_default_estimate_min]);

  if (!currentUser) return null;

  const num = (v: string) => (v.trim() === '' ? null : Math.max(0, Math.round(Number(v))));

  async function save() {
    setError(null);
    try {
      await updateProfile({
        plan_startup_min: num(startup),
        plan_default_estimate_min: num(defaultEst),
      });
      flashSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <SettingsSection
      id="planning"
      title="Planning budget"
      description="Used to size your Plan: each task costs start-up time plus its estimate (or the default when un-estimated)."
    >
      <div className="flex flex-wrap gap-4">
        <Field label="Per-task start-up">
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={0}
              className={numInputCls}
              placeholder={String(PLAN_DEFAULT_STARTUP_MIN)}
              value={startup}
              onChange={(e) => setStartup(e.target.value)}
            />
            <span className="text-xs text-text-faint">min</span>
          </div>
        </Field>
        <Field label="Default estimate">
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={0}
              className={numInputCls}
              placeholder={String(PLAN_DEFAULT_ESTIMATE_MIN)}
              value={defaultEst}
              onChange={(e) => setDefaultEst(e.target.value)}
            />
            <span className="text-xs text-text-faint">min</span>
          </div>
        </Field>
      </div>
      <button onClick={save} className={cn(btnPrimary, 'mt-3')}>
        {saved ? <Check size={15} /> : null} Save
      </button>
      <ErrorText className="mt-2">{error}</ErrorText>
    </SettingsSection>
  );
}
