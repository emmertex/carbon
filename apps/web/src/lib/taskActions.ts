import {
  setCompleted,
  setCompletedCascade,
  subtaskProgress,
  updateItem,
  deleteItem,
  addToPlan,
  removeFromPlan,
  isInPlan,
  getTimeContext,
  sessionAnchor,
  recordCompletion,
  removeCompletion,
  getItem,
  getChildren,
  type Db,
  type Item,
} from '@carbon/core';
import { mutate } from './mutate';
import { getDb } from './db';
import { useStore, getCurrentUserId } from './store';
import { holdCompleted, releaseCompleted } from './completion';
import { recordFieldUndo, pushUndo, undo } from './undo';

/** Ids of an item and all its descendants (for cascade undo snapshots). */
function subtreeIds(db: Db, rootId: string): string[] {
  const ids = [rootId];
  const queue = [rootId];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const c of getChildren(db, parent)) {
      ids.push(c.id);
      queue.push(c.id);
    }
  }
  return ids;
}

/** Complete a task. `cascade` also finishes every descendant (the §7 confirm).
 *  Mirrors the session-interrupt prompt used by the row checkbox. */
export function completeTask(item: Item, cascade = false): void {
  const uid = getCurrentUserId();
  const ids = cascade ? subtreeIds(getDb(), item.id) : [item.id];
  recordFieldUndo(ids, ['status', 'completed_at'], cascade ? 'Complete tasks' : 'Complete task', () => {
    mutate((db, dev) => {
      if (cascade) setCompletedCascade(db, dev, item.id);
      else setCompleted(db, dev, item.id, true);
      recordCompletion(db, dev, item.id, uid); // data point on the open block, if any
      const ctx = getTimeContext(db, uid);
      if (ctx.session && ctx.session.item_id !== sessionAnchor(db, item.id)) {
        useStore
          .getState()
          .setInterrupt({ project: getItem(db, ctx.session.item_id)?.title || 'project' });
      }
    }, 'complete');
    holdCompleted(item.id);
  });
}

export function uncompleteTask(item: Item): void {
  const uid = getCurrentUserId();
  recordFieldUndo([item.id], ['status', 'completed_at'], 'Reopen task', () => {
    mutate((db, dev) => {
      setCompleted(db, dev, item.id, false);
      removeCompletion(db, dev, item.id, uid); // retract the completion data point
    }, 'complete');
    releaseCompleted(item.id);
  });
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
  recordFieldUndo([item.id], ['flagged'], item.flagged ? 'Unflag' : 'Flag', () =>
    mutate((db, dev) => updateItem(db, dev, item.id, { flagged: !item.flagged })),
  );
}

/** Set a task's explicit priority (0 None · 1 Low · 2 Medium · 3 High). */
export function setPriority(item: Item, priority: number): void {
  recordFieldUndo([item.id], ['priority'], 'Set priority', () =>
    mutate((db, dev) => updateItem(db, dev, item.id, { priority })),
  );
}

export function planTask(item: Item): void {
  const uid = getCurrentUserId();
  if (isInPlan(getDb(), uid, item.id)) return;
  mutate((db, dev) => addToPlan(db, dev, uid, item.id));
  pushUndo({
    label: 'Add to Plan',
    undo: () => mutate((db, dev) => removeFromPlan(db, dev, uid, item.id)),
    redo: () => mutate((db, dev) => addToPlan(db, dev, uid, item.id)),
  });
}

/** Toggle a task in/out of the current user's Plan. */
export function togglePlan(item: Item): void {
  const uid = getCurrentUserId();
  const inPlan = isInPlan(getDb(), uid, item.id);
  const add = () => mutate((db, dev) => addToPlan(db, dev, uid, item.id));
  const remove = () => mutate((db, dev) => removeFromPlan(db, dev, uid, item.id));
  if (inPlan) remove();
  else add();
  pushUndo({
    label: inPlan ? 'Remove from Plan' : 'Add to Plan',
    undo: inPlan ? add : remove,
    redo: inPlan ? remove : add,
  });
}

/** Soft-delete with an undo snackbar — left swipes are easy to trigger, so a
 *  delete must always be recoverable. Also joins the global undo stack (Ctrl+Z). */
export function deleteTaskWithUndo(item: Item): void {
  recordFieldUndo([item.id], ['deleted'], 'Delete task', () =>
    mutate((db, dev) => deleteItem(db, dev, item.id)),
  );
  useStore.getState().showToast({
    message: 'Task deleted',
    actionLabel: 'Undo',
    onAction: () => undo(),
  });
}
