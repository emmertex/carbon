import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

/** Icon colours for projects and folders. */
export const PROJECT_COLORS = [
  '#ef4444',
  '#f59e0b',
  '#eab308',
  '#10b981',
  '#14b8a6',
  '#3b82f6',
  '#6366f1',
  '#8b5cf6',
  '#ec4899',
  '#64748b',
];

/** Colour-swatch picker shared by the project detail pane and the sidebar folder editor. */
export function ColorSwatches({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (c: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {PROJECT_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={cn(
            'h-6 w-6 rounded-full border-2',
            value === c ? 'border-text' : 'border-transparent',
          )}
          style={{ background: c }}
          aria-label={`Colour ${c}`}
        />
      ))}
      <button
        type="button"
        onClick={() => onChange(null)}
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded-full border-2 text-text-faint',
          value ? 'border-border' : 'border-text',
        )}
        title="No colour (default)"
        aria-label="No colour"
      >
        <X size={12} />
      </button>
    </div>
  );
}
