import {
  setCompleted,
  setCompletedCascade,
  subtaskProgress,
  updateItem,
  deleteItem,
  restoreItem,
  addToPlan,
  removeFromPlan,
  isInPlan,
  getTimeContext,
  sessionAnchor,
  getItem,
  type Item,
} from '@carbon/core';
import { mutate } from './mutate';
import { getDb } from './db';
import { useStore, getCurrentUserId } from './store';
import { holdCompleted, releaseCompleted } from './completion';

/** Complete a task. `cascade` also finishes every descendant (the §7 confirm).
 *  Mirrors the session-interrupt prompt used by the row checkbox. */
export function completeTask(item: Item, cascade = false): void {
  const uid = getCurrentUserId();
  mutate((db, dev) => {
    if (cascade) setCompletedCascade(db, dev, item.id);
    else setCompleted(db, dev, item.id, true);
    const ctx = getTimeContext(db, uid);
    if (ctx.session && ctx.session.item_id !== sessionAnchor(db, item.id)) {
      useStore
        .getState()
        .setInterrupt({ project: getItem(db, ctx.session.item_id)?.title || 'project' });
    }
  }, 'complete');
  holdCompleted(item.id);
}

export function uncompleteTask(item: Item): void {
  mutate((db, dev) => setCompleted(db, dev, item.id, false), 'complete');
  releaseCompleted(item.id);
}

/**
 * Toggle a task's completion with the same guard the row checkbox uses: completing
 * a parent that still has unfinished sub-tasks asks for confirmation and cascades
 * to all descendants. The single completion entry point for both mouse and
 * keyboard so they never diverge.
 */
export function toggleTaskCompletion(item: Item): void {
  if (item.status === 'done') return uncompleteTask(item);
  const { countScope } = useStore.getState().uiPrefs;
  const progress = subtaskProgress(getDb(), item.id, countScope);
  const hasOpenChildren = progress.total > 0 && progress.done < progress.total;
  if (hasOpenChildren) {
    if (!window.confirm('Completing this task will complete all sub-tasks. Continue?')) return;
    return completeTask(item, true);
  }
  completeTask(item);
}

export function flagTask(item: Item): void {
  mutate((db, dev) => updateItem(db, dev, item.id, { flagged: !item.flagged }));
}

export function planTask(item: Item): void {
  const uid = getCurrentUserId();
  mutate((db, dev) => addToPlan(db, dev, uid, item.id));
}

/** Toggle a task in/out of the current user's Plan. */
export function togglePlan(item: Item): void {
  const uid = getCurrentUserId();
  mutate((db, dev) =>
    isInPlan(db, uid, item.id)
      ? removeFromPlan(db, dev, uid, item.id)
      : addToPlan(db, dev, uid, item.id),
  );
}

/** Soft-delete with an undo snackbar — left swipes are easy to trigger, so a
 *  delete must always be recoverable. */
export function deleteTaskWithUndo(item: Item): void {
  mutate((db, dev) => deleteItem(db, dev, item.id));
  useStore.getState().showToast({
    message: 'Task deleted',
    actionLabel: 'Undo',
    onAction: () => mutate((db, dev) => restoreItem(db, dev, item.id)),
  });
}
