/**
 * In-app natural-language command loop.
 *
 * Stage 2: when the Add box (or any client) sends a command, the configured LLM agent runs a
 * server-side **tool loop** — it calls tools (resolve/lists/items/nearby + add/complete/update/
 * set_tag_geo) which execute in-process against `agent-ops`, until it stops calling tools. The
 * user-facing reply is then **built deterministically from the tool results** (no second LLM
 * call), so it always reflects what actually happened. Token usage is summed across turns.
 *
 * Tolerant of weak/local models: if a turn returns no native tool calls but its text contains a
 * JSON action block (`{op…}` / `{actions:[…]}` / `[…]`), we execute that instead.
 */
import type { Db } from '@carbon/core';
import {
  chatLLM,
  recordAgentUsage,
  formatNow,
  type FullAgentRow,
  type ChatMsg,
  type ToolDef,
  type ToolCall,
  type Usage,
  type UsageKind,
} from './agents';
import { createAgentOps, type AgentApiDeps, type OpResult } from './agent-ops';
import { freshestDeviceLocation } from './auth';

const MAX_ITERS = 6;

// "Nearest PLACE" needs a location to anchor to. We use the user's last-known HA/GPS fix,
// but only if it's recent and reasonably precise — a stale or fuzzy fix would pin the
// geofence to the wrong store. These thresholds are deliberately generous; a future branch
// where every device pushes its own location will let us tighten them (and prefer the
// device's own fix over a shared HA one).
const ANCHOR_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours
const ANCHOR_MAX_ACCURACY_M = 5000; // ignore fixes worse than ~5 km

interface GeoPoint {
  lat: number;
  lng: number;
}

/** The user's anchor point for geocoding, or null when we have no usable recent location.
 *  Uses the freshest fix across all the user's devices (HA tracker, phone, browser …). */
function usableAnchor(db: AgentApiDeps['db'], userId: string): GeoPoint | null {
  if (userId === 'local') return null;
  const fix = freshestDeviceLocation(db, userId, ANCHOR_MAX_AGE_MS);
  if (!fix) return null;
  if (fix.accuracy != null && fix.accuracy > ANCHOR_MAX_ACCURACY_M) return null;
  return { lat: fix.lat, lng: fix.lng };
}

const GEO_HINT = `\n\nThe user's current location is known. When they ask to be reminded "at PLACE" (a \
shop or place), after add_tasks also call set_tag_geo {tag:"PLACE", near_name:"PLACE"} so the reminder \
fires at the nearest PLACE to them — you don't need coordinates, the app fills them in.`;

// Scheduling / sharing / assigning / timers, appended to whichever base prompt is in use so
// both the in-app box and chat surfaces share the same capability rules. Relies on the "current
// date and time" line (added below) to resolve relative dates.
const CAPABILITIES_HINT = `\n\nMore you can do (resolve all names by fuzzy match — pass plain names, never ids):
- Scheduling. A specific event time → due_date (ISO). "Remind me N before" → reminder_at = due − N. \
A plain "remind me at TIME" with no event → set both due_date and reminder_at to that time. Repeats \
("every Tuesday", "weekly", "monthly on the 3rd") → recurrence, e.g. weekly on Tuesday is \
{type:"weekly",interval:1,daysOfWeek:[2]} (daysOfWeek 0=Sun…6=Sat); monthly day 3 is \
{type:"monthly",interval:1,dayOfMonth:3}. Put dates/repeat on creation via add_tasks {tasks:[{title,…}]}, \
or change them later via update.
- Sharing & assigning. "Share X with NAME" → share {query:"X", users:["NAME"]}. "Assign X to NAME" → \
assign {query:"X", users:["NAME"]}. Call users first if unsure who exists. remove:true unshares/unassigns.
- Time tracking. "Start a timer on X" → start_timer {query:"X"}. "Stop the timer" → stop_timer {}.
- Completed/hidden tasks. To reopen, re-tag, edit or report on a finished task, reach it with done:false \
(complete), include_done:true (update/tag_items), or status:"done"|"all" (items).
Example — "Remind me to take my son to swimming every Tuesday at 5pm, remind me about an hour before, \
share it with Rachel": add_tasks {tasks:[{title:"Take son to swimming", due_date:"<next Tue 17:00>", \
reminder_at:"<that Tue 16:00>", recurrence:{type:"weekly",interval:1,daysOfWeek:[2]}}]} then \
share {query:"Take son to swimming", users:["Rachel"]}.`;

