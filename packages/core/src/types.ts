// Domain types for Carbon.
//
// An "item" is the single unifying entity: a `project` is a container, a `task`
// is an actionable leaf (or nested action). This mirrors OmniFocus, where the
// distinction between a project and an action is mostly about role in the tree.

// project = container, task = actionable leaf, folder = visual-only grouping of
// projects in the sidebar (never participates in task nesting/availability).
export type ItemType = 'project' | 'task' | 'folder';

// active   = available or deferred, not yet done
// done     = completed
// dropped  = abandoned (kept for history, not actionable)
export type ItemStatus = 'active' | 'done' | 'dropped';

// How a container's children become available:
// parallel   = all children available at once (default; previous behaviour)
// sequential = only the first incomplete child is available; later siblings
//              are blocked until earlier ones are done/dropped
// single     = single-action list (behaves like parallel for availability;
//              kept distinct for future "stalled project" review semantics)
export type OrderMode = 'parallel' | 'sequential' | 'single';

export interface Item {
  id: string;
  parent_id: string | null;
  type: ItemType;
  /** The user who owns this item (server-authoritative). null until first sync. */
  owner_id: string | null;
  title: string;
  note: string | null;
  status: ItemStatus;
  flagged: boolean;
  /** 0 = none, 1 = low, 2 = medium, 3 = high. */
  priority: number;
  /** ISO date; item is hidden from "available" lists until this date. */
  defer_date: string | null;
  /** ISO datetime. */
  due_date: string | null;
  /** ISO datetime to fire a push reminder (requires a due date). null = none. */
  reminder_at: string | null;
  /** Estimated effort in minutes, or null. */
  estimate_minutes: number | null;
  /** ISO datetime set when status -> done. */
  completed_at: string | null;
  /** Days between reviews (projects only). null = not reviewed. */
  review_interval: number | null;
  /** ISO datetime of last review. */
  reviewed_at: string | null;
  /** JSON-encoded RecurrenceRule, or null. */
  recurrence: string | null;
  /** JSON GeoReminder { lat, lng, radius, label } for location reminders, or null. */
  geo: string | null;
  /** Hex color, mainly for projects/visual grouping. */
  color: string | null;
  /** Sidebar folder this project belongs to (null = top-level/ungrouped). Visual
   *  grouping only — never used for task nesting; that is always via parent_id. */
  folder_id: string | null;
  /** Float position for ordering among siblings. */
  sort_order: number;
  /** How this container sequences its children (see OrderMode). */
  order_mode: OrderMode;
  created_at: string;
  updated_at: string;
  deleted: boolean;
}

/** A directed dependency edge: `pred_id` blocks `succ_id` until pred is done. */
export interface ItemDep {
  pred_id: string;
  succ_id: string;
  updated_at: string;
  deleted: boolean;
}

/** The subset of Item columns that mutations may change and that sync via ops. */
export type ItemPatch = Partial<
  Pick<
    Item,
    | 'parent_id'
    | 'type'
    | 'owner_id'
    | 'title'
    | 'note'
    | 'status'
    | 'flagged'
    | 'priority'
    | 'defer_date'
    | 'due_date'
    | 'reminder_at'
    | 'estimate_minutes'
    | 'completed_at'
    | 'review_interval'
    | 'reviewed_at'
    | 'recurrence'
    | 'geo'
    | 'color'
    | 'folder_id'
    | 'sort_order'
    | 'order_mode'
    | 'deleted'
  >
>;

export const ITEM_PATCH_FIELDS = [
  'parent_id',
  'type',
  'owner_id',
  'title',
  'note',
  'status',
  'flagged',
  'priority',
  'defer_date',
  'due_date',
  'reminder_at',
  'estimate_minutes',
  'completed_at',
  'review_interval',
  'reviewed_at',
  'recurrence',
  'geo',
  'color',
  'folder_id',
  'sort_order',
  'order_mode',
  'deleted',
] as const satisfies readonly (keyof ItemPatch)[];

export interface GeoReminder {
  lat: number;
  lng: number;
  /** Trigger radius in metres. */
  radius: number;
  /** Optional place name; also used to match Home Assistant zones by name. */
  label?: string;
}

export type ItemField = (typeof ITEM_PATCH_FIELDS)[number];

/**
 * An op is one atomic change to one item. `fields` carries only the columns that
 * changed; a key present with a `null` value means "clear this field" (the bug the
 * old delta format could not express). Merge is per-field last-write-wins ordered
 * by (ts, device_id).
 */
