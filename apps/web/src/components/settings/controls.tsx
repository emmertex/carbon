import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** Canonical text-input styling for every settings field. */
export const inputCls =
  'rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent';

/** Primary (accent) action button. */
export const btnPrimary =
  'flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50';

/** Secondary (outline) action button. */
export const btnSecondary =
  'flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-surface-2 disabled:opacity-50';

/** A labelled field: bold caption, the control, and an optional helper line. */
export function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-text-faint">{hint}</span>}
    </label>
  );
}

/** A selectable pill, used for theme / gesture / scope choices. */
export function ThemeChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-lg border px-4 py-2 text-sm',
        active ? 'border-accent bg-accent-soft text-accent' : 'border-border hover:bg-surface-2',
      )}
    >
      {label}
    </button>
  );
}

/** A checkbox row (label + checkbox) with an optional helper line below. */
export function SettingsToggle({
  label,
  checked,
  onChange,
  hint,
  className,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
      {hint && <p className="mt-1 text-xs text-text-faint">{hint}</p>}
    </div>
  );
}

/** Standard inline error text; renders nothing when empty. */
export function ErrorText({ children, className }: { children?: ReactNode; className?: string }) {
  if (!children) return null;
  return <p className={cn('text-sm text-danger', className)}>{children}</p>;
}
