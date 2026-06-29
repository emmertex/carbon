import { useEffect, useState } from "react";
import { CalendarClock, FlaskConical, RefreshCw, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  getCaldavConfig,
  saveCaldavConfig,
  deleteCaldavConfig,
  testCaldav,
  syncCaldavNow,
  type CalDavConfig,
} from "@/lib/caldav";

const inputCls =
  "w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent";

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1 block text-xs font-medium text-text-muted">
      {children}
    </span>
  );
}

interface FormState {
  base_url: string;
  username: string;
  password: string;
  todo_url: string;
  event_url: string;
  sync_tasks: boolean;
  sync_events: boolean;
  enabled: boolean;
  frequency_seconds: number;
  default_event_minutes: number;
}

const blank: FormState = {
  base_url: "",
  username: "",
  password: "",
  todo_url: "",
  event_url: "",
  sync_tasks: false,
  sync_events: false,
  enabled: true,
  frequency_seconds: 300,
  default_event_minutes: 30,
};

function fromConfig(c: CalDavConfig): FormState {
  return {
    base_url: c.base_url ?? "",
    username: c.username ?? "",
    password: "",
    todo_url: c.todo_url ?? "",
    event_url: c.event_url ?? "",
    sync_tasks: c.sync_tasks,
    sync_events: c.sync_events,
    enabled: c.enabled,
    frequency_seconds: c.frequency_seconds,
    default_event_minutes: c.default_event_minutes,
  };
}

/** Per-project CalDAV two-way sync settings, shown in the project detail pane.
 *  The parent (TaskDetail) only renders this for admins with a server configured. */
export function CalDavSettings({ projectId }: { projectId: string }) {
  const [config, setConfig] = useState<CalDavConfig | null>(null);
  const [form, setForm] = useState<FormState>(blank);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(
    null,
  );

  function set(patch: Partial<FormState>) {
    setForm((f) => ({ ...f, ...patch }));
  }

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const c = await getCaldavConfig(projectId);
        if (!alive) return;
        setConfig(c);
        setForm(c ? fromConfig(c) : blank);
        setOpen(!!c);
      } catch (e) {
        if (alive) setError(String(e));
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId]);

  async function save() {
    setBusy(true);
    setError(null);
    setTest(null);
    try {
      const c = await saveCaldavConfig(projectId, {
        base_url: form.base_url,
        username: form.username,
        ...(form.password ? { password: form.password } : {}),
        todo_url: form.todo_url,
        event_url: form.event_url,
        sync_tasks: form.sync_tasks,
        sync_events: form.sync_events,
        enabled: form.enabled,
        frequency_seconds: form.frequency_seconds,
        default_event_minutes: form.default_event_minutes,
      });
      setConfig(c);
      setForm(fromConfig(c));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runTest() {
    setBusy(true);
    setTest({ ok: false, message: "testing…" });
    try {
      setTest(await testCaldav(projectId));
    } catch (e) {
      setTest({ ok: false, message: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function syncNow() {
    setBusy(true);
    setError(null);
    try {
      const r = await syncCaldavNow(projectId);
      setTest({ ok: r.ok, message: r.status });
      setConfig(await getCaldavConfig(projectId));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (
      !window.confirm(
        "Remove CalDAV sync for this project? Remote items are left untouched.",
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await deleteCaldavConfig(projectId);
      setConfig(null);
      setForm(blank);
      setTest(null);
      setOpen(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return null;

  if (!open) {
    return (
      <div>
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-2"
        >
          <CalendarClock size={15} /> Set up CalDAV sync
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-xl border border-border p-3">
      <div className="flex items-center gap-2">
        <CalendarClock size={15} className="text-accent" />
        <span className="text-sm font-medium">CalDAV sync</span>
        <div className="flex-1" />
        <label className="flex items-center gap-1 text-xs text-text-muted">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
          enabled
        </label>
      </div>

      <p className="text-xs text-text-faint">
        Two-way sync this project against one CalDAV account. Runs on the
        server, so a signed-in server is required.
      </p>

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <Label>Username</Label>
          <input
            className={inputCls}
            value={form.username}
            onChange={(e) => set({ username: e.target.value })}
          />
        </label>
        <label className="block">
          <Label>Password</Label>
          <input
            type="password"
            className={inputCls}
            placeholder={config?.has_password ? "leave blank to keep" : ""}
            value={form.password}
            onChange={(e) => set({ password: e.target.value })}
          />
        </label>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.sync_tasks}
          onChange={(e) => set({ sync_tasks: e.target.checked })}
        />
        Sync Tasks (VTODO)
      </label>
      {form.sync_tasks && (
        <label className="block">
          <Label>Task-list collection URL</Label>
          <input
            className={inputCls}
            placeholder="https://dav.example.com/dav/calendars/user/tasks/"
            value={form.todo_url}
            onChange={(e) => set({ todo_url: e.target.value })}
          />
        </label>
      )}

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.sync_events}
          onChange={(e) => set({ sync_events: e.target.checked })}
        />
        Sync Calendar Events (VEVENT) — only tasks with a due date
      </label>
      {form.sync_events && (
        <>
          <label className="block">
            <Label>Calendar collection URL</Label>
            <input
              className={inputCls}
              placeholder="https://dav.example.com/dav/calendars/user/calendar/"
              value={form.event_url}
              onChange={(e) => set({ event_url: e.target.value })}
            />
          </label>
          <label className="block">
            <Label>
              Default event length (minutes, when a task has no estimate)
            </Label>
            <input
              type="number"
              min={1}
              className={cn(inputCls, "w-32")}
              value={form.default_event_minutes}
              onChange={(e) =>
                set({ default_event_minutes: Number(e.target.value) || 30 })
              }
            />
          </label>
        </>
      )}

      <label className="block">
        <Label>Sync every (seconds, min 60)</Label>
        <input
          type="number"
          min={60}
          className={cn(inputCls, "w-32")}
          value={form.frequency_seconds}
          onChange={(e) =>
            set({ frequency_seconds: Number(e.target.value) || 300 })
          }
        />
      </label>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          onClick={save}
          disabled={busy}
          className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
        >
          Save
        </button>
        <button
          onClick={runTest}
          disabled={busy || !config}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-2 disabled:opacity-50"
          title="Test connection"
        >
          <FlaskConical size={14} /> Test
        </button>
        <button
          onClick={syncNow}
          disabled={busy || !config}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-2 disabled:opacity-50"
          title="Sync now"
        >
          <RefreshCw size={14} /> Sync now
        </button>
        <div className="flex-1" />
        <button
          onClick={remove}
          disabled={busy || !config}
          className="flex items-center gap-1.5 rounded-lg p-1.5 text-text-muted hover:bg-surface-2 hover:text-danger disabled:opacity-50"
          title="Remove CalDAV sync"
        >
          <Trash2 size={15} />
        </button>
      </div>

      {test && (
        <p className={cn("text-xs", test.ok ? "text-success" : "text-danger")}>
          {test.message}
        </p>
      )}
      {config?.last_sync_at && (
        <p className="text-xs text-text-faint">
          Last sync: {new Date(config.last_sync_at).toLocaleString()}
          {config.last_status ? ` — ${config.last_status}` : ""}
        </p>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
