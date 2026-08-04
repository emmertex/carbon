import type { Item } from '@carbon/core';

/** The route that renders an item as a page.
 *
 *  Three surfaces link to items independently — breadcrumbs, the sidebar's "Shared
 *  with me" list, and the row Focus action (`useFocusItem`) — and they have to agree,
 *  because a note opened from one of them and the same note opened from another must
 *  be the same page. Notes get `/note/:id` (NoteView: a document, with the recipe
 *  view and its children beneath), projects `/project/:id`, and everything else
 *  `/focus/:id`, which isolates the item and its descendants as a task container.
 *
 *  TimerBar deliberately still hardcodes `/focus/` — it navigates to a running task's
 *  *parent* and only holds the id, not the item; a note parent lists its children
 *  there either way. */
export function itemRoute(item: Pick<Item, 'id' | 'type'>): string {
  if (item.type === 'project') return `/project/${item.id}`;
  if (item.type === 'note') return `/note/${item.id}`;
  return `/focus/${item.id}`;
}
