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
import { getItem, type Db } from '@carbon/core';
import {
  chatLLM,
  recordAgentUsage,
  formatNow,
  type FullAgentRow,
  type ChatMsg,
  type ChatTuning,
  type ToolDef,
  type ToolCall,
  type Usage,
  type UsageKind,
} from './agents';
import { createAgentOps, type AgentApiDeps, type OpResult } from './agent-ops';
import { freshestDeviceLocation } from './auth';

const MAX_ITERS = 6;

/** Command routing wants determinism and speed, not creativity: low temperature keeps tool
 *  args stable across runs, and low reasoning effort (GPT-OSS/o-series) cuts latency — the
 *  loop's few-shot prompt does the "thinking". Env-overridable per deployment; "off" omits
 *  the param. Providers that reject either param are auto-detected in chatLLM and skipped. */
function nlTuningFromEnv(env: NodeJS.ProcessEnv): ChatTuning {
  const t: ChatTuning = {};
  const rawTemp = env.CARBON_NL_TEMPERATURE ?? '0.2';
  if (rawTemp.toLowerCase() !== 'off') {
    const n = Number(rawTemp);
    if (Number.isFinite(n) && n >= 0) t.temperature = n;
  }
  const rawEffort = (env.CARBON_NL_REASONING_EFFORT ?? 'low').toLowerCase();
  if (rawEffort === 'low' || rawEffort === 'medium' || rawEffort === 'high') t.reasoningEffort = rawEffort;
  return t;
}
const NL_TUNING = nlTuningFromEnv(process.env);

// Tools that change data; an exact repeat of a call from this set that already succeeded is
// skipped by the loop (read tools may be re-called freely).
const MUTATING_TOOLS = new Set([
  'add_tasks',
  'complete',
  'update',
  'tag_items',
  'set_tag_geo',
  'share',
  'assign',
  'start_timer',
  'stop_timer',
  'pause_timer',
  'resume_timer',
  'add_timer_note',
]);

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

const GEO_HINT = `\n\nThe user's current location is known. When they ask to be reminded "at PLACE" \
(a shop or place), tag the new task with the place in the add_tasks call (tags:["PLACE"], short and \
lowercase), then call set_tag_geo {tag:"PLACE", near_name:"PLACE"} so the reminder fires at the \
nearest PLACE to them. Never supply coordinates — the app fills them in.`;

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
- Time tracking (v2 sessions). "Start a timer on X" → start_timer {query:"X"}. \
"Start timing project Y" → start_timer {query:"Y", project:true}. "Stop the timer" → stop_timer {}. \
"Pause for 10 minutes" → pause_timer {minutes:10}. "Pause the last 5 minutes" → pause_timer {minutes:5, before:true}. \
"Resume" → resume_timer {}. "Add a time note: traffic jam" → add_timer_note {title:"traffic jam"}.
- Editing. "Rename X to Y" → update {updates:[{query:"X", patch:{title:"Y"}}]}. "Make X high priority" → \
patch {priority:3} (0 none, 1 low, 2 medium, 3 high); "flag X" → patch {flagged:true}. "Remove the due \
date" → patch {due_date:null}.
- Removing. "Remove/delete X" → update {updates:[{query:"X", patch:{status:"dropped"}}]} — never mark a \
task done just to make it disappear. There is no tool to delete a list or move an item to another list; \
if asked, do nothing and say so.
- Completed/hidden tasks. To reopen, re-tag, edit or report on a finished task, reach it with done:false \
(complete), include_done:true (update/tag_items), or status:"done"|"all" (items).
Example — "Remind me to take my son to swimming every Tuesday at 5pm, remind me about an hour before, \
share it with Rachel": add_tasks {tasks:[{title:"Take son to swimming", due_date:"<next Tue 17:00>", \
reminder_at:"<that Tue 16:00>", recurrence:{type:"weekly",interval:1,daysOfWeek:[2]}}]} then \
share {query:"Take son to swimming", users:["Rachel"]}.`;

// Note-vs-task disambiguation, shared by both prompts. "Note" is overloaded — a FIELD (the
// body text on any item) and an item TYPE (a standalone note with no due date/checkbox) — so
// the exact phrasing below distinguishes the four cases the plan calls out.
const NOTES_HINT = `