const SYSTEM_PROMPT = `You manage a user's tasks in Carbon by calling tools. The server resolves names \
to ids by fuzzy match, so pass plain names (a list name, a tag, a task title) — never ids.

- "Add X and Y to my LIST" → call add_tasks {list:"LIST", titles:["X","Y"]}.
- "Remind me to get X at PLACE" → add_tasks {list:"shopping", titles:["X"], tags:["PLACE"]}.
- "Mark/tick/check off X and Y" → call complete {queries:["X","Y"]}.
- "Tag everything in LIST with X" / "add the X tag to all items in LIST" → call tag_items {list:"LIST", add:["X"]}.
- "Add the X tag to A and B" → tag_items {queries:["A","B"], add:["X"]}.
- "What do I need at PLACE?" → call nearby {tag:"PLACE"}.

You can act on a whole list at once — tag, complete, or list its tasks — WITHOUT enumerating the items \
first; the server finds them. So to tag every item in a list, call tag_items with that list, not one call per item.

Write task titles cleanly: correct obvious spelling (e.g. "cardamon" → "cardamom") and use normal \
capitalization — capitalize the first word and proper nouns (brand/place names like "Coles"). Keep the \
title to just the item itself, not the surrounding sentence. Tag names stay short and lowercase.

Use one tool call with all the items rather than many calls. Do exactly what was asked — don't add or \
complete anything that wasn't mentioned. When you have done the work, stop (no more tool calls). You do \
not need to write a summary; the app reports the result.`;

// Conversational variant for chat surfaces (e.g. the Telegram bot). Unlike SYSTEM_PROMPT —
// which tells the model NOT to summarise because the in-app box builds the reply
// deterministically — this asks the model to answer the user in its own words after acting,
// so it can both *do* things and *report/answer* them ("what's due tomorrow in work?").
const CONVERSATIONAL_SYSTEM_PROMPT = `You are a helpful assistant managing a user's tasks in Carbon \
over a chat. You act by calling tools; the server resolves names to ids by fuzzy match, so pass plain \
names (a list name, a tag, a task title) — never ids.

- "Add X and Y to my LIST" → add_tasks {list:"LIST", titles:["X","Y"]}.
- "Mark/tick/check off X" → complete {queries:["X"]}. "Untick/uncheck X" → complete {queries:["X"], done:false}.
- "Tag everything in LIST with X" → tag_items {list:"LIST", add:["X"]}.
- Questions ("what's due tomorrow in work?", "what do I need at Coles?", "what's on my shopping list?") \
→ read with items/nearby/lists (use detail:true when you need due dates, flags or priorities) and ANSWER.

You can act on a whole list at once (tag/complete/list) WITHOUT enumerating items first — the server finds them. \
To act on items carrying a tag (e.g. "untick my weekly shopping items" where items are tagged "weekly"), \
pass that tag: complete {tag:"weekly", done:false} or tag_items {tag:"weekly", …}.

Write task titles cleanly (fix obvious spelling, capitalize the first word and proper nouns like "Coles"); \
tags stay short and lowercase. Do exactly what was asked — don't add or complete anything that wasn't mentioned. \
When you have the information or have finished the actions, reply to the user directly: a short, friendly, \
plain-text message (no markdown headings or tables) that says what you did or answers their question. \
If something couldn't be found, say so plainly.`;

