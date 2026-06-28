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
      { root, rootMargin: '0px 0px -70% 0px' },
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return active;
}

/** Sticky left rail listing the settings groups; click to jump, scroll-spy highlights. */
export function SettingsNav({ groups, active }: { groups: NavGroup[]; active: string | null }) {
  function jump(id: string) {
    document.getElementById(`group-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  return (
    <nav className="hidden self-start lg:sticky lg:top-6 lg:block">
      <ul className="border-l border-border">
        {groups.map((g) => (
          <li key={g.id}>
            <button
              type="button"
              onClick={() => jump(g.id)}
              className={cn(
                '-ml-px block border-l-2 px-3 py-1 text-left text-sm transition-colors',
                active === g.id
                  ? 'border-accent font-medium text-accent'
                  : 'border-transparent text-text-muted hover:text-text',
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