Notes: a note is an item type (like a task, but no due date/checkbox — just a title + body). \
The word "note" is also the name of the body-text field every task/note already has, so read the \
phrasing carefully:
- "Add a note TO X" / "add a note ON X" (X already exists) → update X's note field: \
update {updates:[{query:"X", patch:{note:"…"}}]}.
- "Add a task X with a note saying …" → add_tasks {tasks:[{title:"X", note:"…"}]} (creates a task \
whose note field holds the extra text).
- "Add/write a note about Y" / "write down Y" / "make a note that …" (no existing item named) → \
create a standalone note item: add_tasks {tasks:[{title:"Y", type:"note"}]} (title:"Y" or a short \
title summarizing what was written down; put the body in note if there's more than a short line).
- "Turn that note into a task" / "make X a task" (X is a note) → update {updates:[{query:"X", \
patch:{type:"task"}}]}. Converting a note back to a task restores whatever status/dates/flags it \
had before — nothing needs to be re-specified unless the user wants to change them. The reverse — \
"turn X into a note" — is update {updates:[{query:"X", patch:{type:"note"}}]}.
- To ADD to a note without losing what's in it → update {updates:[{query:"X", \
patch:{note_append:"the new line"}}]}. The server keeps the existing body and appends, so never \
read a note just to write it back — patch:{note:"…"} REPLACES the whole body.
- To find text INSIDE a note's body (not just its title), use search_notes, not items.
- Notebooks. A list reported by lists with notes:true holds notes, not tasks. Read one with \
items {list:"NAME", type:"note"} (detail:true for the bodies), and add to one WITHOUT passing \
type — new items in a notebook are notes automatically.
- Recipes are notes kept in recipe mode (reported as note_mode:"recipe"). "Add a recipe for X" / \
"save this recipe" → add_tasks {tasks:[{title:"X", note_mode:"recipe", note:"<the recipe as \
Markdown>"}]}, into the user's recipe notebook if they have one (resolve {kind:"list", q:"recipes"}). \
Keep the ingredients and steps exactly as given — never invent, drop or reorder any. "Add … to the X \
recipe" is an append: update {updates:[{query:"X", patch:{note_append:"…"}}]}.`;

const PLACEMENT_RULES = `Project/list placement:
- If the user explicitly asks to create/make a new list or project, use add_tasks with \
create_list_if_missing:true for that list.
- Otherwise, never create a new list/project. For any add_tasks call that includes list, pass \
create_list_if_missing:false.
- If the user explicitly names a list/project but did not ask to create it, use that list with \
create_list_if_missing:false; if it is missing, the tool will say so.
- If the user does NOT specify a list/project but you infer one (for example groceries → Shopping), \
first call resolve {kind:"list", q:"INFERRED"}. If resolve returns a confident existing list, add \
there with create_list_if_missing:false. If it does not, add to the current project context when one \
is provided; otherwise omit list so the task lands in Inbox.`;

// Shared by both prompts: title/tag hygiene and the do-no-more guardrails. People are often
// vague or dictating (voice keyboards, Telegram voice notes), so the model must extract the
// item from around fillers and self-corrections without inventing anything extra.
const TITLE_HINT = `Write task titles cleanly: correct obvious misspellings ("cardamon" → "cardamom") \
and capitalize the first word and proper nouns (brand/place names like "Coles"). Keep the title to the \
item itself, not the surrounding sentence ("could you add milk please" → "Milk"). Tag names stay short \
and lowercase.`;

const GUARDRAILS = `Do exactly what was asked, nothing more:
- Never add, complete, or change anything the user didn't mention, and never repeat a tool call that \
already succeeded.
- Never invent dates or times. "Remind me to call Jim" with no time given → a plain task with no \
due_date or reminder_at.
- The message may be dictated speech: ignore filler words, and apply self-corrections ("add milk — \
actually make that almond milk" → one task, "Almond milk").
- Batch: one tool call carrying all the items, not one call per item.`;

const SYSTEM_PROMPT = `You manage a user's tasks in Carbon by calling tools. The server resolves names \
to ids by fuzzy match, so pass plain names (a list name, a tag, a task title) — never ids, except when \
using the system-provided current project context exactly as instructed below.

- "Add X and Y to my LIST" → call add_tasks {list:"LIST", create_list_if_missing:false, titles:["X","Y"]}.
- "Remind me to get X at PLACE" (no list named, but shopping is a guess) → resolve {kind:"list", q:"shopping"}; \
if it exists, add_tasks {list:"shopping", create_list_if_missing:false, titles:["X"], tags:["PLACE"]}; \
otherwise use the current project context if provided, or omit list for Inbox.
- "Mark/tick/check off X and Y", or a past-tense statement meaning it's done ("I got the milk", \
"bought the eggs", "picked up the prescription") → call complete {queries:["X","Y"]}.
- "Tag everything in LIST with X" / "add the X tag to all items in LIST" → call tag_items {list:"LIST", add:["X"]}.
- "Add the X tag to A and B" → tag_items {queries:["A","B"], add:["X"]}.
- "What do I need at PLACE?" → call nearby {tag:"PLACE"}.
${NOTES_HINT}

${PLACEMENT_RULES}

You can act on a whole list or tag in ONE call — the server finds the items, never enumerate them \
yourself: tag_items {list:"LIST", add:[…]} tags everything in it; complete {list:"LIST"} (or \
{tag:"TAG"}) with no queries ticks off everything in it; items {list:"LIST"} reads it.

${TITLE_HINT}

${GUARDRAILS}

If the request is ambiguous or needs something no tool can do, make no tool calls and reply with one \
short sentence saying so — that text is shown to the user. Otherwise, when the work is done, stop \
calling tools; the app reports the result itself, so don't write a summary.`;

// Conversational variant for chat surfaces (e.g. the Telegram bot). Unlike SYSTEM_PROMPT —
// which tells the model NOT to summarise because the in-app box builds the reply
// deterministically — this asks the model to answer the user in its own words after acting,
// so it can both *do* things and *report/answer* them ("what's due tomorrow in work?").
const CONVERSATIONAL_SYSTEM_PROMPT = `You are a helpful assistant managing a user's tasks in Carbon \
over a chat. You act by calling tools; the server resolves names to ids by fuzzy match, so pass plain \
names (a list name, a tag, a task title) — never ids, except when using a system-provided current \
project context exactly as instructed below.

- "Add X and Y to my LIST" → add_tasks {list:"LIST", create_list_if_missing:false, titles:["X","Y"]}.
- "Mark/tick/check off X", or a past-tense statement meaning it's done ("I got the milk", "bought the \
eggs") → complete {queries:["X"]}. "Untick/uncheck X" → complete {queries:["X"], done:false}.
- "Tag everything in LIST with X" → tag_items {list:"LIST", add:["X"]}.
- Questions ("what do I need at Coles?", "what's on my shopping list?") → read with items/nearby/lists \
(use detail:true when you need due dates, flags or priorities) and ANSWER.
- Date questions: "what's due tomorrow in work?" → items {list:"work", due_before:"<end of tomorrow, \
local time with offset>"}; "what's overdue?" → items {due_before:"<now>"}. Omit list to search everywhere.
- "Find my note about Y" / "what did I write about Y" / "search my notes for Y" → search_notes {q:"Y"}.
${NOTES_HINT}

${PLACEMENT_RULES}

Chat defaults (this chat only — these refine the rules above and win where they overlap):
- A bare shopping-ish item → the shopping list. If the message just names something the user would \
buy (groceries, ingredients, household or hardware items) with no list and no other instruction — \
"milk", "AA batteries", "cumin and rice" — add it to their shopping list: resolve {kind:"list", \
q:"shopping"} (try "groceries" too if that misses), and if it resolves confidently (best.confident) \
add there with create_list_if_missing:false. Never create a shopping list yourself. If no \
shopping-type list resolves, or you're not sure the item is really shopping, omit list so it lands \
in Inbox.
- Never create a note unless clearly asked to. Default a bare item to a task (or the shopping add \
above), NOT a note. Only create a note item (type:"note") when the user explicitly uses note-writing \
wording — "note down …", "add a note …", "make a note …", "write down …", "remember that …", or asks \
for a recipe to be saved. Without such wording, never produce type:"note". The one exception needs no \
wording and no type at all: an add into a notebook (a list with notes:true) is a note by definition — \
just omit type and let the list decide.
- "Add to <name> note, DETAIL" APPENDS to an existing note — it never overwrites the body. One call: \
update {updates:[{query:"<name>", patch:{note_append:"DETAIL"}}]} (e.g. "add to Bread Recipe note, rest \
for 45 min" keeps the whole recipe and adds "Rest for 45 min" on a new line). Don't read the note first, \
and don't use patch:{note:…} for this — that would replace everything. If no note by that name exists, \
check with resolve {kind:"note", q:"<name>"}; if it really doesn't, say so — don't create one.

If a search_notes/items result's note content is long, don't paste the whole body into your reply — \
summarize the relevant part in your own words (a sentence or two) and point the user at the item by \
title (e.g. "your note 'Trip planning' mentions …") so they can open it for the rest. A body marked \
note_truncated was cut short for you: summarize what you got or re-read that one note with full:true, \
and never write it back.

You can act on a whole list or tag in ONE call — the server finds the items, never enumerate them \
yourself: "untick my weekly shopping items" (items tagged "weekly") → complete {tag:"weekly", done:false}; \
"tick everything off LIST" → complete {list:"LIST"}; bulk tagging → tag_items {list:…} or {tag:…}.

${TITLE_HINT}

${GUARDRAILS}

When you have the information or have finished the actions, reply to the user directly: a short, \
friendly, plain-text message (no markdown headings or tables) that says what you did or answers their \
question. If something couldn't be found or isn't something your tools can do, say so plainly. If a \
request is ambiguous or would touch more than the user probably means (e.g. "clear my list" — complete \
everything? drop everything?), ask one short clarifying question instead of guessing.`;

const TOOLS: ToolDef[] = [
  {
    name: 'add_tasks',
    description:
      'Add one or more tasks OR notes to a list (tags may be created if missing). The command loop ' +
      'does not create lists/projects unless create_list_if_missing is true. For plain tasks ' +
      'pass titles[]. For per-task scheduling, a note body, or to create ' +
      'a note item, pass tasks[] with {title, type? ("task" or "note"), note_mode? ("recipe"), note?, ' +
      'due_date?, defer_date?, reminder_at? (all ISO datetimes), recurrence? (object {type,interval,' +
      'daysOfWeek?,dayOfMonth?}), flagged?, priority? (0-3), tags?}. A note is a title + body with no due ' +
      'date/checkbox — use type:"note" when the user wants to write something down, not something to do, ' +
      'and note_mode:"recipe" (which implies a note) for a recipe, so it opens in the recipe editor. ' +
      'An omitted type follows the list: inside a notebook (a list reported with notes:true) new items ' +
      'are notes automatically — do not pass type:"task" there.',
    parameters: {
      type: 'object',
      properties: {
        list: {
          anyOf: [{ type: 'string' }, { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }],
          description: 'the existing list/project name, or {id} only for system-provided current project context',
        },
        create_list_if_missing: {
          type: 'boolean',
          description: 'true only when the user explicitly asked to create/make a new list or project; otherwise false',
        },
        titles: { type: 'array', items: { type: 'string' }, description: 'task titles to add (plain)' },
        tasks: {
          type: 'array',
          description: 'tasks/notes with scheduling/details; use instead of titles when dates/repeat/flag/type/note are involved',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              type: { type: 'string', enum: ['task', 'note'], description: 'omit to follow the list (notes in a notebook, tasks elsewhere); "note" creates a note item (body in note, no due date/checkbox)' },
              note_mode: { type: 'string', enum: ['recipe'], description: 'create the note in recipe mode; implies type:"note"' },
              note: { type: 'string' },
              due_date: { type: 'string', description: 'ISO datetime with UTC offset; omit unless the user gave a date/time' },
              defer_date: { type: 'string', description: 'ISO datetime with UTC offset; omit unless asked' },
              reminder_at: { type: 'string', description: 'ISO datetime with UTC offset to fire a push reminder; omit unless asked' },
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
    description:
      'Mark tasks done (or re-open with done:false). Pass queries[] of task names; or pass ONLY ' +
      'list or tag (no queries) to complete/re-open every task in that list or carrying that tag. ' +
      'Returns matched + unmatched.',
    parameters: {
      type: 'object',
      properties: {
        queries: { type: 'array', items: { type: 'string' }, description: 'task names to mark off' },
        list: { type: 'string', description: 'limit queries to this list, or (with no queries) act on the whole list' },
        tag: { type: 'string', description: 'limit queries to this tag, or (with no queries) act on every task carrying it' },
        done: { type: 'boolean', description: 'false to re-open' },
      },
      required: [],
    },
  },
  {
    name: 'update',
    description:
      'Change fields on tasks or notes by name. patch keys: title (rename), ' +
      'note (REPLACES the body text — use this to add/replace ' +
      'a note ON an existing task or note, e.g. "add a note to X"), ' +
      'note_append (append a line to the existing body instead of replacing it — the server keeps ' +
      'what is already there, so never read a body just to write it back), ' +
      'note_mode ("recipe" or "notes" — which editor a note opens in), ' +
      'type ("task" or "note" — converts the ' +
      'item; converting a note back to a task restores whatever status it had before it became a note, ' +
      'since status is preserved untouched the whole time it was a note), flagged (bool), priority (0-3), ' +
      'due_date / defer_date / reminder_at (ISO datetime), estimate_minutes (number), ' +
      'recurrence (object {type:"daily"|"weekly"|"monthly"|"yearly", interval, daysOfWeek?:[0-6 Sun-Sat], dayOfMonth?}; null clears it), ' +
      'status ("active"|"done"|"dropped") — can be combined with type:"task" in one call to convert AND set a status. ' +
      'Pass include_done:true to edit a completed task. Targets both tasks and notes by name (no need to ' +
      'know which it currently is).',
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
    description:
      'Check how a name resolves before acting (kind: list|tag|task|note). kind:"task" matches ' +
      'tasks AND notes and reports each candidate\'s type; use kind:"note" to match notes only.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['list', 'tag', 'task', 'note'] },
        q: { type: 'string' },
      },
      required: ['kind', 'q'],
    },
  },
  {
    name: 'lists',
    description:
      'List the task lists (projects). A list with notes:true is a notebook — it holds notes ' +
      '(recipes, write-ups), not tasks, so read it with items {list:…, type:"note"}.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'tags',
    description: 'List the tags in use.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'items',
    description:
      'Show tasks and/or notes in a list or with a tag. status defaults to "active"; pass "done" for ' +
      'completed or "all" for both. type defaults to "task" — pass "note" for notes only or "all" for ' +
      'both (inside a notebook it defaults to "note", since a notebook holds no tasks). ' +
      'For date questions ("what\'s due today / this week / overdue?") pass due_before and/or due_after — ' +
      'only items WITH a due date match, soonest first. ' +
      'Use detail:true to get note bodies, due dates, reminders, repeat, flags and priority (and each ' +
      "item's type). Long note bodies come back cut short and marked note_truncated — summarize those " +
      'from the part you got, or re-read the one item with full:true; never write a truncated body back ' +
      '(use update note_append to add to a note).',
    parameters: {
      type: 'object',
      properties: {
        list: { type: 'string' },
        tag: { type: 'string' },
        q: { type: 'string' },
        status: { type: 'string', enum: ['active', 'done', 'all'] },
        type: { type: 'string', enum: ['task', 'note', 'all'], description: 'defaults to "task"' },
        due_before: { type: 'string', description: 'ISO datetime with offset; only items due at/before it, e.g. end of "today"/"this week". Overdue = due_before now.' },
        due_after: { type: 'string', description: 'ISO datetime with offset; only items due at/after it. Combine with due_before for a window.' },
        detail: { type: 'boolean' },
        full: { type: 'boolean', description: 'with detail, return note bodies whole instead of cut short; use only when reading ONE note' },
      },
    },
  },
  {
    name: 'search_notes',
    description:
      'Search inside note BODIES (not just titles) for matching text and return snippets with item ids. ' +
      'Use this for "find my note about Y" / "what did I write about Y" / "search my notes for Y" — items ' +
      'tool only matches titles, this matches the content. type defaults to "note" (pass "task" or "all" ' +
      'to also/instead search task notes).',
    parameters: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'text to find inside the note body' },
        list: { type: 'string' },
        tag: { type: 'string' },
        type: { type: 'string', enum: ['task', 'note', 'all'], description: 'defaults to "note"' },
      },
      required: ['q'],
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
    description:
      'Start time tracking on a task or project (parks any other open session). Target by query or id.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        id: { type: 'string' },
        list: { type: 'string' },
        project: {
          type: 'boolean',
          description: 'Force a project-level session (no task segment)',
        },
      },
    },
  },
  {
    name: 'stop_timer',
    description: 'Stop the currently running time-tracking session.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'pause_timer',
    description:
      'Pause the active session. minutes=null/omit for indefinite; before:true carves out the last N minutes retroactively.',
    parameters: {
      type: 'object',
      properties: {
        minutes: { type: 'number' },
        before: { type: 'boolean' },
      },
    },
  },
  {
    name: 'resume_timer',
    description: 'Resume from a break pause, or resume a parked session via session_id.',
    parameters: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
    },
  },
  {
    name: 'add_timer_note',
    description:
      'Add a time note to the active tracking session (creates a note under the tracked task/project and pins it in the time block).',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        metadata: { type: 'object' },
      },
      required: ['title'],
    },
  },
];

