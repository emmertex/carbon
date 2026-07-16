import type { ReactNode } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { cn } from '@/lib/cn';

/** Canonical text-input styling for every form field. */
export const inputCls =
  'rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent';

/** Primary (accent) action button. */
export const btnPrimary =
  'flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50';

/** Secondary (outline) action button. */
export const btnSecondary =
  'flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-surface-2 disabled:opacity-50';

/** Compact icon-only button (edit / delete / copy row actions). */
export const btnIcon =
  'rounded-lg p-1.5 text-text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50';

/** Destructive outline button — arm/confirm flows, danger-zone rows. */
export const btnDanger =
  'flex items-center gap-1.5 rounded-lg border border-danger/40 px-4 py-2 text-sm font-medium text-danger hover:bg-danger/10 disabled:opacity-50';

/** Solid destructive button — the final "yes, really" action. */
export const btnDangerSolid =
  'flex items-center gap-1.5 rounded-lg bg-danger px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50';

/** Small quick-action chip (date/time shortcuts and similar inline actions). */
export const chipCls =
  'rounded-full border border-border px-2.5 py-1 text-xs text-text-muted hover:bg-surface-2 hover:text-text';

/** Canonical container chrome for grouped lists/forms within a settings section. */
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('rounded-xl border border-border bg-surface', className)}>{children}</div>
  );
}

/** Compact micro-label above a control in the detail panels. */
export function Label({ children }: { children: ReactNode }) {
  return <span className="mb-1 block text-xs font-medium text-text-muted">{children}</span>;
}

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

/** A static rounded pill (tags, dependency links) with an optional remove button. */
export function Pill({
  title,
  onRemove,
  removeLabel,
  className,
  children,
}: {
  title?: string;
  onRemove?: () => void;
  removeLabel?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={cn(
        'flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs',
        className,
      )}
    >
      {children}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={removeLabel ?? 'Remove'}>
          <X size={12} className="text-text-faint hover:text-danger" />
        </button>
      )}
    </span>
  );
}

/** A checkbox row (label + checkbox) with an optional helper line below. */
export function SettingsToggle({
  label,
  checked,
  onChange,
  hint,
  className,
  disabled,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div className={className}>
      <label
        className={cn(
          'flex items-center gap-2 text-sm',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
      {hint && <p className="mt-1 text-xs text-text-faint">{hint}</p>}
    </div>
  );
}

/** An external documentation/download link with a trailing open-in-new icon. */
export function DocLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'inline-flex items-center gap-1 text-sm text-accent hover:underline',
        className,
      )}
    >
      {children}
      <ExternalLink size={13} className="shrink-0 opacity-70" />
    </a>
  );
}

/** Standard inline error text; renders nothing when empty. */
export function ErrorText({ children, className }: { children?: ReactNode; className?: string }) {
  if (!children) return null;
  return <p className={cn('text-sm text-danger', className)}>{children}</p>;
}
