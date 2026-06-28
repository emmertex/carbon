import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';

/** A collapsible detail-pane section with an optional collapsed summary. */
export function Section({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string;
  summary?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-border pt-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 text-left"
      >
        <ChevronRight size={14} className={cn('text-text-faint transition-transform', open && 'rotate-90')} />
        <span className="text-sm font-medium">{title}</span>
        {!open && summary && (
          <span className="ml-auto truncate pl-2 text-xs text-text-muted">{summary}</span>
        )}
      </button>
      {open && <div className="mt-3 space-y-3">{children}</div>}
    </div>
  );
}
