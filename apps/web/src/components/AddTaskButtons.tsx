import { Plus } from 'lucide-react';
import { createItem, createSiblingAfter } from '@carbon/core';
import { mutate } from '@/lib/mutate';
import { useStore, getCurrentUserId } from '@/lib/store';

const btn =
  'flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-text-muted hover:bg-surface-2 hover:text-text';

/** Explicit + Sibling / + Subtask affordances shown under a selected task. */
export function AddTaskButtons({
  depth = 0,
  onAddSibling,
  onAddSubtask,
}: {
  depth?: number;
  onAddSibling: () => void;
  onAddSubtask: () => void;
}) {
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{ paddingLeft: `${depth * 0.75 + 2.5}rem` }}
      className="flex gap-2 py-1 pr-3"
    >
      <button type="button" onClick={onAddSibling} className={btn}>
        <Plus size={13} /> Sibling
      </button>
      <button type="button" onClick={onAddSubtask} className={btn}>
        <Plus size={13} /> Subtask
      </button>
    </div>
  );
}

/**
 * List-view variant: when `itemId` is the selected task, show Sibling/Subtask
 * buttons. Creates the new item and opens its detail pane for naming (flat lists
 * have no outliner inline-edit).
 */
export function SelectedAddTaskButtons({
  itemId,
  depth = 0,
}: {
  itemId: string;
  depth?: number;
}) {
  const selected =
    useStore((s) => s.selectedId === itemId && s.selectedKind === 'item');
  const select = useStore((s) => s.select);
  const openDetail = useStore((s) => s.openDetail);

  if (!selected) return null;

  function afterCreate(id: string) {
    select(id);
    openDetail();
  }

  return (
    <AddTaskButtons
      depth={depth}
      onAddSibling={() => {
        const created = mutate((db, dev) =>
          createSiblingAfter(db, dev, itemId, getCurrentUserId()),
        );
        afterCreate(created.id);
      }}
      onAddSubtask={() => {
        const created = mutate((db, dev) =>
          createItem(db, dev, {
            title: '',
            parentId: itemId,
            ownerId: getCurrentUserId(),
          }),
        );
        afterCreate(created.id);
      }}
    />
  );
}
