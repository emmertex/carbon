import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';

export interface NavGroup {
  id: string;
  label: string;
}

/**
 * Scroll-spy for the settings page: returns whichever group is currently nearest
 * the top of the scroll area. Observes the `#group-<id>` containers against the
 * scrolling `<main>` ancestor (the page itself doesn't scroll the window).
 */
export function useActiveGroup(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  const key = ids.join(',');
  useEffect(() => {
    const els = ids
      .map((id) => document.getElementById(`group-${id}`))
      .filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return;
    const root = els[0].closest('main');
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.group;
          if (!id) continue;
          if (e.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        const first = ids.find((id) => visible.has(id));
        if (first) setActive(first);
      },
      // Top inset clears the sticky mobile category bar (and matches desktop's
      // scroll-mt) so the section just scrolled to the top wins, not the prior
      // section's tail still lingering above the heading.
      { root, rootMargin: '-84px 0px -55% 0px' },
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return active;
}

/** Smoothly scrolls the group container for `id` to the top of the scroll area. */
function jumpToGroup(id: string) {
  document.getElementById(`group-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * Sticky left rail listing the settings groups (desktop only); click to jump,
 * scroll-spy highlights. Active style mirrors the main app sidebar (filled pill).
 */
export function SettingsNav({ groups, active }: { groups: NavGroup[]; active: string | null }) {
  return (
    <nav className="hidden self-start lg:sticky lg:top-6 lg:block">
      <ul className="space-y-0.5">
        {groups.map((g) => (
          <li key={g.id}>
            <button
              type="button"
              onClick={() => jumpToGroup(g.id)}
              className={cn(
                'block w-full rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors',
                active === g.id
                  ? 'bg-accent-soft font-medium text-accent'
                  : 'text-text-muted hover:bg-surface-2 hover:text-text',
              )}
            >
              {g.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * Horizontally-scrollable category chips, shown below the `lg` breakpoint where
 * the left rail is hidden. Sticks under the page title so categories stay
 * reachable while scrolling the long settings list on phones/tablets.
 */
export function SettingsNavMobile({
  groups,
  active,
}: {
  groups: NavGroup[];
  active: string | null;
}) {
  return (
    <nav className="sticky top-0 z-10 -mx-4 mb-6 border-b border-border bg-bg/90 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6 lg:hidden">
      <div className="no-scrollbar flex gap-1.5 overflow-x-auto whitespace-nowrap">
        {groups.map((g) => (
          <button
            key={g.id}
            type="button"
            onClick={() => jumpToGroup(g.id)}
            className={cn(
              'shrink-0 rounded-full px-3 py-1 text-sm transition-colors',
              active === g.id
                ? 'bg-accent-soft font-medium text-accent'
                : 'text-text-muted hover:bg-surface-2',
            )}
          >
            {g.label}
          </button>
        ))}
      </div>
    </nav>
  );
}