export interface Op {
  id: string;
  item_id: string;
  ts: number;
  device_id: string;
  fields: ItemPatch;
}

export type TagStatus = 'active' | 'on-hold';

export interface Tag {
  id: string;
  /** Full colon-delimited path, e.g. "Shopping:Coles:FreshGoods". */
  name: string;
  color: string | null;
  /** 'on-hold' tags defer their tasks out of Today/Available (OmniFocus-style). */
  status: TagStatus;
  /** Manual order among same-parent siblings (sidebar drag-reorder). */
  sort_order: number;
  /** Optional location, JSON-encoded GeoReminder. A task without its own location
   *  falls back to its tag's location, then its project's (task > tag > project). */
  geo: string | null;
  created_at: string;
  updated_at: string;
  deleted: boolean;
}

export interface ItemTag {
  item_id: string;
  tag_id: string;
  updated_at: string;
  deleted: boolean;
}

export type TimeLogKind = 'session' | 'task' | 'pause';

export interface TimeLog {
  id: string;
  item_id: string;
  user_id: string | null;
  start_time: string;
  end_time: string | null;
  note: string | null;
  created_at: string;
  /** 'session' (project block), 'task' (segment inside a session), or 'pause'. */
  kind: TimeLogKind;
  /** For task segments and pauses: the enclosing session id. */
  session_id: string | null;
  deleted: boolean;
}

// ----- multi-user / collaboration model (Phase C/D; schema reserved in v2) -----

export type UserRole = 'admin' | 'member';

export interface User {
  id: string;
  username: string;
  display_name: string | null;
  role: UserRole;
  is_bot: boolean;
  avatar_color: string | null;
  /** Custom avatar letter; falls back to first char of display_name/username. */
  avatar_initial: string | null;
  /** Planning budget: per-task start-up overhead (min). Null → default (10). */
  plan_startup_min: number | null;
  /** Planning budget: estimate for un-estimated tasks (min). Null → default (20). */
  plan_default_estimate_min: number | null;
  created_at: string;
  updated_at: string;
  deleted: boolean;
}

/** A task a user has curated into their personal Plan (Stage 2). */
export interface Plan {
  /** Deterministic `p:<user>:<item>`. */
  id: string;
  user_id: string | null;
  item_id: string;
  added_at: string;
  deleted: boolean;
}

/** Resolved planning-budget defaults (minutes). */
export const PLAN_DEFAULT_STARTUP_MIN = 10;
export const PLAN_DEFAULT_ESTIMATE_MIN = 20;

export type Permission = 'read' | 'write';

export interface Share {
  id: string;
  item_id: string;
  user_id: string;
  permission: Permission;
  created_at: string;
  updated_at: string;
  deleted: boolean;
}

export interface Assignee {
  id: string;
  item_id: string;
  user_id: string;
  created_at: string;
  updated_at: string;
  deleted: boolean;
}

export interface Comment {
  id: string;
  item_id: string;
  author_id: string | null;
  body: string;
  /** JSON-decoded list of mentioned user ids. */
  mentions: string[];
  created_at: string;
  updated_at: string;
  deleted: boolean;
}

export type AttachmentParent = 'item' | 'comment';

export interface Attachment {
  id: string;
  parent_type: AttachmentParent;
  parent_id: string;
  /** The owning task (denormalized for sync scoping). */
  item_id: string;
  filename: string;
  mime_type: string | null;
  size: number;
  /** Content-addressed blob reference. */
  hash: string;
  created_by: string | null;
  created_at: string;
  deleted: boolean;
}

export interface RecurrenceRule {
  type: 'daily' | 'weekly' | 'monthly' | 'yearly';
  /** e.g. every 2 weeks => interval 2. */
  interval: number;
  /** 0-6 (Sun-Sat) for weekly. */
  daysOfWeek?: number[];
  /** 1-31 for monthly. */
  dayOfMonth?: number;
  /** Anchor for the next occurrence when the task is completed:
   *  - 'scheduled'           : count from the previous due date *and* time (default)
   *  - 'completed-keep-time' : count from the completion date, but keep the
   *                            originally scheduled time-of-day (alarm/defer/due)
   *  - 'completed'           : count from the completion date *and* time
   *  Falls back to `fromCompletion` for items written before this field existed. */
  from?: 'scheduled' | 'completed' | 'completed-keep-time';
  /** @deprecated superseded by `from`; true ⇒ from='completed'. */
  fromCompletion?: boolean;
}
