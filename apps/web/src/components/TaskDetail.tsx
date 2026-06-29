import { useEffect, useRef, useState } from "react";
import {
  X,
  Flag,
  Trash2,
  Check,
  Repeat,
  Eye,
  Play,
  Square,
  Lock,
  Bell,
  Target,
} from "lucide-react";
import {
  getItem,
  getProjects,
  getChildren,
  allItems,
  projectAncestor,
  getItemTags,
  listTags,
  setItemTags,
  createTag,
  updateItem,
  getPredecessors,
  getSuccessors,
  setItemDepLink,
  depWouldCycle,
  isLineage,
  setCompleted,
  deleteItem,
  parseRecurrence,
  getTimeLogs,
  getTimeContext,
  sessionAnchor,
  startTask,
  stopActive,
  listUsers,
  listSharesForItem,
  listAssigneesForItem,
  effectiveShares,
  hasWriteAccess,
  shareItem,
  unshareItem,
  assignItem,
  unassignItem,
  isInPlan,
  addToPlan,
  removeFromPlan,
  taskActualMs,
  projectEstimateMinutes,
  type RecurrenceRule,
  type Permission,
  type OrderMode,
  type Item,
} from "@carbon/core";
import { ColorSwatches } from "./ColorSwatches";
import { GeoEditor } from "./GeoEditor";
import { CalDavSettings } from "./CalDavSettings";
import { getServerConfig } from "@/lib/config";
import { Comments } from "./Comments";
import { Attachments } from "./Attachments";
import { Section } from "./Section";
import { TagMark } from "./TagMark";
import { Markdown } from "./Markdown";
import { itemTagsResolved } from "@/lib/enrich";
import { abbreviateTagPath } from "@/lib/tagLabel";
import { holdCompleted, releaseCompleted } from "@/lib/completion";
import { useQuery } from "@/hooks/useQuery";
import { useTicker } from "@/hooks/useTicker";
import { useFocusItem } from "@/hooks/useFocusItem";
import { mutate } from "@/lib/mutate";
import { useStore } from "@/lib/store";
import {
  toDateInput,
  fromDateInput,
  toDateTimeInput,
  fromDateTimeInput,
  toTimeInput,
  combineDateTime,
  dateInputOffset,
  dateInputShift,
  shiftMinutes,
  formatDuration,
  formatMinutes,
  formatDue,
  logDuration,
} from "@/lib/date";
import { cn } from "@/lib/cn";

const PRIORITIES = [
  { value: 0, label: "None" },
  { value: 1, label: "Low" },
  { value: 2, label: "Medium" },
  { value: 3, label: "High" },
];

const inputCls =
  "w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent";

const chipCls =
  "rounded-lg border border-border px-2 py-1 text-xs text-text-muted hover:bg-surface-2 hover:text-text";

/** Today / Tomorrow / 3 Days / 1 Week quick-set buttons + a date picker for
 *  anything else. `onPick` receives a yyyy-MM-dd string; `onClear` clears the field. */
function DateShortcuts({
  value,
  onPick,
  onClear,
  extras,
}: {
  value: string | null;
  onPick: (dateStr: string) => void;
  onClear: () => void;
  /** Extra chips rendered just after the date picker (e.g. defer "-1 day"). */
  extras?: React.ReactNode;
}) {
  const opts: [string, number][] = [
    ["Today", 0],
    ["Tomorrow", 1],
    ["3 Days", 3],
    ["1 Week", 7],
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {opts.map(([label, n]) => (
        <button
          key={label}
          type="button"
          className={chipCls}
          onClick={() => onPick(dateInputOffset(n))}
        >
          {label}
        </button>
      ))}
      <input
        type="date"
        title="Pick a date"
        className={cn(inputCls, "w-auto")}
        value={toDateInput(value)}
        onChange={(e) => (e.target.value ? onPick(e.target.value) : onClear())}
      />
      {extras}
      {value && (
        <button type="button" className={chipCls} onClick={onClear}>
          Clear
        </button>
      )}
    </div>
  );
}

/** Morning (8:00) / Noon (12:00) / Night (18:00) quick-set buttons + a time picker. */
function TimeShortcuts({
  value,
  onPick,
}: {
  value: string;
  onPick: (time: string) => void;
}) {
  const opts: [string, string][] = [
    ["Morning", "08:00"],
    ["Noon", "12:00"],
    ["Night", "18:00"],
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {opts.map(([label, t]) => (
        <button
          key={t}
          type="button"
          className={cn(chipCls, value === t && "border-accent text-accent")}
          onClick={() => onPick(t)}
        >
          {label}
        </button>
      ))}
      <input
        type="time"
        title="Pick a time (blank = all day)"
        className={cn(inputCls, "w-28")}
        value={value}
        onChange={(e) => onPick(e.target.value)}
      />
    </div>
  );
}