const TOOLS: ToolDef[] = [
  {
    name: 'add_tasks',
    description:
      'Add one or more tasks to a list (creates the list/tags if missing). For plain tasks pass ' +
      'titles[]. For per-task scheduling pass tasks[] with {title, note?, due_date?, defer_date?, ' +
      'reminder_at? (all ISO datetimes), recurrence? (object {type,interval,daysOfWeek?,dayOfMonth?}), ' +
      'flagged?, priority? (0-3), tags?}.',
    parameters: {
      type: 'object',
      properties: {
        list: { type: 'string', description: 'the list/project name' },
        titles: { type: 'array', items: { type: 'string' }, description: 'task titles to add (plain)' },
        tasks: {
          type: 'array',
          description: 'tasks with scheduling/details; use instead of titles when dates/repeat/flag are involved',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              note: { type: 'string' },
              due_date: { type: 'string', description: 'ISO datetime' },
              defer_date: { type: 'string', description: 'ISO datetime' },
              reminder_at: { type: 'string', description: 'ISO datetime to fire a push reminder' },
              recurrence: { type: 'object', description: '{type:"daily"|"weekly"|"monthly"|"yearly", interval, daysOfWeek?:[0-6 Sun-Sat], dayOfMonth?}' },
              flagged: { type: 'boolean' },
              priority: { type: 'number', description: '0 none,1 low,2 med,3 high' },
              tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['title'],
          },
        },
        tags: { type: 'array', items: { type: 'string' }, description: 'tags to attach to all of them' },
      },
      required: [],
    },
  },
  {
    name: 'complete',
    description: 'Mark tasks done (or re-open with done=false). Returns matched + unmatched.',
    parameters: {
      type: 'object',
      properties: {
        queries: { type: 'array', items: { type: 'string' }, description: 'task names to mark off' },
        list: { type: 'string', description: 'limit the search to this list' },
        done: { type: 'boolean', description: 'false to re-open' },
      },
      required: ['queries'],
    },
  },
  {
    name: 'update',
    description:
      'Change fields on tasks by name. patch keys: note, flagged (bool), priority (0-3), ' +
      'due_date / defer_date / reminder_at (ISO datetime), estimate_minutes (number), ' +
      'recurrence (object {type:"daily"|"weekly"|"monthly"|"yearly", interval, daysOfWeek?:[0-6 Sun-Sat], dayOfMonth?}; null clears it), ' +
      'status ("active"|"done"|"dropped"). Pass include_done:true to edit a completed task.',
    parameters: {
      type: 'object',
      properties: {
        include_done: { type: 'boolean', description: 'match completed tasks too' },
        updates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              list: { type: 'string' },
              patch: { type: 'object' },
            },
            required: ['query', 'patch'],
          },
        },
      },
      required: ['updates'],
    },
  },
  {
    name: 'tag_items',
    description:
      'Add or remove tags on tasks in bulk. Target a whole list (all its tasks) with `list`, ' +
      'or specific tasks with `queries`/`ids`, or tasks already carrying a tag with `tag`. ' +
      'Pass `add` and/or `remove` tag names. The server finds the tasks — no need to list them first.',
    parameters: {
      type: 'object',
      properties: {
        list: { type: 'string', description: 'tag every task in this list' },
        tag: { type: 'string', description: 'tag every task already carrying this tag' },
        queries: { type: 'array', items: { type: 'string' }, description: 'specific task names' },
        add: { type: 'array', items: { type: 'string' }, description: 'tag names to add' },
        remove: { type: 'array', items: { type: 'string' }, description: 'tag names to remove' },
      },
      required: [],
    },
  },
  {
    name: 'set_tag_geo',
    description:
      "Set a tag's location (geofence). Pass near_name to pin the nearest matching place to the " +
      "user (the app supplies their coordinates), or geo for explicit coordinates.",
    parameters: {
      type: 'object',
      properties: {
        tag: { type: 'string' },
        near_name: { type: 'string', description: 'place/brand to locate near the user, e.g. "Coles"' },
        geo: {
          type: 'object',
          properties: {
            lat: { type: 'number' },
            lng: { type: 'number' },
            radius: { type: 'number' },
            label: { type: 'string' },
          },
        },
      },
      required: ['tag'],
    },
  },
  {
    name: 'resolve',
    description: 'Check how a name resolves before acting (kind: list|tag|task).',
    parameters: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['list', 'tag', 'task'] }, q: { type: 'string' } },
      required: ['kind', 'q'],
    },
  },
  {
    name: 'lists',
    description: 'List the task lists (projects).',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'items',
    description:
      'Show tasks in a list or with a tag. status defaults to "active"; pass "done" for completed ' +
      'or "all" for both. Use detail:true to get due dates, reminders, repeat, flags and priority.',
    parameters: {
      type: 'object',
      properties: {
        list: { type: 'string' },
        tag: { type: 'string' },
        q: { type: 'string' },
        status: { type: 'string', enum: ['active', 'done', 'all'] },
        detail: { type: 'boolean' },
      },
    },
  },
  {
    name: 'nearby',
    description: 'Show active tasks at a place (by tag or HA zone). Use for "what do I need at X".',
    parameters: {
      type: 'object',
      properties: { tag: { type: 'string' }, zone: { type: 'string' } },
    },
  },
  {
    name: 'users',
    description: 'List the people tasks can be shared with or assigned to (returns their names).',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'share',
    description:
      'Share task(s) with one or more people by name (they gain access). Target a task with query ' +
      '(or queries/list/tag). permission defaults to "write"; pass remove:true to unshare.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'the task to share' },
        queries: { type: 'array', items: { type: 'string' } },
        list: { type: 'string', description: 'share every task in this list' },
        users: { type: 'array', items: { type: 'string' }, description: 'people to share with, by name' },
        permission: { type: 'string', enum: ['read', 'write'] },
        remove: { type: 'boolean' },
      },
      required: ['users'],
    },
  },
  {
    name: 'assign',
    description:
      'Assign task(s) to one or more people by name (makes them responsible). Target with query ' +
      '(or queries/list/tag). Pass remove:true to unassign.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'the task to assign' },
        queries: { type: 'array', items: { type: 'string' } },
        list: { type: 'string' },
        users: { type: 'array', items: { type: 'string' }, description: 'people to assign, by name' },
        remove: { type: 'boolean' },
      },
      required: ['users'],
    },
  },
  {
    name: 'start_timer',
    description: 'Start time tracking on a task (stops any timer already running). Target by query.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, list: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'stop_timer',
    description: 'Stop the currently running time-tracking timer.',
    parameters: { type: 'object', properties: {} },
  },
];

