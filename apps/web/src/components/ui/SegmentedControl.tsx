import { cn } from '@/lib/cn';

export type SegmentOption<T extends string> = {
  value: T;
  label: React.ReactNode;
  title?: string;
  /** Overrides the default active fill when a segment carries semantic colour
   *  (e.g. Done = success). Keep to soft token fills so the group stays calm. */
  activeClassName?: string;
};

/** The one segmented control — a bordered pill group where the selected segment
 *  gets a soft accent fill (matching Chip's active state). Use for mutually
 *  exclusive choices: lifecycle status, order mode, view switchers, basic/advanced. */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  className,
  segmentClassName,
  block,
}: {
  value: T | null;
  onChange: (value: T) => void;
  options: SegmentOption<T>[];
  className?: string;
  /** Extra classes per segment (e.g. tighter padding in dense toolbars). */
  segmentClassName?: string;
  /** Stretch to full width with equal-width segments. */
  block?: boolean;
}) {
  return (
    <div
      className={cn(
        'inline-flex max-w-full overflow-x-auto overflow-y-hidden rounded-full border border-border text-xs',
        block && 'flex w-full',
        className,
      )}
    >
      {options.map((opt, i) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            title={opt.title}
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            className={cn(
              'shrink-0 whitespace-nowrap px-3 py-1 font-medium transition-colors',
              block && 'flex-1',
              i > 0 && 'border-l border-border',
              active
                ? (opt.activeClassName ?? 'bg-accent-soft text-accent')
                : 'text-text-muted hover:bg-surface-2 hover:text-text',
              segmentClassName,
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