const UNIT: Record<RecurrenceRule["type"], string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
  yearly: "year",
};

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1 block text-xs font-medium text-text-muted">
      {children}
    </span>
  );
}

/** A searchable, type-to-filter task picker (like the tag input, but resolves to
 *  a task id so duplicate titles stay unambiguous). Each pick calls `onAdd`;
 *  multiple picks are supported — the chosen tasks render as pills by the caller. */
function DepPicker({
  candidates,
  placeholder,
  onAdd,
}: {
  candidates: Item[];
  placeholder: string;
  onAdd: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const query = q.trim().toLowerCase();
  const matches = (
    query
      ? candidates.filter((c) => (c.title || "Untitled").toLowerCase().includes(query))
      : candidates
  ).slice(0, 8);

  function add(id: string) {
    onAdd(id);
    setQ("");
    setActive(0);
  }

  return (
    <div className="relative mt-1.5">
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const m = matches[active];
            if (m) add(m.id);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        className={inputCls}
      />
      {open && (matches.length > 0 || query) && (
        <ul className="absolute left-0 top-full z-50 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-border bg-surface py-1 shadow-lg">
          {matches.map((m, i) => (
            <li key={m.id}>
              <button
                type="button"
                // onMouseDown (not click) so it fires before the input blurs.
                onMouseDown={(e) => {
                  e.preventDefault();
                  add(m.id);
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm",
                  i === active ? "bg-accent-soft text-accent" : "hover:bg-surface-2",
                )}
              >
                <span className="flex-1 truncate">{m.title || "Untitled"}</span>
                {m.due_date && (
                  <span className="shrink-0 text-xs text-text-faint">{formatDue(m.due_date)}</span>
                )}
              </button>
            </li>
          ))}
          {matches.length === 0 && (
            <li className="px-3 py-1.5 text-sm text-text-faint">No matching tasks</li>
          )}
        </ul>
      )}
    </div>
  );
}

export function TaskDetail({ id }: { id: string }) {
  const select = useStore((s) => s.select);
  const currentUser = useStore((s) => s.currentUser);
  const focusItem = useFocusItem();
  const data = useQuery(
    (db) => {
      const item = getItem(db, id);
      if (!item || item.deleted) return null;
      const ctx = getTimeContext(db, currentUser?.id ?? null);
      // Dependency edges + the candidate pools for the pickers. A candidate is
      // excluded if it's the task itself, in its vertical lineage, already
      // linked, would create a cycle, or lives in a different project. The
      // cross-project restriction is an arbitrary scope limit for now — deps only
      // make sense within one project's plan.
      const predecessors = getPredecessors(db, id);
      const successors = getSuccessors(db, id);
      const linkedIds = new Set([...predecessors, ...successors].map((i) => i.id));
      const myProjectId = projectAncestor(db, id)?.id ?? null;
      const otherTasks = allItems(db).filter(
        (t) =>
          t.type === "task" &&
          t.id !== id &&
          t.status !== "done" &&
          !linkedIds.has(t.id) &&
          (projectAncestor(db, t.id)?.id ?? null) === myProjectId,
      );
      const blockedByCandidates = otherTasks.filter(
        (t) => !isLineage(db, t.id, id) && !depWouldCycle(db, t.id, id),
      );
      const blocksCandidates = otherTasks.filter(
        (t) => !isLineage(db, id, t.id) && !depWouldCycle(db, id, t.id),
      );
      return {
        item,
        hasChildren: getChildren(db, id).length > 0,
        predecessors,
        successors,
        blockedByCandidates,
        blocksCandidates,
        projects: getProjects(db),
        // The task's project is its nearest project ancestor — for a subtask
        // `parent_id` points at another task, not the project.
        projectId: projectAncestor(db, item.id)?.id ?? null,
        // True when this task is nested under another task (not directly under
        // a project / the inbox root): moving its project re-parents the subtree.
        isSubtask:
          !!item.parent_id && getItem(db, item.parent_id)?.type === "task",
        tags: itemTagsResolved(db, item.id),
        allTags: listTags(db),
        timeLogs: getTimeLogs(db, id),
        trackingHere: ctx.task?.item_id === id && !ctx.paused,
        roster: listUsers(db),
        shares: listSharesForItem(db, id),
        effShares: effectiveShares(db, id),
        assignees: listAssigneesForItem(db, id),
        inPlan: isInPlan(db, currentUser?.id ?? null, id),
        actualMs: taskActualMs(db, id, currentUser?.id ?? null),
        projectEstimate:
          item.type === "project" ? projectEstimateMinutes(db, item.id) : 0,
      };
    },
    [id, currentUser?.id],
  );
  useTicker(1000, !!data?.trackingHere);

  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [editingNote, setEditingNote] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const seededId = useRef<string | null>(null);
  const [tagInput, setTagInput] = useState("");

  useEffect(() => {
    if (!data?.item) return;
    // Re-seed the editable drafts from the (possibly newly-synced) item — but never
    // overwrite a field the user is actively editing, or an inbound remote edit would
    // wipe their unsaved keystrokes (W7). Switching tasks (id change) always reseeds.
    const switching = seededId.current !== id;
    seededId.current = id;
    if (switching || document.activeElement !== titleRef.current)
      setTitle(data.item.title);
    if (
      switching ||
      (!editingNote && document.activeElement !== noteRef.current)
    )
      setNote(data.item.note ?? "");
  }, [id, data?.item.title, data?.item.note, editingNote]);

  // Leave note-edit mode when switching tasks; focus the textarea when entering it.
  useEffect(() => setEditingNote(false), [id]);
  useEffect(() => {
    if (editingNote) noteRef.current?.focus();
  }, [editingNote]);

  if (!data) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-sm text-text-muted">
        <p>Task not found</p>
        <button className="mt-2 text-accent" onClick={() => select(null)}>
          Close
        </button>
      </div>
    );
  }

  const {
    item,
    hasChildren,
    predecessors,
    successors,
    blockedByCandidates,
    blocksCandidates,
    projects,
    projectId,
    tags,
    allTags,
    timeLogs,
    trackingHere,
    roster,
    shares,
    effShares,
    assignees,
    inPlan,
    actualMs,
    projectEstimate,
  } = data;
  const isProject = item.type === "project";
  const rosterById = new Map(roster.map((u) => [u.id, u]));
  const assignedIds = new Set(assignees.map((a) => a.user_id));
  const shareableUsers = roster.filter((u) => u.id !== currentUser?.id);
  const done = item.status === "done";
  const recurrence = parseRecurrence(item.recurrence);
  const totalTime = timeLogs.reduce(
    (sum, l) => sum + logDuration(l.start_time, l.end_time),
    0,
  );

  // Per-user time totals (only users who tracked time).
  const byUser = new Map<string | null, number>();
  for (const l of timeLogs) {
    byUser.set(
      l.user_id,
      (byUser.get(l.user_id) ?? 0) + logDuration(l.start_time, l.end_time),
    );
  }
  const perUser = [...byUser.entries()].filter(([, ms]) => ms > 0);

  function toggleTimer() {
    const uid = currentUser?.id ?? null;
    if (trackingHere) mutate((db, dev) => stopActive(db, dev, uid));
    else mutate((db, dev) => startTask(db, dev, id, uid));
  }

  // Move the item between the three lifecycle states. `done` runs the full
  // completion path (recurrence spawn, session-interrupt prompt, grace-window
  // hold); `active` un-completes; `dropped` abandons without completing — no
  // recurrence, and any stale completed_at is cleared.
  function setStatus(next: Item["status"]) {
    const uid = currentUser?.id ?? null;
    mutate((db, dev) => {
      if (next === "done") {
        setCompleted(db, dev, id, true);
        const ctx = getTimeContext(db, uid);
        if (ctx.session && ctx.session.item_id !== sessionAnchor(db, id)) {
          useStore.getState().setInterrupt({
            project: getItem(db, ctx.session.item_id)?.title || "project",
          });
        }
      } else if (next === "active") {
        setCompleted(db, dev, id, false);
      } else {
        updateItem(db, dev, id, { status: "dropped", completed_at: null });
      }
    });
    if (next === "done") holdCompleted(id);
    else releaseCompleted(id);
  }

  const patch = (p: Parameters<typeof updateItem>[3]) =>
    mutate((db, dev) => updateItem(db, dev, id, p));

  // Dependency edges. "Blocked by X" = edge X -> this; "Blocks Y" = edge this -> Y.
  // Re-check the cycle guard at write time in case the graph changed since render.
  function addBlockedBy(predId: string) {
    if (!predId) return;
    mutate((db, dev) => {
      if (!isLineage(db, predId, id) && !depWouldCycle(db, predId, id))
        setItemDepLink(db, dev, predId, id, false);
    });
  }
  function addBlocks(succId: string) {
    if (!succId) return;
    mutate((db, dev) => {
      if (!isLineage(db, id, succId) && !depWouldCycle(db, id, succId))
        setItemDepLink(db, dev, id, succId, false);
    });
  }
  const removeBlockedBy = (predId: string) =>
    mutate((db, dev) => setItemDepLink(db, dev, predId, id, true));
  const removeBlocks = (succId: string) =>
    mutate((db, dev) => setItemDepLink(db, dev, id, succId, true));

  function commitTitle() {
    if (title.trim() !== item.title) patch({ title: title.trim() });
  }
  function commitNote() {
    const v = note.trim() ? note : null;
    if (v !== item.note) patch({ note: v });
  }

  function addTag(name: string) {
    const clean = name.trim();
    if (!clean) return;
    mutate((db, dev) => {
      const tag = createTag(db, dev, clean);
      const current = getItemTags(db, id).map((t) => t.id);
      if (!current.includes(tag.id))
        setItemTags(db, dev, id, [...current, tag.id]);
    });
    setTagInput("");
  }
  function removeTag(tagId: string) {
    mutate((db, dev) =>
      setItemTags(
        db,
        dev,
        id,
        getItemTags(db, id)
          .map((t) => t.id)
          .filter((x) => x !== tagId),
      ),
    );
  }

  function setRecurrence(next: RecurrenceRule | null) {
    patch({ recurrence: next ? JSON.stringify(next) : null });
  }

  function remove() {
    if (!window.confirm("Delete this item and its sub-tasks?")) return;
    mutate((db, dev) => deleteItem(db, dev, id));
    select(null);
  }

  function togglePlan() {
    const uid = currentUser?.id ?? null;
    mutate((db, dev) =>
      isInPlan(db, uid, id)
        ? removeFromPlan(db, dev, uid, id)
        : addToPlan(db, dev, uid, id),
    );
  }


  function toggleAssignee(userId: string) {
    mutate((db, dev) => {
      if (assignedIds.has(userId)) {
        unassignItem(db, dev, id, userId);
      } else {
        assignItem(db, dev, id, userId);
        // Assigning grants edit access if the user doesn't already have it.
        if (!hasWriteAccess(db, id, userId))
          shareItem(db, dev, id, userId, "write");
      }
    });
  }
  function setShare(userId: string, perm: Permission | "off") {
    mutate((db, dev) =>
      perm === "off"
        ? unshareItem(db, dev, id, userId)
        : shareItem(db, dev, id, userId, perm),
    );
  }

  // --- collapsed-section summaries ---
  const scheduleSummary = item.due_date
    ? `Due ${formatDue(item.due_date)}`
    : item.defer_date
      ? `Deferred`
      : "No dates";
  const sharingSummary =
    [
      assignees.length ? `${assignees.length} assigned` : "",
      effShares.length ? `${effShares.length} shared` : "",
    ]
      .filter(Boolean)
      .join(" · ") || "Private";
  const timeSummary = totalTime > 0 ? formatDuration(totalTime) : "None";

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-1 border-b border-border px-3 py-2">
        <button
          onClick={() => select(null)}
          className="rounded-lg p-2 text-text-muted hover:bg-surface-2 hover:text-text"
          aria-label="Close"
        >
          <X size={18} />
        </button>
        <span className="text-xs uppercase tracking-wide text-text-faint">
          {item.type === "project" ? "Project" : "Task"}
        </span>
        <div className="flex-1" />
        {item.type !== "project" && (
          <button
            onClick={togglePlan}
            className={cn(
              "rounded-lg p-2 hover:bg-surface-2",
              inPlan ? "text-accent" : "text-text-muted hover:text-text",
            )}
            aria-label={inPlan ? "Remove from Plan" : "Add to Plan"}
            title={inPlan ? "In Plan" : "Add to Plan"}
          >
            <Target size={17} />
          </button>
        )}
        <button
          onClick={() => focusItem(item)}
          className="rounded-lg p-2 text-text-muted hover:bg-surface-2 hover:text-text"
          aria-label="Focus"
          title="Focus on this task"
        >
          <Eye size={17} />
        </button>
        <button
          onClick={() => patch({ flagged: !item.flagged })}
          className={cn(
            "rounded-lg p-2 hover:bg-surface-2",
            item.flagged ? "text-warning" : "text-text-muted hover:text-text",
          )}
          aria-label="Flag"
        >
          <Flag size={17} fill={item.flagged ? "currentColor" : "none"} />
        </button>
        <button
          onClick={remove}
          className="rounded-lg p-2 text-text-muted hover:bg-surface-2 hover:text-danger"
          aria-label="Delete"
        >
          <Trash2 size={17} />
        </button>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {/* Always-visible essentials */}
        <div className="flex items-start gap-2.5">
          <button
            onClick={() => setStatus(done ? "active" : "done")}
            className={cn(
              "mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
              done
                ? "border-accent bg-accent text-accent-fg"
                : "border-border-strong text-transparent hover:border-accent",
            )}
            aria-label={done ? "Mark incomplete" : "Mark complete"}
          >
            <Check size={13} strokeWidth={3} />
          </button>
          <div className="flex-1">
            <textarea
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitTitle();
                  e.currentTarget.blur();
                }
              }}
              rows={1}
              placeholder="Title"
              className={cn(
                "w-full resize-none bg-transparent text-lg font-semibold outline-none",
                done && "text-text-faint line-through",
              )}
            />
            {/* Lifecycle status — three-state segmented pill directly under the
                title. The complete-checkbox (left) toggles active↔done; this also
                exposes "dropped". */}
            <div className="mt-1 inline-flex overflow-hidden rounded-full border border-border text-xs">
              {(
                [
                  ["active", "Active", "bg-accent text-accent-fg"],
                  ["done", "Done", "bg-success text-white"],
                  ["dropped", "Dropped", "bg-surface-2 text-text-muted line-through"],
                ] as [Item["status"], string, string][]
              ).map(([s, label, selCls], i) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(s)}
                  aria-pressed={item.status === s}
                  className={cn(
                    "px-3 py-1 font-medium transition-colors",
                    i > 0 && "border-l border-border",
                    item.status === s
                      ? selCls
                      : "text-text-muted hover:bg-surface-2 hover:text-text",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div>
          <Label>Notes</Label>
          {editingNote || !note.trim() ? (
            <textarea
              ref={noteRef}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onBlur={() => {
                commitNote();
                setEditingNote(false);
              }}
              rows={4}
              placeholder="Add notes…  (Markdown supported)"
              className={cn(inputCls, "resize-y")}
            />
          ) : (
            <div
              onClick={() => setEditingNote(true)}
              title="Click to edit"
              className="cursor-text rounded-lg border border-transparent px-3 py-2 hover:border-border"
            >
              <Markdown>{note}</Markdown>
            </div>
          )}
        </div>

        {/* Projects: review cadence (defaults to 30 days) and folder colour, kept
            front-and-centre directly under the notes. */}
        {isProject && (
          <>
            <div>
              <Label>Review every (days)</Label>
              <input
                type="number"
                min={0}
                className={cn(inputCls, "w-32")}
                value={item.review_interval ?? ""}
                placeholder="30"
                onChange={(e) =>
                  patch({
                    review_interval: e.target.value
                      ? Number(e.target.value)
                      : null,
                  })
                }
              />
            </div>
            <div>
              <Label>Colour</Label>
              <ColorSwatches
                value={item.color}
                onChange={(c) => patch({ color: c })}
              />
            </div>
            {/* CalDAV two-way sync is server-side and holds secrets, so it's
                admin-only and hidden in local-only/offline mode (no server). */}
            {currentUser?.role === "admin" && !!getServerConfig().url && (
              <div>
                <Label>Calendar sync</Label>
                <CalDavSettings projectId={id} />
              </div>
            )}
          </>
        )}

        {!isProject && (
          <Attachments parentType="item" parentId={id} itemId={id} />
        )}

        {!isProject && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Priority</Label>
              <select
                className={inputCls}
                value={item.priority}
                onChange={(e) => patch({ priority: Number(e.target.value) })}
              >
                {PRIORITIES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>Project</Label>
              <select
                className={inputCls}
                value={projectId ?? ""}
                onChange={(e) => patch({ parent_id: e.target.value || null })}
              >
                <option value="">Inbox (no project)</option>
                {projects
                  .filter((p) => p.id !== id)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title || "Untitled project"}
                    </option>
                  ))}
              </select>
            </div>
          </div>
        )}

        {!isProject && (
          <div>
            <Label>Tags</Label>
            <div className="flex flex-wrap items-center gap-1.5">
              {tags.map((t) => (
                <span
                  key={t.id}
                  title={t.name}
                  className="flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs"
                >
                  <TagMark color={t.color} />
                  {abbreviateTagPath(t.name)}
                  <button
                    onClick={() => removeTag(t.id)}
                    aria-label={`Remove ${t.name}`}
                  >
                    <X
                      size={12}
                      className="text-text-faint hover:text-danger"
                    />
                  </button>
                </span>
              ))}
              <input
                list="all-tags"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTag(tagInput);
                  }
                }}
                placeholder="Add tag…"
                className="min-w-[6rem] flex-1 bg-transparent py-0.5 text-xs outline-none placeholder:text-text-faint"
              />
              <datalist id="all-tags">
                {allTags.map((t) => (
                  <option key={t.id} value={t.name} />
                ))}
              </datalist>
            </div>
          </div>
        )}

        {/* Order mode — how this container sequences its children. Only meaningful
            once there are children (projects always have the role). */}
        {(isProject || hasChildren) && (
          <div>
            <Label>Order</Label>
            <div className="flex overflow-hidden rounded-lg border border-border text-xs">
              {(
                [
                  ["parallel", "Parallel"],
                  ["sequential", "Sequential"],
                  ["single", "Single action"],
                ] as [OrderMode, string][]
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => patch({ order_mode: mode })}
                  className={cn(
                    "flex-1 px-2 py-1.5 font-medium",
                    item.order_mode === mode
                      ? "bg-accent-soft text-accent"
                      : "text-text-muted hover:bg-surface-2",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {item.order_mode === "sequential" && (
              <p className="mt-1 text-xs text-text-faint">
                Only the first incomplete child is available; later ones stay blocked
                until earlier ones are done.
              </p>
            )}
          </div>
        )}

        {/* Scheduling */}
        <Section title="Scheduling" summary={scheduleSummary} defaultOpen>
          <div className="space-y-3">
            <div>
              <Label>Due</Label>
              <DateShortcuts
                value={item.due_date}
                onPick={(d) =>
                  patch({
                    due_date: combineDateTime(d, toTimeInput(item.due_date)),
                  })
                }
                onClear={() => patch({ due_date: null })}
              />
              {item.due_date && (
                <div className="mt-2">
                  <TimeShortcuts
                    value={toTimeInput(item.due_date)}
                    onPick={(t) =>
                      patch({
                        due_date: combineDateTime(
                          toDateInput(item.due_date),
                          t,
                        ),
                      })
                    }
                  />
                </div>
              )}
            </div>
            <div>
              <Label>Defer until</Label>
              {(() => {
                // Subtract relative to the deferred date, or the due date when no
                // defer is set yet. Unavailable when neither exists.
                const base = item.defer_date ?? item.due_date;
                return (
                  <DateShortcuts
                    value={item.defer_date}
                    onPick={(d) => patch({ defer_date: fromDateInput(d) })}
                    onClear={() => patch({ defer_date: null })}
                    extras={
                      base
                        ? (
                            [
                              ["-1 day", 1],
                              ["-1 week", 7],
                            ] as [string, number][]
                          ).map(([label, n]) => (
                            <button
                              key={label}
                              type="button"
                              className={chipCls}
                              onClick={() =>
                                patch({
                                  defer_date: fromDateInput(
                                    dateInputShift(base, -n),
                                  ),
                                })
                              }
                            >
                              {label}
                            </button>
                          ))
                        : null
                    }
                  />
                );
              })()}
            </div>
          </div>
          {item.due_date && (
            <div>
              <Label>
                <span className="inline-flex items-center gap-1">
                  <Bell size={12} /> Reminder (push to all devices)
                </span>
              </Label>
              <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                {(
                  [
                    ["Due Time", 0],
                    ["15min Before", 15],
                    ["1 Hour Before", 60],
                    ["1 Day Before", 1440],
                  ] as [string, number][]
                ).map(([label, mins]) => (
                  <button
                    key={label}
                    type="button"
                    className={chipCls}
                    onClick={() =>
                      patch({ reminder_at: shiftMinutes(item.due_date, -mins) })
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
              <input
                type="datetime-local"
                className={inputCls}
                value={toDateTimeInput(item.reminder_at)}
                onChange={(e) =>
                  patch({ reminder_at: fromDateTimeInput(e.target.value) })
                }
              />
            </div>
          )}
          {!isProject && (
            <div>
              <Label>
                <span className="inline-flex items-center gap-1">
                  <Repeat size={12} /> Repeat
                </span>
              </Label>
              <div className="flex gap-2">
                <select
                  className={inputCls}
                  value={
                    !recurrence
                      ? ""
                      : recurrence.type === "monthly" &&
                          recurrence.interval === 3
                        ? "q"
                        : recurrence.type === "monthly" &&
                            recurrence.interval === 6
                          ? "h"
                          : recurrence.type
                  }
                  onChange={(e) => {
                    const v = e.target.value;
                    if (!v) return setRecurrence(null);
                    const from =
                      recurrence?.from ??
                      (recurrence?.fromCompletion ? "completed" : undefined);
                    const dayOfMonth = recurrence?.dayOfMonth;
                    // Presets map onto monthly with a 3- / 6-month interval.
                    if (v === "q" || v === "h") {
                      return setRecurrence({
                        type: "monthly",
                        interval: v === "q" ? 3 : 6,
                        dayOfMonth,
                        from,
                      });
                    }
                    setRecurrence({
                      type: v as RecurrenceRule["type"],
                      interval: recurrence?.interval ?? 1,
                      from,
                    });
                  }}
                >
                  <option value="">Never</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="q">Every 3 months</option>
                  <option value="h">Every 6 months</option>
                  <option value="yearly">Yearly</option>
                </select>
                {recurrence && (
                  <label className="flex items-center gap-1 text-xs text-text-faint">
                    every
                    <input
                      type="number"
                      min={1}
                      className={cn(inputCls, "w-16")}
                      value={recurrence.interval}
                      title="Interval"
                      onChange={(e) =>
                        setRecurrence({
                          ...recurrence,
                          interval: Math.max(1, Number(e.target.value)),
                        })
                      }
                    />
                    {UNIT[recurrence.type]}
                    {recurrence.interval > 1 ? "s" : ""}
                  </label>
                )}
              </div>
              {recurrence?.type === "weekly" && (
                <div className="mt-2 flex gap-1">
                  {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => {
                    const on = recurrence.daysOfWeek?.includes(i) ?? false;
                    return (
                      <button
                        key={i}
                        type="button"
                        title={
                          ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][i]
                        }
                        onClick={() => {
                          const set = new Set(recurrence.daysOfWeek ?? []);
                          on ? set.delete(i) : set.add(i);
                          const arr = [...set].sort((a, b) => a - b);
                          setRecurrence({
                            ...recurrence,
                            daysOfWeek: arr.length ? arr : undefined,
                          });
                        }}
                        className={cn(
                          "h-7 w-7 rounded-full border text-xs font-medium",
                          on
                            ? "border-accent bg-accent text-accent-fg"
                            : "border-border text-text-muted hover:bg-surface-2",
                        )}
                      >
                        {d}
                      </button>
                    );
                  })}
                </div>
              )}
              {recurrence?.type === "monthly" && (
                <label className="mt-2 flex items-center gap-2 text-sm text-text-muted">
                  On day
                  <input
                    type="number"
                    min={1}
                    max={31}
                    className={cn(inputCls, "w-20")}
                    value={recurrence.dayOfMonth ?? ""}
                    placeholder="due"
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setRecurrence({
                        ...recurrence,
                        dayOfMonth: v >= 1 && v <= 31 ? v : undefined,
                      });
                    }}
                  />
                  <span className="text-xs text-text-faint">
                    of the month (blank = same day as the due date)
                  </span>
                </label>
              )}
              {recurrence && (
                <div className="mt-2">
                  <Label>Repeat based on</Label>
                  <select
                    className={inputCls}
                    value={
                      recurrence.from ??
                      (recurrence.fromCompletion ? "completed" : "scheduled")
                    }
                    onChange={(e) =>
                      setRecurrence({
                        ...recurrence,
                        from: e.target.value as RecurrenceRule["from"],
                        fromCompletion: undefined,
                      })
                    }
                  >
                    <option value="scheduled">Scheduled date and time</option>
                    <option value="completed-keep-time">
                      Completed date, keep time
                    </option>
                    <option value="completed">Completed date and time</option>
                  </select>
                </div>
              )}
            </div>
          )}
          <GeoEditor
            value={item.geo}
            resetKey={id}
            onChange={(geo) => patch({ geo })}
          />
        </Section>

        {/* Dependencies — explicit predecessor/successor links (Gantt-style). */}
        {!isProject && (
          <Section
            title="Dependencies"
            summary={
              predecessors.length || successors.length
                ? `${predecessors.length} blocking · ${successors.length} blocked`
                : "None"
            }
          >
            <div className="space-y-3">
              <div>
                <Label>Blocked by (prerequisites)</Label>
                <div className="flex flex-wrap items-center gap-1.5">
                  {predecessors.map((p) => (
                    <span
                      key={p.id}
                      title={p.title}
                      className="flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs"
                    >
                      {p.status === "done" ? (
                        <Check size={11} className="text-success" />
                      ) : (
                        <Lock size={11} className="text-text-faint" />
                      )}
                      <span className="max-w-[10rem] truncate">{p.title || "Untitled"}</span>
                      <button onClick={() => removeBlockedBy(p.id)} aria-label={`Remove ${p.title}`}>
                        <X size={12} className="text-text-faint hover:text-danger" />
                      </button>
                    </span>
                  ))}
                </div>
                <DepPicker
                  candidates={blockedByCandidates}
                  placeholder="Search tasks to add as prerequisite…"
                  onAdd={addBlockedBy}
                />
              </div>
              <div>
                <Label>Blocks</Label>
                <div className="flex flex-wrap items-center gap-1.5">
                  {successors.map((s) => (
                    <span
                      key={s.id}
                      title={s.title}
                      className="flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs"
                    >
                      <span className="max-w-[10rem] truncate">{s.title || "Untitled"}</span>
                      <button onClick={() => removeBlocks(s.id)} aria-label={`Remove ${s.title}`}>
                        <X size={12} className="text-text-faint hover:text-danger" />
                      </button>
                    </span>
                  ))}
                </div>
                <DepPicker
                  candidates={blocksCandidates}
                  placeholder="Search tasks this blocks…"
                  onAdd={addBlocks}
                />
              </div>
            </div>
          </Section>
        )}

        {/* Sharing */}
        {roster.length > 0 && (
          <Section title="Sharing" summary={sharingSummary}>
            <div>
              <Label>Assigned to</Label>
              <div className="flex flex-wrap gap-1.5">
                {roster.map((u) => (
                  <button
                    key={u.id}
                    onClick={() => toggleAssignee(u.id)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs",
                      assignedIds.has(u.id)
                        ? "border-accent bg-accent-soft text-accent"
                        : "border-border text-text-muted hover:bg-surface-2",
                    )}
                  >
                    <span
                      className="flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-semibold text-white"
                      style={{ background: u.avatar_color || "var(--accent)" }}
                    >
                      {(u.display_name || u.username).charAt(0).toUpperCase()}
                    </span>
                    {u.display_name || u.username}
                  </button>
                ))}
              </div>
            </div>

            {shareableUsers.length > 0 && (
              <div>
                <Label>Shared with</Label>
                <div className="space-y-1.5">
                  {shareableUsers.map((u) => {
                    const direct = shares.find((s) => s.user_id === u.id);
                    const eff = effShares.find((e) => e.user_id === u.id);
                    const inherited = !!eff && eff.inherited && !direct;
                    return (
                      <div
                        key={u.id}
                        className="flex items-center gap-2 text-sm"
                      >
                        <span
                          className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold text-white"
                          style={{
                            background: u.avatar_color || "var(--accent)",
                          }}
                        >
                          {(u.display_name || u.username)
                            .charAt(0)
                            .toUpperCase()}
                        </span>
                        <span className="flex-1 truncate">
                          {u.display_name || u.username}
                        </span>
                        {inherited ? (
                          <span className="flex items-center gap-1 rounded-lg bg-surface-2 px-2 py-1 text-xs text-text-muted">
                            <Lock size={11} />
                            {eff!.permission === "write"
                              ? "Can edit"
                              : "Can view"}{" "}
                            · inherited
                          </span>
                        ) : (
                          <select
                            value={direct ? direct.permission : "off"}
                            onChange={(e) =>
                              setShare(
                                u.id,
                                e.target.value as Permission | "off",
                              )
                            }
                            className="rounded-lg border border-border bg-surface px-2 py-1 text-xs outline-none"
                          >
                            <option value="off">No access</option>
                            <option value="read">Can view</option>
                            <option value="write">Can edit</option>
                          </select>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </Section>
        )}

        {/* Time tracking */}
        <Section title="Time tracking" summary={timeSummary}>
          <div>
            <Label>Estimate</Label>
            {isProject ? (
              <p className="text-sm text-text-muted">
                {projectEstimate > 0 ? formatMinutes(projectEstimate) : "—"}
                <span className="ml-1 text-xs text-text-faint">
                  (sum of all tasks)
                </span>
              </p>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    step={5}
                    className={cn(inputCls, "w-32")}
                    placeholder="—"
                    value={item.estimate_minutes ?? ""}
                    onChange={(e) =>
                      patch({
                        estimate_minutes:
                          e.target.value === ""
                            ? null
                            : Math.max(0, Math.round(Number(e.target.value))),
                      })
                    }
                  />
                  <span className="text-xs text-text-faint">
                    minutes
                    {item.estimate_minutes
                      ? ` · ${formatMinutes(item.estimate_minutes)}`
                      : ""}
                  </span>
                </div>
                {actualMs > 0 && (
                  <p className="mt-1 text-xs text-text-muted">
                    {/* Estimate-vs-actual comparison parked — see
                        docs/estimate-vs-actual.md. Show tracked time only. */}
                    Tracked{" "}
                    <span className="font-medium text-text">
                      {formatMinutes(actualMs / 60000)}
                    </span>{" "}
                    so far
                  </p>
                )}
              </>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={toggleTimer}
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-white",
                trackingHere
                  ? "bg-danger hover:opacity-90"
                  : "bg-accent hover:bg-accent-hover",
              )}
            >
              {trackingHere ? (
                <>
                  <Square size={12} fill="currentColor" /> Stop
                </>
              ) : (
                <>
                  <Play size={12} fill="currentColor" /> Track this task
                </>
              )}
            </button>
            {totalTime > 0 && (
              <span className="text-sm tabular-nums text-text-muted">
                {formatDuration(totalTime)} total
              </span>
            )}
          </div>
          {perUser.length > 0 && (
            <ul className="space-y-1">
              {perUser.map(([uid, ms]) => {
                const u = uid ? rosterById.get(uid) : undefined;
                const name =
                  u?.display_name || u?.username || (uid ? "Unknown" : "You");
                return (
                  <li
                    key={uid ?? "none"}
                    className="flex items-center justify-between text-xs"
                  >
                    <span className="flex items-center gap-1.5 text-text-muted">
                      <span
                        className="flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-semibold text-white"
                        style={{
                          background: u?.avatar_color || "var(--text-faint)",
                        }}
                      >
                        {name.charAt(0).toUpperCase()}
                      </span>
                      {name}
                    </span>
                    <span className="tabular-nums text-text-muted">
                      {formatDuration(ms)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        {!isProject && <Comments itemId={id} />}
      </div>
    </div>
  );
}