type Ops = ReturnType<typeof createAgentOps>;

// Concise per-command tracing so a failing run can be diagnosed from the server log
// (text → anchor/geocoder state → each tool call + result → reply). Off by default;
// set CARBON_NL_DEBUG=1 (or true) to enable.
const NL_DEBUG =
  process.env.CARBON_NL_DEBUG === '1' || process.env.CARBON_NL_DEBUG === 'true';
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
/** The clock the command runs against: opts.now + opts.timezone, when the route supplied them. */
interface Clock {
  now: Date;
  timezone?: string | null;
}

interface LocalParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function partsInZone(date: Date, tz: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') };
}

/** Convert local wall-clock parts in `tz` back to a UTC instant. The offset depends on the
 *  instant being converted (DST), so guess with the current offset and correct once. */
function zonedToUtc(p: LocalParts, tz: string): Date {
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  const offsetAt = (utcMs: number) => {
    const q = partsInZone(new Date(utcMs), tz);
    return Date.UTC(q.y, q.mo - 1, q.d, q.h, q.mi, q.s) - utcMs;
  };
  return new Date(asUtc - offsetAt(asUtc - offsetAt(asUtc)));
}

/** Weekday (0=Sun…6=Sat, matching RecurrenceRule.daysOfWeek) of a local calendar date. */
function weekdayOf(p: LocalParts): number {
  return new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay();
}