type Ops = ReturnType<typeof createAgentOps>;

// Concise per-command tracing so a failing run can be diagnosed from the server log
// (text → anchor/geocoder state → each tool call + result → reply). On by default for
// single-tenant self-host; set CARBON_NL_DEBUG=0 to silence.
const NL_DEBUG = process.env.CARBON_NL_DEBUG !== '0';
function dbg(msg: string): void {
  if (NL_DEBUG) console.log(`[nl] ${msg}`);
}

/** Capitalise the first letter of a title (a deterministic safety net so titles don't
 *  depend on the model obeying the "capitalize" instruction). Leaves the rest as written,
 *  so model-supplied mid-word caps like "iPhone" survive. */
function tidyTitle(s: unknown): unknown {
  if (typeof s !== 'string') return s;
  return s.replace(/^(\s*)(\p{Ll})/u, (_m, ws: string, ch: string) => ws + ch.toUpperCase());
}
function tidyAddArgs(args: Record<string, unknown>): Record<string, unknown> {
  const a = { ...args };
  if (Array.isArray(a.titles)) a.titles = a.titles.map(tidyTitle);
  if (Array.isArray(a.tasks)) {
    a.tasks = (a.tasks as Array<Record<string, unknown>>).map((t) => ({ ...t, title: tidyTitle(t.title) }));
  }
  return a;
}

