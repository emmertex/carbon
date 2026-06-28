import { useNavigate } from 'react-router-dom';
import { useStore } from '@/lib/store';
import type { Item } from '@carbon/core';

/** Enter focus mode on an item: a project opens its own view, any other item
 *  isolates itself and its descendants under /focus. Clears the detail selection
 *  so the pane doesn't linger over the freshly-focused list. Shared by the row
 *  Focus button and the row quick menu so the two never diverge. */
export function useFocusItem(): (item: Pick<Item, 'id' | 'type'>) => void {
  const navigate = useNavigate();
  const select = useStore((s) => s.select);
  return (item) => {
    select(null);
    navigate(item.type === 'project' ? `/project/${item.id}` : `/focus/${item.id}`);
  };
}