/** Deterministic safety net for "every Tuesday"-style creations: models regularly miscompute
 *  which calendar date a weekday falls on, so a weekly recurrence could arrive with a due_date
 *  on the wrong day (e.g. "every Tuesday 4pm" due on a Saturday). When the due date's local
 *  weekday isn't in daysOfWeek, move it to the earliest requested weekday at or after `now`,
 *  keeping the model's local time-of-day, and shift reminder_at/defer_date by the same amount
 *  so "an hour before" style offsets survive. */
function snapDueToRecurrenceWeekday(
  t: Record<string, unknown>,
  clock: Clock,
): Record<string, unknown> {
  const rec = (typeof t.recurrence === 'object' && t.recurrence !== null ? t.recurrence : null) as {
    type?: unknown;
    daysOfWeek?: unknown;
  } | null;
  if (!rec || rec.type !== 'weekly' || !Array.isArray(rec.daysOfWeek)) return t;
  const days = rec.daysOfWeek.filter((n): n is number => typeof n === 'number' && n >= 0 && n <= 6);
  if (!days.length || typeof t.due_date !== 'string') return t;
  const due = new Date(t.due_date);
  if (Number.isNaN(due.getTime())) return t;
  const tz = clock.timezone || 'UTC';
  let dueParts: LocalParts;
  let nowParts: LocalParts;
  try {
    dueParts = partsInZone(due, tz);
    nowParts = partsInZone(clock.now, tz);
  } catch {
    return t; // invalid zone name — leave the model's dates alone
  }
  if (days.includes(weekdayOf(dueParts))) return t;
  for (let k = 0; k <= 7; k++) {
    // Walk local calendar days from today; UTC date arithmetic is safe here because only
    // the y/m/d roll-over matters, the wall-clock time comes from the model's due date.
    const day = new Date(Date.UTC(nowParts.y, nowParts.mo - 1, nowParts.d + k));
    if (!days.includes(day.getUTCDay())) continue;
    const snapped = zonedToUtc(
      {
        y: day.getUTCFullYear(),
        mo: day.getUTCMonth() + 1,
        d: day.getUTCDate(),
        h: dueParts.h,
        mi: dueParts.mi,
        s: dueParts.s,
      },
      tz,
    );
    if (snapped.getTime() < clock.now.getTime()) continue; // today matches but the time already passed
    const delta = snapped.getTime() - due.getTime();
    const out: Record<string, unknown> = { ...t, due_date: snapped.toISOString() };
    for (const field of ['reminder_at', 'defer_date'] as const) {
      if (typeof t[field] !== 'string') continue;
      const v = new Date(t[field] as string);
      if (!Number.isNaN(v.getTime())) out[field] = new Date(v.getTime() + delta).toISOString();
    }
    dbg(`  snapped due_date ${t.due_date} -> ${out.due_date} (daysOfWeek ${JSON.stringify(days)}, tz ${tz})`);
    return out;
  }
  return t;
}

