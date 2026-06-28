import { useEffect, useRef } from 'react';

/**
 * Persist-on-change without a Save button. Returns `markDirty` — call it from
 * every user-driven onChange. Once dirty, the `save` callback fires ~`delay`ms
 * after the watched `deps` settle. The dirty gate is what lets us ignore the
 * programmatic state population from store/server updates (those change `deps`
 * too, but must not trigger a save loop).
 */
export function useDebouncedSave(save: () => void, deps: unknown[], delay = 600): () => void {
  const dirty = useRef(false);
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (!dirty.current) return;
    const id = setTimeout(() => {
      dirty.current = false;
      saveRef.current();
    }, delay);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return () => {
    dirty.current = true;
  };
}
