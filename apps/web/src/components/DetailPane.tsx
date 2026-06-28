import { useStore } from '@/lib/store';
import { TaskDetail } from './TaskDetail';
import { TagsPanel } from './TagsPanel';

export function DetailPane() {
  const selectedId = useStore((s) => s.selectedId);
  const detailOpen = useStore((s) => s.detailOpen);
  const tagsPanelOpen = useStore((s) => s.tagsPanelOpen);
  const closeDetail = useStore((s) => s.closeDetail);
  const closeTagsPanel = useStore((s) => s.closeTagsPanel);

  // The Tags panel takes precedence over the task/project detail (mutually exclusive).
  if (tagsPanelOpen) {
    return (
      <>
        <div className="hidden w-[380px] shrink-0 border-l border-border bg-surface lg:flex lg:flex-col">
          <TagsPanel />
        </div>
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={closeTagsPanel} />
          <div className="absolute inset-y-0 right-0 flex w-[85%] max-w-md flex-col bg-surface shadow-2xl">
            <TagsPanel />
          </div>
        </div>
      </>
    );
  }

  if (!selectedId) return null;

  return (
    <>
      {/* Desktop (lg+): docked right column — shows whenever a task is selected */}
      <div className="hidden w-[380px] shrink-0 border-l border-border bg-surface lg:flex lg:flex-col">
        <TaskDetail id={selectedId} />
      </div>
      {/* Compact: 80%-width overlay — only on the 2nd tap (detailOpen). Tap scrim or
          swipe L→R to close; the task stays selected (inline add box remains). */}
      {detailOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={closeDetail} />
          <div className="absolute inset-y-0 right-0 flex w-[80%] max-w-md flex-col bg-surface shadow-2xl">
            <TaskDetail id={selectedId} />
          </div>
        </div>
      )}
    </>
  );
}
