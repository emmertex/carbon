import { Link } from 'react-router-dom';
import { Home, ChevronRight } from 'lucide-react';
import { getItem, type Db, type Item } from '@carbon/core';
import { useQuery } from '@/hooks/useQuery';

function chain(db: Db, id: string): Item[] {
  const result: Item[] = [];
  let current = getItem(db, id);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    result.unshift(current);
    current = current.parent_id ? getItem(db, current.parent_id) : undefined;
  }
  return result;
}

function hrefFor(item: Item): string {
  return item.type === 'project' ? `/project/${item.id}` : `/focus/${item.id}`;
}

export function Breadcrumbs({ id }: { id: string }) {
  const ancestors = useQuery((db) => chain(db, id), [id]) ?? [];
  if (ancestors.length === 0) return null;

  return (
    <nav className="mb-3 flex items-center gap-1 text-sm text-text-muted">
      <Link to="/today" className="flex items-center hover:text-text" aria-label="Home">
        <Home size={15} />
      </Link>
      {ancestors.map((item, i) => {
        const last = i === ancestors.length - 1;
        return (
          <span key={item.id} className="flex items-center gap-1">
            <ChevronRight size={14} className="text-text-faint" />
            {last ? (
              <span className="font-medium text-text">{item.title || 'Untitled'}</span>
            ) : (
              <Link to={hrefFor(item)} className="truncate hover:text-text">
                {item.title || 'Untitled'}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
