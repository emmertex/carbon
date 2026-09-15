import { useState, useEffect, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Check, CircleCheck, ExternalLink, X } from "lucide-react";
import {
  getProjects,
  needsReview,
  markReviewed,
  updateItem,
  readReviewEntries,
  writeReviewEntry,
  startReview,
  hasReviewProgress,
  reviewChanges,
  reviewItems,
  type Item,
} from "@carbon/core";
import { useQuery } from "@/hooks/useQuery";
import { flushPersist } from "@/lib/db";
import { completeTask } from "@/lib/taskActions";
import { mutate } from "@/lib/mutate";
import { useStore } from "@/lib/store";
import { identityKey } from "@/lib/identity";
import { fromDateInput } from "@/lib/date";
import { readReviewProgress, reviewProgressKey } from "@/lib/review-progress";
import { enrichItems } from "@/lib/enrich";
import { createFromQuickAdd } from "@/lib/quickadd";
import { TaskRow } from "@/components/TaskRow";
import { QuickAdd } from "@/components/QuickAdd";
import { Markdown } from "@/components/Markdown";
import { ProjectGlyph } from "@/components/ProjectGlyph";
import { cn } from "@/lib/cn";

const button =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50";
const questions = [
  ["tasksRelevant", "Are these tasks still relevant?"],
  ["newTasksNeeded", "Is anything missing?"],
  ["completeOrDrop", "Is anything ready to complete or drop?"],
  ["statusCorrect", "Does the project status still fit?"],
  ["nextActionIdentified", "Is the next action clear?"],
];

