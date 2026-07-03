import { Globe } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * A subtle "from @&lt;host&gt;" badge for items owned by a federation shadow user (a
 * remote peer's user, `is_remote`). Keeps the provenance visible without dominating
 * the row. Used on task rows and in the task detail header.
 */
export function RemoteOwnerBadge({
  homeServer,
  className,
}: {
  homeServer: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-text-muted',
        className,
      )}
      title={`Shared from ${homeServer}`}
    >
      <Globe size={10} className="opacity-70" />
      from @{homeServer}
    </span>
  );
}