async function execTool(
  ops: Ops,
  userId: string,
  name: string,
  args: Record<string, unknown>,
  anchor: GeoPoint | null,
): Promise<OpResult<unknown>> {
  switch (name) {
    case 'add_tasks':
      return ops.addTasks(userId, tidyAddArgs(args));
    case 'complete':
      return ops.complete(userId, args);
    case 'update':
      return ops.update(userId, args);
    case 'tag_items':
      return ops.tagItems(userId, args);
    case 'set_tag_geo': {
      // The model passes near_name; we supply the user's coordinates from code so it
      // never has to know (or hallucinate) lat/lng.
      const a = { ...args };
      if (a.near_name && a.near == null && anchor) a.near = anchor;
      a.create_if_missing = true; // the tag was likely just created via add_tasks
      return await ops.tagGeo(userId, a);
    }
    case 'resolve':
      return ops.resolve(userId, args);
    case 'lists':
      return ops.lists(userId, args);
    case 'tags':
      return ops.tags(userId, args);
    case 'items':
      return ops.items(userId, args);
    case 'nearby':
      return await ops.nearby(userId, args);
    case 'users':
      return ops.users(userId);
    case 'share':
      return ops.share(userId, args);
    case 'assign':
      return ops.assign(userId, args);
    case 'start_timer':
      return ops.startTimer(userId, args);
    case 'stop_timer':
      return ops.stopTimer(userId);
    default:
      return { ok: false, status: 400, error: `unknown tool: ${name}` };
  }
}

export interface ExecutedTool {
  tool: string;
  args: Record<string, unknown>;
  result: OpResult<unknown>;
}

export interface CommandResult {
  reply: string;
  executed: ExecutedTool[];
  usage: Usage;
}

export interface AgentCommandOpts {
  /** Chat surfaces (Telegram): let the model phrase its own conversational reply (and answer
   *  questions) instead of the deterministic, terse reply the in-app Add box builds. */
  conversational?: boolean;
  /** Current time, taught to the model so relative dates ("due tomorrow") resolve. */
  now?: Date;
  /** IANA zone (e.g. "Australia/Melbourne") the current time is expressed in for the model.
   *  Without this, "now" is UTC and unlabeled, so relative dates resolve against the wrong
   *  local day/evening for anyone not colocated with the server. */
  timezone?: string | null;
  /** Which bucket to bill the token usage under (default 'nl_command'). */
  requestKind?: UsageKind;
  /** Prior turns of this chat (oldest first), inserted before the latest message so the model
   *  can resolve follow-ups like "add eggs to it" / "mark that off". The model is told to focus
   *  on the latest message and only lean on the thread when the message is unclear or refers back. */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

// Appended to the system prompt when prior turns are supplied (chat surfaces). Keeps the model
// anchored on the newest message while still able to resolve back-references.
const HISTORY_HINT = `The messages above the latest one are earlier turns in this chat, for context. \
Focus on the user's LATEST message. Only use the earlier conversation when the latest message is \
unclear on its own or refers back to it — e.g. "add eggs to it", "mark that off", "what about the work project?". \
Don't redo earlier requests.`;

/** Find and parse the first balanced JSON object/array in a string (tolerant fallback). */
function extractJson(text: string): unknown {
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const start = text.indexOf(open);
    if (start < 0) continue;
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === open) depth++;
      else if (text[i] === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

/** Map a loose {op,…} action (JSON fallback) to a tool call. */
function actionToToolCall(a: Record<string, unknown>): ToolCall | null {
  const op = String(a.op ?? a.tool ?? a.action ?? '').toLowerCase();
  const rest = { ...a };
  delete (rest as Record<string, unknown>).op;
  delete (rest as Record<string, unknown>).tool;
  delete (rest as Record<string, unknown>).action;
  const map: Record<string, string> = {
    add: 'add_tasks',
    add_tasks: 'add_tasks',
    create: 'add_tasks',
    complete: 'complete',
    done: 'complete',
    check_off: 'complete',
    update: 'update',
    set_geo: 'set_tag_geo',
    set_tag_geo: 'set_tag_geo',
    tag_geo: 'set_tag_geo',
    query: 'nearby',
    nearby: 'nearby',
    items: 'items',
    lists: 'lists',
    resolve: 'resolve',
    users: 'users',
    share: 'share',
    assign: 'assign',
    start_timer: 'start_timer',
    stop_timer: 'stop_timer',
  };
  const name = map[op];
  if (!name) return null;
  return { id: `fallback_${name}`, name, args: rest };
}

function fallbackToolCalls(text: string): ToolCall[] {
  const parsed = extractJson(text);
  if (!parsed) return [];
  const actions: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { actions?: unknown[] }).actions)
      ? (parsed as { actions: unknown[] }).actions
      : [parsed];
  return actions
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
    .map(actionToToolCall)
    .filter((tc): tc is ToolCall => tc !== null);
}

