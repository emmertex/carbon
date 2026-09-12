import { useState, useEffect, useCallback } from 'react';
import { Check, ChevronLeft, ListTodo, SkipForward } from 'lucide-react';
import {
  getProjects,
  getChildren,
  needsReview,
  markReviewed,
  updateItem,
  setCompleted,
} from '@carbon/core';
import { useQuery } from '@/hooks/useQuery';
import { mutate } from '@/lib/mutate';
import { cn } from '@/lib/cn';

interface ReviewSession {
  projects: string[];
  currentIndex: number;
  completedProjectIds: Set<string>;
}

interface ProjectChecklist {
  tasksRelevant: boolean;
  newTasksNeeded: boolean;
  completeOrDrop: boolean;
  statusCorrect: boolean;
  nextActionIdentified: boolean;
}

const INITIAL_CHECKLIST: ProjectChecklist = {
  tasksRelevant: false,
  newTasksNeeded: false,
  completeOrDrop: false,
  statusCorrect: false,
  nextActionIdentified: false,
};

export function ReviewView() {
  const [session, setSession] = useState<ReviewSession | null>(null);
  const [checklist, setChecklist] = useState<ProjectChecklist>(INITIAL_CHECKLIST);
  const [showList, setShowList] = useState(false);
  const [deepDive, setDeepDive] = useState(false);
  const [taskIndex, setTaskIndex] = useState(0);

  // All projects due for review
  const reviewProjects = useQuery((db) =>
    getProjects(db).filter((p) => needsReview(p)),
  );

  // Load tasks for both the checklist count and deep-dive mode.
  const currentProjectId = session?.projects[session.currentIndex] ?? null;
  const currentTasks = useQuery(
    (db) => {
      if (!currentProjectId) return [];
      return getChildren(db, currentProjectId).filter((t) => t.status === 'active');
    },
    [currentProjectId],
  );

  // Initialize review session when projects are loaded
  useEffect(() => {
    if (reviewProjects && reviewProjects.length > 0 && !session && !showList) {
      setSession({
        projects: reviewProjects.map((p) => p.id),
        currentIndex: 0,
        completedProjectIds: new Set(),
      });
    }
  }, [reviewProjects, session, showList]);

  const currentProject = currentProjectId
    ? reviewProjects?.find((p) => p.id === currentProjectId) ?? null
    : null;

  const resetChecklist = useCallback(() => {
    setChecklist(INITIAL_CHECKLIST);
  }, []);

  const reviewProject = useCallback(() => {
    if (!currentProject) return;
    mutate((db, dev) => markReviewed(db, dev, currentProject.id));

    setSession((s) => {
      if (!s) return s;
      const nextIndex = s.currentIndex + 1;
      return {
        ...s,
        currentIndex: nextIndex,
        completedProjectIds: new Set([...s.completedProjectIds, currentProject.id]),
      };
    });
    resetChecklist();
    setDeepDive(false);
    setTaskIndex(0);
  }, [currentProject, resetChecklist]);

  const enterDeepDive = useCallback(() => {
    setDeepDive(true);
    setTaskIndex(0);
  }, []);

  const exitDeepDive = useCallback(() => {
    setDeepDive(false);
    setTaskIndex(0);
  }, []);

  const handleTaskAction = useCallback((taskId: string, action: 'complete' | 'drop') => {
    const remainingCount = mutate((db, dev) => {
      if (action === 'complete') {
        setCompleted(db, dev, taskId, true);
      } else if (action === 'drop') {
        updateItem(db, dev, taskId, { status: 'dropped' });
      }
      return currentProjectId
        ? getChildren(db, currentProjectId).filter((t) => t.status === 'active')
            .length
        : 0;
    });
    setTaskIndex((i) => Math.max(0, Math.min(i, remainingCount - 1)));
    if (remainingCount === 0) setDeepDive(false);
  }, [currentProjectId]);

  const skipTask = useCallback(() => {
    setTaskIndex((i) => Math.min(i + 1, (currentTasks?.length ?? 0) - 1));
  }, [currentTasks?.length]);

  const allChecked = Object.values(checklist).every(Boolean);

  // Done state
  if (!session || session.currentIndex >= session.projects.length) {
    if (session && session.currentIndex >= session.projects.length) {
      return (
        <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
          <div className="rounded-xl border border-accent bg-accent/10 px-6 py-8 text-center">
            <Check size={48} className="mx-auto text-accent" />
            <h1 className="mt-4 text-2xl font-bold">Review Complete</h1>
            <p className="mt-2 text-text-muted">
              You've reviewed all {session.completedProjectIds.size} projects due
              for review.
            </p>
          </div>
        </div>
      );
    }
    return (
      <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
        <div className="mb-4">
          <h1 className="text-2xl font-bold tracking-tight">Review</h1>
          <p className="mt-0.5 text-sm text-text-muted">
            Keep projects honest. Set a review interval in a project's details.
          </p>
        </div>
        {reviewProjects && reviewProjects.length > 0 ? (
          <div className="flex flex-col gap-2">
            {reviewProjects.map((project) => (
              <button
                key={project.id}
                onClick={() => {
                  setSession({
                    projects: [
                      project.id,
                      ...reviewProjects
                        .filter((p) => p.id !== project.id)
                        .map((p) => p.id),
                    ],
                    currentIndex: 0,
                    completedProjectIds: new Set(),
                  });
                  resetChecklist();
                  setDeepDive(false);
                  setTaskIndex(0);
                  setShowList(false);
                }}
                className="rounded-xl border border-border bg-surface px-4 py-3 text-left font-medium hover:text-accent"
              >
                {project.title || 'Untitled project'}
              </button>
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-text-muted">
            {reviewProjects ? 'Nothing to review right now.' : 'Loading projects…'}
          </div>
        )}
      </div>
    );
  }

  // Task deep-dive mode
  if (deepDive && currentProject && currentTasks && currentTasks.length > 0) {
    const task = currentTasks[taskIndex];
    if (task) {
      return (
        <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
          <div className="mb-4">
            <button
              onClick={exitDeepDive}
              className="flex items-center gap-1 text-sm text-text-muted hover:text-text"
            >
              <ChevronLeft size={14} /> Exit Deep Dive
            </button>
          </div>
          <div className="mb-4">
            <h2 className="text-lg font-semibold">
              Reviewing: {currentProject.title}
            </h2>
            <p className="mt-1 text-sm text-text-muted">
              Task {taskIndex + 1} of {currentTasks.length}
            </p>
          </div>
          <div className="rounded-xl border border-border bg-surface px-4 py-6">
            <h3 className="font-medium">{task.title}</h3>
            {task.note && (
              <p className="mt-2 text-sm text-text-muted">{task.note}</p>
            )}
            <div className="mt-4">
              <p className="text-sm font-medium text-text-muted">
                What's the next step for this task?
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  onClick={() => handleTaskAction(task.id, 'complete')}
                  className="flex items-center gap-1 rounded-lg border border-border bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover"
                >
                  <Check size={14} /> Complete
                </button>
                <button
                  onClick={() => handleTaskAction(task.id, 'drop')}
                  className="flex items-center gap-1 rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-3"
                >
                  Drop
                </button>
                <button
                  onClick={skipTask}
                  className="flex items-center gap-1 rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-sm font-medium text-text-muted hover:bg-surface-3"
                >
                  <SkipForward size={14} /> Skip
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }
  }

  // Project review checklist mode
  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
      <div className="mb-4">
        <button
          onClick={() => {
            setShowList(true);
            setSession(null);
            setDeepDive(false);
            setTaskIndex(0);
            resetChecklist();
          }}
          className="flex items-center gap-1 text-sm text-text-muted hover:text-text"
        >
          <ChevronLeft size={14} /> Back to Review List
        </button>
      </div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">
          {currentProject?.title || 'Untitled Project'}
        </h1>
        <p className="mt-0.5 text-sm text-text-muted">
          Project {session.currentIndex + 1} of {session.projects.length} ·{' '}
          {currentTasks?.length ?? 0} open tasks
        </p>
      </div>

      <div className="space-y-3">
        <label className="flex items-start gap-3 rounded-xl border border-border bg-surface px-4 py-3">
          <input
            type="checkbox"
            checked={checklist.tasksRelevant}
            onChange={(e) =>
              setChecklist((c) => ({ ...c, tasksRelevant: e.target.checked }))
            }
            className="mt-1 h-4 w-4 rounded border-border accent-accent"
          />
          <span className="flex-1">
            <span className="block text-sm font-medium">
              All tasks still relevant?
            </span>
            <span className="block text-xs text-text-muted">
              Are all the tasks in this project still needed, or have some become
              obsolete?
            </span>
          </span>
        </label>

        <label className="flex items-start gap-3 rounded-xl border border-border bg-surface px-4 py-3">
          <input
            type="checkbox"
            checked={checklist.newTasksNeeded}
            onChange={(e) =>
              setChecklist((c) => ({ ...c, newTasksNeeded: e.target.checked }))
            }
            className="mt-1 h-4 w-4 rounded border-border accent-accent"
          />
          <span className="flex-1">
            <span className="block text-sm font-medium">
              Any new tasks to add?
            </span>
            <span className="block text-xs text-text-muted">
              Has this project evolved to require new tasks?
            </span>
          </span>
        </label>

        <label className="flex items-start gap-3 rounded-xl border border-border bg-surface px-4 py-3">
          <input
            type="checkbox"
            checked={checklist.completeOrDrop}
            onChange={(e) =>
              setChecklist((c) => ({ ...c, completeOrDrop: e.target.checked }))
            }
            className="mt-1 h-4 w-4 rounded border-border accent-accent"
          />
          <span className="flex-1">
            <span className="block text-sm font-medium">
              Any tasks to complete or drop?
            </span>
            <span className="block text-xs text-text-muted">
              Are any tasks ready to be marked complete or should be dropped?
            </span>
          </span>
        </label>

        <label className="flex items-start gap-3 rounded-xl border border-border bg-surface px-4 py-3">
          <input
            type="checkbox"
            checked={checklist.statusCorrect}
            onChange={(e) =>
              setChecklist((c) => ({ ...c, statusCorrect: e.target.checked }))
            }
            className="mt-1 h-4 w-4 rounded border-border accent-accent"
          />
          <span className="flex-1">
            <span className="block text-sm font-medium">
              Project status correct?
            </span>
            <span className="block text-xs text-text-muted">
              Is this project still Active, or should it be On Hold or Dropped?
            </span>
          </span>
        </label>

        <label className="flex items-start gap-3 rounded-xl border border-border bg-surface px-4 py-3">
          <input
            type="checkbox"
            checked={checklist.nextActionIdentified}
            onChange={(e) =>
              setChecklist((c) => ({ ...c, nextActionIdentified: e.target.checked }))
            }
            className="mt-1 h-4 w-4 rounded border-border accent-accent"
          />
          <span className="flex-1">
            <span className="block text-sm font-medium">
              Next action identified?
            </span>
            <span className="block text-xs text-text-muted">
              Do you know the next concrete action to move this project forward?
            </span>
          </span>
        </label>
      </div>

      <div className="mt-6 flex flex-wrap gap-3">
        <button
          onClick={enterDeepDive}
          disabled={!(currentTasks && currentTasks.length > 0)}
          className={cn(
            'flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium',
            !(currentTasks && currentTasks.length > 0)
              ? 'cursor-not-allowed text-text-muted'
              : 'bg-surface-2 text-text hover:bg-surface-3',
          )}
        >
          <ListTodo size={14} />
          Deep Dive into Tasks
        </button>

        <button
          onClick={reviewProject}
          disabled={!allChecked}
          className={cn(
            'flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium',
            allChecked
              ? 'bg-accent text-accent-fg hover:bg-accent-hover'
              : 'cursor-not-allowed bg-surface-2 text-text-muted',
          )}
        >
          <Check size={14} />
          Mark as Reviewed
          {!allChecked && (
            <span className="ml-1 text-xs opacity-60">(complete checklist)</span>
          )}
        </button>
      </div>

      {allChecked && !deepDive && (
        <div className="mt-4 rounded-lg border border-accent bg-accent/10 px-3 py-2 text-xs text-accent">
          Checklist complete! You can now mark this project as reviewed.
        </div>
      )}
    </div>
  );
}
