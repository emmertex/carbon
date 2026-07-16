import { cn } from '@/lib/cn';

/** Dressed native <select>: a bordered wrapper (with optional leading icon) so
 *  every dropdown shares the input chrome, while keeping the OS-native picker
 *  underneath (mobile-friendly). Pass `className` to compact it for toolbars. */
export function Select({
  icon,
  className,
  selectClassName,
  children,
  ...selectProps
}: {
  icon?: React.ReactNode;
  className?: string;
  selectClassName?: string;
} & React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <label
      className={cn(
        'flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm focus-within:border-accent',
        className,
      )}
    >
      {icon}
      <select
        {...selectProps}
        className={cn('w-full min-w-0 bg-transparent outline-none', selectClassName)}
      >
        {children}
      </select>
    </label>
  );
}
