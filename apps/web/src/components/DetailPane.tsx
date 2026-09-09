import { useStore } from '@/lib/store';
import { useCompact } from '@/hooks/useCompact';
import { TaskDetail } from './TaskDetail';
import { TagDetail } from './TagDetail';
import { Modal } from './Modal';

export function DetailPane() {
  const selectedId = useStore((s) => s.selectedId);
  const selectedKind = useStore((s) => s.selectedKind);
  const detailOpen = useStore((s) => s.detailOpen);
  const closeDetail = useStore((s) => s.closeDetail);
  const compact = useCompact();
  if (!selectedId || (compact && !detailOpen)) return null;
  const pane = selectedKind === 'tag' ? <TagDetail id={selectedId} /> : <TaskDetail id={selectedId} />;
  if (!compact) return <div className="flex w-[380px] min-w-0 shrink-0 flex-col border-l border-border bg-surface">{pane}</div>;
  return <Modal onClose={closeDetail} labelledBy="detail-dialog-title" backdropClassName="p-0"
    panelClassName="flex h-full w-full min-w-0 flex-col overflow-hidden rounded-none border-0 bg-surface">
    <span id="detail-dialog-title" className="sr-only">Item details</span>
    {pane}
  </Modal>;
}