export function ReviewView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selected = searchParams.get("project");
  const user = useStore((s) => s.currentUser?.id ?? "local");
  const projects = useQuery(
    (db) =>
      getProjects(db)
        .filter((p) => needsReview(p) || p.id === selected)
        .map((project) => {
          const entries = readReviewEntries(db, user, project);
          const tasks = reviewItems(db, project).filter(
            (item) => item.type === "task" && item.status === "active",
          );
          return {
            project,
            started: hasReviewProgress(entries),
            total: tasks.length,
            reviewed: tasks.filter(
              (task) => entries[`task:${task.id}`]?.checked === true,
            ).length,
          };
        }),
    [user, selected],
  );
  const [completed, setCompleted] = useState(0);
  const current =
    projects?.find(({ project }) => project.id === selected) ?? projects?.[0];
  function choose(id: string) {
    setSearchParams({ project: id }, { replace: true });
    useStore.getState().select(null);
  }
  return (
    <div className="@container mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <header className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">Review</h1>
        <p className="mt-1 text-sm text-text-muted">
          A little space to check your projects and decide what comes next.
        </p>
      </header>
      {!projects ? (
        <p className="text-sm text-text-muted">Loading projects…</p>
      ) : !current ? (
        <div className="border-t border-border py-12 text-center">
          <CircleCheck className="mx-auto mb-3 text-accent" size={28} />
          <h2 className="font-semibold">
            {completed ? "Review complete" : "You’re up to date"}
          </h2>
          <p className="mt-1 text-sm text-text-muted">
            Nothing to review right now.
          </p>
        </div>
      ) : (
        <div className="grid items-start gap-6 @min-[800px]:grid-cols-[180px_minmax(0,1fr)]">
          <nav
            aria-label="Projects to review"
            className="hidden space-y-1 @min-[800px]:block"
          >
            <p className="mb-2 px-2 text-xs font-medium text-text-muted">
              Projects to review · {projects.length}
            </p>
            {projects.map(({ project, started, total, reviewed }) => (
              <button
                key={project.id}
                aria-current={
                  project.id === current.project.id ? "page" : undefined
                }
                onClick={() => choose(project.id)}
                className={cn(
                  "w-full rounded-md px-2 py-2 text-left hover:bg-surface-2",
                  project.id === current.project.id && "bg-accent-soft",
                )}
              >
                <span className="flex items-center gap-2">
                  <ProjectGlyph
                    mode={project.order_mode}
                    color={project.color}
                    size={15}
                  />
                  <span className="truncate text-sm font-medium">
                    {project.title || "Untitled project"}
                  </span>
                </span>
                <span className="mt-1 block text-xs text-text-muted">
                  {started ? "In progress" : "Not started"} · {reviewed}/{total}{" "}
                  reviewed
                </span>
                <span className="mt-2 block h-1 overflow-hidden rounded bg-surface-3">
                  <span
                    className="block h-full bg-accent"
                    style={{
                      width: `${total ? (reviewed / total) * 100 : 0}%`,
                    }}
                  />
                </span>
              </button>
            ))}
          </nav>
          <div className="min-w-0">
            <label className="mb-4 block text-xs text-text-muted @min-[800px]:hidden">
              Project to review
              <select
                aria-label="Project to review"
                value={current.project.id}
                onChange={(e) => choose(e.target.value)}
                className="mt-1 block w-full rounded-md border border-border bg-surface px-2 py-2 text-sm text-text"
              >
                {projects.map(({ project, started }) => (
                  <option key={project.id} value={project.id}>
                    {project.title || "Untitled project"}
                    {started ? " · In progress" : ""}
                  </option>
                ))}
              </select>
            </label>
            <ProjectReview
              key={`${user}:${current.project.id}:${current.project.reviewed_at}`}
              project={current.project}
              onFinishing={() => setSearchParams({}, { replace: true })}
              onReviewed={() => {
                setCompleted((n) => n + 1);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectReview({
  project,
  onReviewed,
  onFinishing,
}: {
  project: Item;
  onReviewed: () => void;
  onFinishing: () => void;
}) {
  const key = reviewProgressKey(
    identityKey(),
    project.id,
    project.reviewed_at ?? project.created_at,
  );
  const user = useStore((s) => s.currentUser?.id ?? "local");
  const savedEntries = useQuery(
    (db) => readReviewEntries(db, user, project),
    [user, project.id],
  );
  const reviewEntries = savedEntries ?? {};
  const progress = {
    checklist: Object.fromEntries(
      Object.entries(reviewEntries)
        .filter(([key]) => key.startsWith("check:"))
        .map(([key, value]) => [key.slice(6), value.checked === true]),
    ),
    reviewedTaskIds: Object.entries(reviewEntries)
      .filter(
        ([key, value]) => key.startsWith("task:") && value.checked === true,
      )
      .map(([key]) => key.slice(5)),
  };
  const [saveError, setSaveError] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveSequence = useRef(0);
  const migrating = useRef(false);
  function persistProgress() {
    const sequence = ++saveSequence.current;
    setSaving(true);
    return flushPersist().then(
      () => {
        if (sequence === saveSequence.current) {
          setSaving(false);
          setSaveError(false);
        }
      },
      (error) => {
        setSaving(false);
        setSaveError(true);
        throw error;
      },
    );
  }
  const [showSummary, setShowSummary] = useState(false);
  useEffect(() => {
    if (savedEntries === null || migrating.current) return;
    try {
      // Move the old device-local checkmarks into independent synced entries once.
      const legacy = readReviewProgress(localStorage, key);
      const hasLegacy =
        Object.keys(legacy.checklist).length > 0 ||
        legacy.reviewedTaskIds.length > 0;
      if (!savedEntries.started || hasLegacy) {
        migrating.current = true;
        mutate((db, dev) => {
          startReview(db, dev, user, project);
          for (const [id, checked] of Object.entries(legacy.checklist))
            if (!savedEntries[`check:${id}`])
              writeReviewEntry(db, dev, user, project, `check:${id}`, {
                checked,
              });
          for (const id of legacy.reviewedTaskIds)
            if (!savedEntries[`task:${id}`])
              writeReviewEntry(db, dev, user, project, `task:${id}`, {
                checked: true,
              });
        });
        void persistProgress()
          .then(() => {
            if (hasLegacy) localStorage.removeItem(key);
          })
          .catch(() => setSaveError(true))
          .finally(() => {
            migrating.current = false;
          });
      }
    } catch {
      migrating.current = false;
      setSaveError(true);
    }
  }, [key, user, project, savedEntries]);
  const changes = useQuery(
    (db) => reviewChanges(db, project, readReviewEntries(db, user, project)),
    [user, project.id],
  );
  function saveEntry(entryKey: string, value: Record<string, unknown>) {
    try {
      mutate((db, dev) =>
        writeReviewEntry(db, dev, user, project, entryKey, value),
      );
      void persistProgress().catch(() => {});
    } catch {
      setSaveError(true);
    }
  }
  const [onlyUnreviewed, setOnlyUnreviewed] = useState(false);
  const [editor, setEditor] = useState<{
    task: Item;
    kind: "subtask" | "defer";
  } | null>(null);
  const [deferDate, setDeferDate] = useState("");
  const tasks = useQuery(
    (db) => {
      const items = reviewItems(db, project);
      const children = new Map<string, Item[]>();
      for (const item of items) {
        if (!item.parent_id) continue;
        const siblings = children.get(item.parent_id) ?? [];
        siblings.push(item);
        children.set(item.parent_id, siblings);
      }
      const ordered: { item: Item; depth: number }[] = [];
      const seen = new Set<string>();
      function visit(parent: string, depth: number) {
        if (seen.has(parent)) return;
        seen.add(parent);
        for (const item of children.get(parent) ?? []) {
          if (item.type === "task" && item.status === "active")
            ordered.push({ item, depth });
          visit(item.id, depth + 1);
        }
      }
      visit(project.id, 0);
      return enrichItems(
        db,
        ordered.map(({ item }) => item),
      ).map((data, index) => ({ data, depth: ordered[index]!.depth }));
    },
    [project.id],
  );
  const total = tasks?.length ?? 0;
  const reviewedCount =
    tasks?.filter(({ data }) => progress.reviewedTaskIds.includes(data.item.id))
      .length ?? 0;
  const remaining = total - reviewedCount;
  const noTasks = tasks !== null && total === 0;
  const summaryReady =
    !!reviewEntries.started &&
    Object.keys(reviewEntries).filter((key) => key.startsWith("baseline:"))
      .length >= Number(reviewEntries.started.baselineCount ?? 0);
  const canFinish =
    tasks !== null &&
    (!noTasks || progress.checklist.noTasks) &&
    summaryReady &&
    !saving &&
    !saveError;
  function openTask(task: Item) {
    useStore.getState().select(task.id);
    useStore.getState().openDetail();
    saveEntry("cursor", { taskId: task.id });
  }
  function create(raw: string, parentId: string) {
    mutate((db, dev) =>
      createFromQuickAdd(db, dev, raw, {
        parentId,
        ownerId: user === "local" ? null : user,
        type: "task",
      }),
    );
    void persistProgress().catch(() => {});
    setEditor(null);
  }
  const visible =
    tasks?.filter(
      ({ data }) =>
        !onlyUnreviewed || !progress.reviewedTaskIds.includes(data.item.id),
    ) ?? [];
  return (
    <section aria-label="Project review">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <ProjectGlyph
              mode={project.order_mode}
              color={project.color}
              size={19}
            />
            <button
              className="truncate text-left hover:text-accent"
              onClick={() => openTask(project)}
            >
              {project.title || "Untitled project"}
            </button>
          </h2>
          <p className="mt-1 text-xs text-text-muted">
            {reviewedCount} of {total} open tasks reviewed{" "}
            <span aria-hidden="true">·</span>{" "}
            <span role="status">
              {saving ? "Saving…" : saveError ? "Not saved" : "Saved"}
            </span>
          </p>
        </div>
        <button
          className={cn(
            button,
            "bg-accent text-accent-fg hover:bg-accent-hover",
          )}
          onClick={() => setShowSummary(!showSummary)}
          aria-expanded={showSummary}
        >
          Finish review
        </button>
      </div>
      {saveError && (
        <p role="alert" className="mt-3 text-sm text-red-500">
          Progress could not be saved.{" "}
          <button
            className="underline"
            onClick={() => void persistProgress().catch(() => {})}
          >
            Retry save
          </button>
        </p>
      )}
      {project.note && (
        <Markdown className="my-3 text-sm text-text-muted">
          {project.note}
        </Markdown>
      )}
      {showSummary && (
        <section
          aria-label="Review summary"
          className="my-4 rounded-lg border border-border bg-surface p-4"
        >
          <div className="flex justify-between gap-2">
            <h3 className="text-sm font-semibold">Ready to finish?</h3>
            <button
              aria-label="Close summary"
              onClick={() => setShowSummary(false)}
              className="text-text-muted hover:text-text"
            >
              <X size={16} />
            </button>
          </div>
          <p className="mt-2 text-sm text-text-muted">
            {remaining
              ? `${remaining} open ${remaining === 1 ? "task is" : "tasks are"} not marked reviewed. You can keep reviewing or finish now.`
              : "All open tasks have been reviewed."}
          </p>
          {!summaryReady ? (
            <p className="mt-2 text-sm text-text-muted">
              Loading review summary…
            </p>
          ) : changes?.length ? (
            <ul className="my-3 max-h-48 space-y-2 overflow-y-auto">
              {changes.map((change) => (
                <li key={change.id} className="text-sm">
                  <span className="font-medium">
                    {change.title || "Untitled task"}
                  </span>
                  <span className="block text-xs text-text-muted">
                    {change.changes.join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="my-3 text-xs text-text-muted">
              No task or project changes during this review.
            </p>
          )}
          <p className="mb-3 text-xs text-text-muted">
            Changes are already saved. Finishing starts the next review
            interval.
          </p>
          {noTasks && !progress.checklist.noTasks && (
            <p className="mb-3 text-xs text-text-muted">
              Confirm below that there are no tasks before finishing.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button className={button} onClick={() => setShowSummary(false)}>
              Keep reviewing
            </button>
            <button
              className={cn(button, "text-accent")}
              disabled={!canFinish}
              onClick={() => {
                // Release an explicitly opened project before its next review cycle begins.
                onFinishing();
                mutate((db, dev) => markReviewed(db, dev, project.id));
                void persistProgress()
                  .then(onReviewed)
                  .catch(() => {});
              }}
            >
              <Check size={14} />
              Confirm review
            </button>
          </div>
        </section>
      )}
      {!noTasks && (
        <details className="border-b border-border py-3">
          <summary className="cursor-pointer text-sm text-text-muted hover:text-text">
            Review prompts{" "}
            <span className="text-xs text-text-faint">· optional</span>
          </summary>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {questions.map(([id, label]) => (
              <label
                key={id}
                className="flex items-center gap-2 text-xs text-text-muted"
              >
                <input
                  type="checkbox"
                  checked={!!progress.checklist[id]}
                  onChange={(e) =>
                    saveEntry(`check:${id}`, { checked: e.target.checked })
                  }
                  className="accent-accent"
                />
                {label}
              </label>
            ))}
          </div>
        </details>
      )}
      {noTasks ? (
        <div className="py-10 text-center">
          <p className="mb-4 text-sm text-text-muted">
            No open tasks in this project.
          </p>
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!!progress.checklist.noTasks}
              onChange={(e) =>
                saveEntry("check:noTasks", { checked: e.target.checked })
              }
              className="accent-accent"
            />
            Confirm there are no tasks
          </label>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 py-3 text-xs text-text-muted">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={onlyUnreviewed}
                onChange={(e) => setOnlyUnreviewed(e.target.checked)}
                className="accent-accent"
              />
              Not reviewed only
            </label>
            <span>Reviewed</span>
          </div>
          <div className="divide-y divide-border">
            {visible.map(({ data, depth }) => {
              const task = data.item;
              const checked = progress.reviewedTaskIds.includes(task.id);
              return (
                <div
                  key={task.id}
                  data-testid="review-row"
                  className="grid grid-cols-[minmax(0,1fr)_80px] items-start gap-1 py-1"
                >
                  <div className="min-w-0">
                    <TaskRow
                      {...data}
                      indent={depth}
                      showProject={false}
                      onActivate={() => openTask(task)}
                      titleSlot={
                        <button
                          className="text-left"
                          onClick={(e) => {
                            e.stopPropagation();
                            openTask(task);
                          }}
                        >
                          {task.title || "Untitled task"}
                        </button>
                      }
                      onComplete={() => {
                        completeTask(task, true);
                        saveEntry(`task:${task.id}`, { checked: true });
                      }}
                      extraActions={[
                        {
                          label: "Add subtask",
                          onSelect: () => setEditor({ task, kind: "subtask" }),
                        },
                        {
                          label: "Defer…",
                          onSelect: () => {
                            setDeferDate(task.defer_date?.slice(0, 10) ?? "");
                            setEditor({ task, kind: "defer" });
                          },
                        },
                        {
                          label: "Drop task",
                          onSelect: () => {
                            mutate((db, dev) =>
                              updateItem(db, dev, task.id, {
                                status: "dropped",
                              }),
                            );
                            saveEntry(`task:${task.id}`, { checked: true });
                          },
                        },
                      ]}
                    />
                    {depth === 0 && task.note && (
                      <Markdown className="mx-3 mb-2 max-h-24 overflow-hidden text-sm text-text-muted">
                        {task.note}
                      </Markdown>
                    )}
                    {editor?.task.id === task.id && (
                      <div className="mx-3 my-2 rounded-md bg-surface-2 p-3">
                        <div className="mb-2 flex justify-between text-xs text-text-muted">
                          <span>
                            {editor.kind === "subtask"
                              ? "Add subtask"
                              : "Defer task"}
                          </span>
                          <button
                            aria-label="Cancel task action"
                            onClick={() => setEditor(null)}
                          >
                            <X size={14} />
                          </button>
                        </div>
                        {editor.kind === "subtask" ? (
                          <QuickAdd
                            key={task.id}
                            placeholder="Subtask title"
                            onCreate={(raw) => create(raw, task.id)}
                          />
                        ) : (
                          <form
                            className="flex flex-wrap gap-2"
                            onSubmit={(e) => {
                              e.preventDefault();
                              if (!deferDate) return;
                              mutate((db, dev) =>
                                updateItem(db, dev, task.id, {
                                  defer_date: fromDateInput(deferDate),
                                }),
                              );
                              saveEntry(`task:${task.id}`, { checked: true });
                              setEditor(null);
                            }}
                          >
                            <input
                              aria-label="Defer date"
                              type="date"
                              required
                              value={deferDate}
                              onChange={(e) => setDeferDate(e.target.value)}
                              className="min-w-0 rounded border border-border bg-surface px-2 py-1 text-sm"
                            />
                            <button className={button}>Save date</button>
                          </form>
                        )}
                      </div>
                    )}
                  </div>
                  <button
                    aria-label={`Reviewed: ${task.title}`}
                    aria-pressed={checked}
                    onClick={() =>
                      saveEntry(`task:${task.id}`, { checked: !checked })
                    }
                    className={cn(
                      "mt-2 flex min-h-9 sm:min-h-7 items-center justify-center gap-1 rounded-md px-1 text-xs hover:bg-surface-2",
                      checked ? "text-accent" : "text-text-muted",
                    )}
                  >
                    <CircleCheck size={14} />
                    {checked ? "Reviewed" : "Review"}
                  </button>
                </div>
              );
            })}
          </div>
          {visible.length === 0 && (
            <p className="py-8 text-center text-sm text-text-muted">
              All open tasks are reviewed. Clear the filter to see them again.
            </p>
          )}
        </>
      )}
      <div className="mt-4">
        <QuickAdd
          key={project.id}
          placeholder="Add a task…  (#tag @user !priority)"
          currentProjectId={project.id}
          onCreate={(raw) => create(raw, project.id)}
        />
      </div>
      <Link
        className="mt-4 inline-flex items-center gap-1 text-xs text-text-muted hover:text-accent"
        to={`/project/${project.id}`}
      >
        Go to project <ExternalLink size={12} />
      </Link>
    </section>
  );
}