// ----- deterministic reply builder ------------------------------------------

function joinNames(xs: Array<{ title?: string; name?: string }>): string {
  return xs.map((x) => x.title ?? x.name ?? '').filter(Boolean).join(', ');
}

function buildReply(executed: ExecutedTool[], modelText: string): string {
  const lines: string[] = [];
  for (const e of executed) {
    if (!e.result.ok) continue;
    const d = e.result.data as Record<string, unknown>;
    if (e.tool === 'add_tasks') {
      const created = (d.created as Array<{ title: string }>) ?? [];
      const list = d.list as { name: string; created: boolean } | null;
      const tags = (d.tags as Array<{ name: string }>) ?? [];
      if (created.length) {
        const where = list ? ` to ${list.created ? 'new list ' : ''}"${list.name}"` : '';
        const tagStr = tags.length ? ` (tagged ${tags.map((t) => t.name).join(', ')})` : '';
        lines.push(`Added${where}${tagStr}: ${joinNames(created)}`);
      }
    } else if (e.tool === 'complete') {
      const matched = (d.matched as Array<{ title: string }>) ?? [];
      const unmatched = (d.unmatched as Array<{ query: string }>) ?? [];
      const verb = d.done === false ? 'Re-opened' : 'Marked off';
      if (matched.length) lines.push(`${verb}: ${joinNames(matched)}`);
      if (unmatched.length) lines.push(`Couldn't find: ${unmatched.map((u) => u.query).join(', ')}`);
    } else if (e.tool === 'update') {
      const matched = (d.matched as Array<{ title: string }>) ?? [];
      const unmatched = (d.unmatched as Array<{ query: string }>) ?? [];
      if (matched.length) lines.push(`Updated: ${joinNames(matched)}`);
      if (unmatched.length) lines.push(`Couldn't find: ${unmatched.map((u) => u.query).join(', ')}`);
    } else if (e.tool === 'tag_items') {
      const updated = (d.updated as unknown[]) ?? [];
      const added = (d.tags_added as string[]) ?? [];
      const removed = (d.tags_removed as string[]) ?? [];
      const unmatched = (d.unmatched as Array<{ query: string }>) ?? [];
      const n = updated.length;
      const tasks = `${n} task${n === 1 ? '' : 's'}`;
      if (n === 0) lines.push('No matching tasks to tag.');
      else if (added.length) lines.push(`Tagged ${tasks} with ${added.join(', ')}.`);
      else if (removed.length) lines.push(`Removed ${removed.join(', ')} from ${tasks}.`);
      // Some targets may have been skipped (read-only / not found) — say so rather than
      // implying everything was tagged.
      if (unmatched.length) lines.push(`Skipped: ${unmatched.map((u) => u.query).join(', ')}`);
    } else if (e.tool === 'set_tag_geo') {
      const tag = d.tag as { name: string };
      const geo = d.geo as { label?: string } | null;
      lines.push(
        geo
          ? `Set ${tag.name} location${geo.label ? ` (nearest: ${geo.label})` : ''}.`
          : `Cleared ${tag.name} location.`,
      );
    } else if (e.tool === 'nearby' || e.tool === 'items') {
      const items = (d.items as Array<{ title: string }>) ?? [];
      const where = e.tool === 'nearby' ? (e.args.tag ?? e.args.zone ?? 'there') : (e.args.list ?? 'that list');
      lines.push(items.length ? `At ${where}: ${joinNames(items)}` : `Nothing for ${where}.`);
    } else if (e.tool === 'share' || e.tool === 'assign') {
      const updated = (d.updated as Array<{ title: string }>) ?? [];
      const people = (d.users as Array<{ name: string }>) ?? [];
      const unknown = (d.unknown_users as string[]) ?? [];
      const unmatched = (d.unmatched as Array<{ query: string }>) ?? [];
      const who = people.map((u) => u.name).join(', ');
      if (updated.length && who) {
        const verb =
          e.tool === 'share'
            ? d.removed
              ? 'Unshared'
              : 'Shared'
            : d.removed
              ? 'Unassigned'
              : 'Assigned';
        const prep = e.tool === 'share' ? (d.removed ? 'from' : 'with') : d.removed ? 'from' : 'to';
        lines.push(`${verb} ${joinNames(updated)} ${prep} ${who}.`);
      }
      if (unknown.length) lines.push(`No such user: ${unknown.join(', ')}`);
      if (unmatched.length) lines.push(`Skipped: ${unmatched.map((u) => u.query).join(', ')}`);
    } else if (e.tool === 'start_timer') {
      const started = d.started as { title: string } | undefined;
      const stopped = d.stopped as { title: string } | null;
      if (started) {
        lines.push(
          stopped?.title
            ? `Started timer on ${started.title} (stopped ${stopped.title}).`
            : `Started timer on ${started.title}.`,
        );
      }
    } else if (e.tool === 'stop_timer') {
      const stopped = d.stopped as { title: string } | null;
      lines.push(stopped ? `Stopped timer${stopped.title ? ` on ${stopped.title}` : ''}.` : 'No timer running.');
    }
  }
  // Soft note when a "remind me at PLACE" geo lookup couldn't be pinned — the tasks + tag
  // still landed, so don't fail the whole reply. State *why* so the cause is obvious.
  for (const e of executed) {
    if (e.tool === 'set_tag_geo' && !e.result.ok && lines.length) {
      const place = (e.args.near_name as string) ?? (e.args.tag as string) ?? 'that place';
      const err = (e.result as { error: string }).error;
      // Match exact reason codes from agent-ops.tagGeo — not a substring sniff, so an
      // unexpected error reads as a generic note rather than a misleading location one.
      const why =
        err === 'geocoding_disabled'
          ? 'geocoding is off on the server'
          : err === 'could_not_geocode'
            ? `couldn't find a "${place}" near your location`
            : err === 'no_anchor_location'
              ? 'no recent location for you'
              : err;
      lines.push(`(Couldn't pin ${place}'s location — ${why}. Added the tag anyway.)`);
    }
  }
  // Surface a tool error if nothing else was produced.
  if (!lines.length) {
    const firstErr = executed.find((e) => !e.result.ok);
    if (firstErr && !firstErr.result.ok) return `Sorry — ${firstErr.result.error}.`;
    return modelText.trim() || "I'm not sure what to do with that.";
  }
  return lines.join('\n');
}

