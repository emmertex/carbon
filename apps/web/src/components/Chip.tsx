import { cn } from '@/lib/cn';

/** The one pill toggle used across the view controls — sort/status/filter chips,
 *  the Nested/Flat grouping, and the View-row icon toggles. Active reads as an
 *  accent-filled pill; inactive is bordered and hover-highlighted. Pass `className`
 *  to tweak padding (e.g. `px-1.5` for an icon-only toggle). */
export function Chip({
  active,
  onClick,
  children,
  title,
  className,
  'aria-label': ariaLabel,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      aria-pressed={active}
      className={cn(
        'flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium',
        active
          ? 'border-accent bg-accent-soft text-accent'
          : 'border-border text-text-muted hover:bg-surface-2',
        className,
      )}
    >
      {children}
    </button>
  );
}
