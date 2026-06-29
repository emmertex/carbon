import { useStore } from '@/lib/store';
import { TaskDetail } from './TaskDetail';
import { TagDetail } from './TagDetail';

export function DetailPane() {
  const selectedId = useStore((s) => s.selectedId);
  const selectedKind = useStore((s) => s.selectedKind);
  const detailOpen = useStore((s) => s.detailOpen);
  const closeDetail = useStore((s) => s.closeDetail);

  if (!selectedId) return null;

  const pane =
    selectedKind === 'tag' ? <TagDetail id={selectedId} /> : <TaskDetail id={selectedId} />;

  return (
    <>
      {/* Desktop (lg+): docked right column — shows whenever something is selected */}
      <div className="hidden w-[380px] shrink-0 border-l border-border bg-surface lg:flex lg:flex-col">
        {pane}
      </div>
      {/* Compact: 80%-width overlay — only on the 2nd tap (detailOpen). Tap scrim or
          swipe L→R to close; the selection stays (inline add box remains). */}
      {detailOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={closeDetail} />
          <div className="absolute inset-y-0 right-0 flex w-[80%] max-w-md flex-col bg-surface shadow-2xl">
            {pane}
          </div>
        </div>
      )}
    </>
  );
}