/**
 * Run an NL command end-to-end: tool loop → execute ops → deterministic reply. Records token
 * usage (request_kind 'nl_command'). Throws on provider transport errors (caller classifies).
 */
export async function runAgentCommand(
  deps: AgentApiDeps,
  agent: FullAgentRow,
  userId: string,
  text: string,
  allowPrivate: boolean,
  opts: AgentCommandOpts = {},
): Promise<CommandResult> {
  const ops = createAgentOps(deps);
  // Resolve a location anchor in code; only then do we teach the model the geo step. With no
  // usable location we send the plain prompt, so it won't try (and fail) to geolocate.
  const anchor = usableAnchor(deps.db, userId);
  dbg(
    `command user=${JSON.stringify(text)} agent=${agent.name}/${agent.model || '(default)'} ` +
      `mode=${opts.conversational ? 'chat' : 'inapp'} ` +
      `anchor=${anchor ? `${anchor.lat.toFixed(4)},${anchor.lng.toFixed(4)}` : 'none'} ` +
      `geocoder=${deps.geocode ? 'on' : 'off'}`,
  );
  let system = opts.conversational ? CONVERSATIONAL_SYSTEM_PROMPT : SYSTEM_PROMPT;
  system += CAPABILITIES_HINT;
  if (anchor) system += GEO_HINT;
  // Teach the model "now" (in the user's own zone, when known) so "due tomorrow" / "this
  // week" resolve against the user's local clock instead of the server's.
  if (opts.now) {
    system += `\n\nThe current date and time is ${formatNow(opts.now, opts.timezone)}. Resolve \
relative dates ("tonight", "tomorrow", "next Tuesday") against that local time and zone, but always \
write due_date / defer_date / reminder_at back out in UTC (ending in Z) — convert the local time you \
picked to UTC before returning it.`;
  }
  const history = opts.history ?? [];
  if (history.length) system += `\n\n${HISTORY_HINT}`;
  const messages: ChatMsg[] = [
    { role: 'system', content: system },
    ...history.map((h): ChatMsg => ({ role: h.role, content: h.content })),
    { role: 'user', content: text },
  ];
  const executed: ExecutedTool[] = [];
  const usage: Usage = { input: 0, output: 0 };
  let lastText = '';

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    const r = await chatLLM(agent, messages, TOOLS, allowPrivate);
    usage.input += r.usage.input;
    usage.output += r.usage.output;
    lastText = r.text;

    let calls = r.toolCalls;
    let native = true;
    if (!calls.length) {
      calls = fallbackToolCalls(r.text); // weak/local model emitted JSON in text
      native = false;
    }
    if (!calls.length) {
      dbg(`iter ${iter}: no tool calls; text=${JSON.stringify(r.text.slice(0, 200))}`);
      break; // model is done / just chatting
    }
    dbg(`iter ${iter}: ${native ? 'native' : 'json-fallback'} calls=${calls.map((c) => c.name).join(',')}`);

    if (native) messages.push({ role: 'assistant', content: r.text, toolCalls: calls });
    for (const tc of calls) {
      const result = await execTool(ops, userId, tc.name, tc.args, anchor);
      dbg(`  ${tc.name} ${JSON.stringify(tc.args)} -> ${result.ok ? 'ok' : 'ERR ' + result.error}`);
      executed.push({ tool: tc.name, args: tc.args, result });
      if (native) {
        messages.push({
          role: 'tool',
          toolCallId: tc.id,
          name: tc.name,
          content: JSON.stringify(result.ok ? result.data : { error: result.error }),
        });
      }
    }
    // A JSON-fallback turn isn't a real tool-calling conversation — execute once and stop.
    if (!native) break;
    // If only read tools were called, let the loop continue so the model can act; if a
    // mutation happened, it usually stops on its own next turn (or hits MAX_ITERS).
  }

  recordAgentUsage(deps.db, agent.id, usage, agent.model || '(default)', opts.requestKind ?? 'nl_command');
  // Conversational surfaces use the model's own final message (the no-tool turn that closes the
  // loop after it has seen the tool results — its narration/answer). The deterministic builder
  // is the fallback if the model ended without saying anything (empty text / hit MAX_ITERS).
  const reply = opts.conversational ? lastText.trim() || buildReply(executed, lastText) : buildReply(executed, lastText);
  dbg(`reply=${JSON.stringify(reply)} usage in=${usage.input} out=${usage.output}`);
  return { reply, executed, usage };
}

// Re-exported for the route layer to detect the no-agent case without importing agents twice.
export type { Db };
