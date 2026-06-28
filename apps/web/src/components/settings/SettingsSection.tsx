import type { ReactNode } from 'react';

/**
 * The one canonical settings section wrapper: a stable anchor id, a uniform
 * heading, an optional lead description, then the section body. Flat (no card
 * chrome) — visual grouping comes from the page's category headings + sub-nav.
 */
export function SettingsSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-text-faint">{title}</h2>
      {description && <p className="mt-1 text-sm text-text-muted">{description}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}
