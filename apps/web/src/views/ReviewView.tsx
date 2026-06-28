import { Link } from 'react-router-dom';
import { Check } from 'lucide-react';
import { getProjects, getChildren, needsReview, reviewDueAt, markReviewed } from '@carbon/core';
import { useQuery } from '@/hooks/useQuery';
import { mutate } from '@/lib/mutate';
import { formatDay } from '@/lib/date';

export function ReviewView() {
  const projects = useQuery((db) => {
    return getProjects(db)
      .filter((p) => needsReview(p))
      .map((p) => ({
        project: p,
        open: getChildren(db, p.id).filter((c) => c.status === 'active').length,
        due: reviewDueAt(p)?.toISOString() ?? null,
      }));
  });

  function review(id: string) {
    mutate((db, dev) => markReviewed(db, dev, id));
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
      <div className="mb-4">
        <h1 className="text-2xl font-bold tracking-tight">Review</h1>
        <p className="mt-0.5 text-sm text-text-muted">
          Keep projects honest. Set a review interval in a project's details.
        </p>
      </div>

      {projects && projects.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-text-muted">
          Nothing to review right now.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {projects?.map(({ project, open, due }) => (
            <div
              key={project.id}
              className="flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3"
            >
              <span
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ background: project.color || 'var(--accent)' }}
              />
              <div className="min-w-0 flex-1">
                <Link
                  to={`/project/${project.id}`}
                  className="block truncate font-medium hover:text-accent"
                >
                  {project.title || 'Untitled project'}
                </Link>
                <p className="text-xs text-text-muted">
                  {open} open · due {due ? formatDay(due).toLowerCase() : 'now'}
                </p>
              </div>
              <button
                onClick={() => review(project.id)}
                className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover"
              >
                <Check size={15} /> Reviewed
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
