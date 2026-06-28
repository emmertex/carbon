import { cn } from '@/lib/cn';

/** The tag marker: an italic # in the tag's colour. Used wherever tags render. */
export function TagMark({ color, className }: { color?: string | null; className?: string }) {
  return (
    <span
      className={cn('shrink-0 font-bold italic leading-none', className)}
      style={{ color: color || 'var(--accent)' }}
      aria-hidden
    >
      #
    </span>
  );
}
