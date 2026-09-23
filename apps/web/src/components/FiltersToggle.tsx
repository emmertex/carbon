import { SlidersHorizontal } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useFeature } from '@/hooks/useFeature';

export function FiltersToggle({
  open,
  onToggle,
  controlsId,
}: {
  open: boolean;
  onToggle: () => void;
  controlsId: string;
}) {
  const showControls = useFeature('viewControls');
  const showBar = useFeature('showBar');
  if (!showControls && !showBar) return null;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controlsId}
      className={cn(
        'flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium',
        open
          ? 'border-accent bg-accent/10 text-accent'
          : 'border-border text-text-muted hover:bg-surface-2 hover:text-text',
      )}
    >
      <SlidersHorizontal size={14} />
      Filters
    </button>
  );
}