function tidyAddArgs(args: Record<string, unknown>, clock: Clock | null): Record<string, unknown> {
  const a = { ...args };
  if (a.list !== undefined && a.create_list_if_missing === undefined) a.create_list_if_missing = false;
  if (Array.isArray(a.titles)) a.titles = a.titles.map(tidyTitle);
  if (Array.isArray(a.tasks)) {
    a.tasks = (a.tasks as Array<Record<string, unknown>>).map((t) => {
      const tidied = { ...t, title: tidyTitle(t.title) };
      return clock ? snapDueToRecurrenceWeekday(tidied, clock) : tidied;
    });
  }
  return a;
}

async function execTool(
  ops: Ops,
  userId: string,
  name: string,
  args: Record<string, unknown>,
  anchor: GeoPoint | null,
  clock: Clock | null,
): Promise<OpResult<unknown>> {
  switch (name) {
    case 'add_tasks':
      return ops.addTasks(userId, tidyAddArgs(args, clock));
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
    case 'search_notes':
      return ops.searchNotes(userId, args);
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
    case 'pause_timer':
      return ops.pauseTimer(userId, args);
    case 'resume_timer':
      return ops.resumeTimer(userId, args);
    case 'add_timer_note':
      return ops.addTimerNote(userId, args as { title: string });
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
  /** Project page the command was entered from. Non-project surfaces omit this and fall back to Inbox. */
  currentProjectId?: string | null;
}

// Appended to the system prompt when prior turns are supplied (chat surfaces). Keeps the model
// anchored on the newest message while still able to resolve back-references.
const HISTORY_HINT = `The messages above the latest one are earlier turns in this chat, for context. \
Focus on the user's LATEST message. Only use the earlier conversation when the latest message is \
unclear on its own or refers back to it — e.g. "add eggs to it", "mark that off", "what about the work project?". \
Don't redo earlier requests.`;

function currentProjectHint(deps: AgentApiDeps, userId: string, projectId: string | null | undefined): string | null {
  if (!projectId) return null;
  const item = getItem(deps.db, projectId);
  if (!item || item.deleted || item.type !== 'project' || !deps.canSee(userId, item.id)) return null;
  const name = JSON.stringify(item.title || 'Untitled project');
  const id = JSON.stringify(item.id);
  return `Current project context: the in-app command was entered from project ${name} (id ${id}). \
When the placement rules say to use the current project, call add_tasks with list:{id:${id}} \
and create_list_if_missing:false.`;
}

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
    pause_timer: 'pause_timer',
    resume_timer: 'resume_timer',
    add_timer_note: 'add_timer_note',
    search_notes: 'search_notes',
    search: 'search_notes',
    find_notes: 'search_notes',
    tag_items: 'tag_items',
    add_tags: 'tag_items',
    remove_tags: 'tag_items',
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
      const created = (d.created as Array<{ title: string; type?: string; note_mode?: string }>) ?? [];
      const list = d.list as { name: string; created: boolean } | null;
      const tags = (d.tags as Array<{ name: string }>) ?? [];
      if (created.length) {
        const where = list ? ` to ${list.created ? 'new list ' : ''}"${list.name}"` : '';
        const tagStr = tags.length ? ` (tagged ${tags.map((t) => t.name).join(', ')})` : '';
        // Say "note(s)"/"recipe(s)" instead of the generic "Added" when everything created was
        // one, so the reply doesn't call a note a "task". Notes land here without the model
        // asking for them too — inside a notebook every new item is a note.
        const allNotes = created.every((c) => c.type === 'note');
        const allRecipes = allNotes && created.every((c) => c.note_mode === 'recipe');
        const noun = allRecipes ? 'recipe' : 'note';
        const verb = allNotes ? `Added ${noun}${created.length === 1 ? '' : 's'}` : 'Added';
        lines.push(`${verb}${where}${tagStr}: ${joinNames(created)}`);
      }
    } else if (e.tool === 'search_notes') {
      const matches = (d.matches as Array<{ title: string; snippet: string }>) ?? [];
      if (matches.length) {
        lines.push(
          `Found in notes:\n${matches.map((m) => `- ${m.title}: ${m.snippet}`).join('\n')}`,
        );
      } else {
        lines.push('No notes matched that search.');
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
      if (e.tool === 'items' && (e.args.due_before || e.args.due_after)) {
        lines.push(items.length ? `Due: ${joinNames(items)}` : 'Nothing due in that window.');
      } else {
        const where =
          e.tool === 'nearby'
            ? (e.args.tag ?? e.args.zone ?? 'there')
            : (e.args.list ?? e.args.tag ?? 'your tasks');
        lines.push(items.length ? `At ${where}: ${joinNames(items)}` : `Nothing for ${where}.`);
      }
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
      const stopped = d.stopped as {
        task?: { title: string } | null;
        project?: { title: string } | null;
      } | null;
      if (!stopped) lines.push('No timer running.');
      else {
        const label = stopped.task?.title || stopped.project?.title;
        lines.push(label ? `Stopped timer on ${label}.` : 'Stopped timer.');
      }
    } else if (e.tool === 'pause_timer') {
      lines.push('Paused timer.');
    } else if (e.tool === 'resume_timer') {
      lines.push('Resumed timer.');
    } else if (e.tool === 'add_timer_note') {
      const note = d.note as { title: string } | undefined;
      lines.push(note ? `Added time note: ${note.title}.` : 'Added time note.');
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
  const clock: Clock | null = opts.now ? { now: opts.now, timezone: opts.timezone } : null;
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
  const projectHint = currentProjectHint(deps, userId, opts.currentProjectId);
  if (projectHint) system += `\n\n${projectHint}`;
  // Teach the model "now" (in the user's own zone, when known) so "due tomorrow" / "this
  // week" resolve against the user's local clock instead of the server's. Datetimes are asked
  // for as LOCAL time + the offset shown in the now-line (agent-ops normalizeDateTime converts
  // to UTC): small models reliably copy an offset but routinely botch the subtract-N-hours,
  // roll-the-date arithmetic that "convert to UTC yourself" requires.
  if (opts.now) {
    system += `\n\nThe current date and time is ${formatNow(opts.now, opts.timezone)}. The weekday \
named there is authoritative — never re-derive the weekday from the date yourself. Resolve relative \
dates ("tonight", "tomorrow", "next Tuesday") against that local time, counting days forward from \
that weekday. Write due_date / defer_date / reminder_at in the user's LOCAL time with the same UTC \
offset shown above (e.g. 2026-07-14T17:00:00+10:00) — do not convert to UTC yourself, and never \
write a datetime without an offset. If a time is ambiguous ("at 5"), pick the next upcoming \
occurrence, preferring daytime/evening over early morning. For a weekly recurrence, the due_date \
must fall on one of its daysOfWeek.`;
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
  // Small local models sometimes re-emit a mutation they already made (the tool result
  // didn't "read" as done to them). Re-running it would duplicate tasks/tags, so exact
  // repeats of a successful mutating call are skipped and told so.
  const succeededMutations = new Set<string>();
  // When the reply must be built deterministically even in conversational mode: the model's
  // final text was a JSON action blob (fallback path), or the provider died mid-loop.
  let usedFallback = false;
  let degraded = false;

  try {
    for (let iter = 0; iter < MAX_ITERS; iter++) {
      let r: Awaited<ReturnType<typeof chatLLM>>;
      try {
        r = await chatLLM(agent, messages, TOOLS, allowPrivate, NL_TUNING);
      } catch (e) {
        // Provider transport error after tools already ran: the work happened, so report
        // it (deterministically) instead of throwing an error that implies nothing did.
        if (!executed.length) throw e;
        console.error('[carbon] nl provider error mid-loop; reporting executed work:', e);
        degraded = true;
        break;
      }
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
      if (!native) usedFallback = true;
      dbg(`iter ${iter}: ${native ? 'native' : 'json-fallback'} calls=${calls.map((c) => c.name).join(',')}`);

      if (native) messages.push({ role: 'assistant', content: r.text, toolCalls: calls });
      for (const tc of calls) {
        const key = `${tc.name} ${JSON.stringify(tc.args)}`;
        if (MUTATING_TOOLS.has(tc.name) && succeededMutations.has(key)) {
          dbg(`  ${tc.name} skipped — duplicate of an earlier successful call`);
          if (native) {
            messages.push({
              role: 'tool',
              toolCallId: tc.id,
              name: tc.name,
              content: JSON.stringify({ error: 'duplicate_call', detail: 'this exact call already succeeded — do not repeat it' }),
            });
          }
          continue;
        }
        const result = await execTool(ops, userId, tc.name, tc.args, anchor, clock);
        dbg(`  ${tc.name} ${JSON.stringify(tc.args)} -> ${result.ok ? 'ok' : 'ERR ' + result.error}`);
        if (result.ok && MUTATING_TOOLS.has(tc.name)) succeededMutations.add(key);
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
  } finally {
    // Record whatever usage accumulated even if a later iteration's chatLLM call threw —
    // otherwise a mid-loop provider error silently drops the earlier successful turns'
    // token accounting (billing/rate-limit undercounts real usage).
    recordAgentUsage(deps.db, agent.id, usage, agent.model || '(default)', opts.requestKind ?? 'nl_command');
  }
  // Conversational surfaces use the model's own final message (the no-tool turn that closes the
  // loop after it has seen the tool results — its narration/answer). The deterministic builder
  // is the fallback if the model ended without saying anything (empty text / hit MAX_ITERS), if
  // its "final message" was really a JSON action blob (fallback path — raw JSON must not reach
  // the chat), or if the provider died mid-loop after work was done.
  const reply =
    opts.conversational && !usedFallback && !degraded
      ? lastText.trim() || buildReply(executed, lastText)
      : buildReply(executed, degraded ? '' : lastText);
  dbg(`reply=${JSON.stringify(reply)} usage in=${usage.input} out=${usage.output}`);
  return { reply, executed, usage };
}

// Re-exported for the route layer to detect the no-agent case without importing agents twice.
export type { Db };
