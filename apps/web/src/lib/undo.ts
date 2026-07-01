// Session-local undo/redo.
//
// Each discrete user action (complete, flag, set priority, delete, …) registers an
// inverse. Undo/redo apply through the normal `mutate()` write path, so they persist,
// re-render React, and sync to peers as ordinary forward edits — LWW handles
// convergence. The stacks live in memory only and are cleared on reload.

import { getItem, updateItem, type Item, type ItemPatch } from '@carbon/core';
import { getDb } from './db';
import { mutate } from './mutate';
import { useStore } from './store';

export interface UndoEntry {
  label: string;
  undo: () => void;
  redo: () => void;
}

const MAX_DEPTH = 50;
const undoStack: UndoEntry[] = [];
const redoStack: UndoEntry[] = [];
// While an undo/redo is applying, the mutations it triggers must not register new
// entries (that would corrupt the stacks).
let applying = false;

function sync(): void {
  useStore.getState().setUndoCounts(undoStack.length, redoStack.length);
}

/** Register an inverse for the action just performed. No-op while undoing/redoing. */
export function pushUndo(entry: UndoEntry): void {
  if (applying) return;
  undoStack.push(entry);
  if (undoStack.length > MAX_DEPTH) undoStack.shift();
  redoStack.length = 0; // a fresh action invalidates the redo path
  sync();
}

export function undo(): void {
  const entry = undoStack.pop();
  if (!entry) return;
  applying = true;
  try {
    entry.undo();
  } finally {
    applying = false;
  }
  redoStack.push(entry);
  sync();
}

export function redo(): void {
  const entry = redoStack.pop();
  if (!entry) return;
  applying = true;
  try {
    entry.redo();
  } finally {
    applying = false;
  }
  undoStack.push(entry);
  sync();
}

export function clearUndo(): void {
  undoStack.length = 0;
  redoStack.length = 0;
  sync();
}

/**
 * Run a field-mutating action while capturing an inverse: snapshots `fields` on each
 * of `ids` beforehand, runs `apply`, and registers undo (write the snapshot back) /
 * redo (run `apply` again). Use for completion, flag, priority, delete, etc.
 */
export function recordFieldUndo(
  ids: string[],
  fields: (keyof Item)[],
  label: string,
  apply: () => void,
): void {
  const db = getDb();
  const before = ids.map((id) => {
    const it = getItem(db, id);
    const snap: ItemPatch = {};
    if (it) for (const f of fields) (snap as Record<string, unknown>)[f] = it[f];
    return { id, snap, existed: !!it };
  });

  apply();

  pushUndo({
    label,
    undo: () =>
      mutate((db2, dev) => {
        for (const b of before) if (b.existed) updateItem(db2, dev, b.id, b.snap);
      }, 'undo'),
    redo: apply,
  });
}
