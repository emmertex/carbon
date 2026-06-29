import { getServerConfig, authHeaders } from "./config";

function url(path: string): string {
  return getServerConfig().url.replace(/\/$/, "") + path;
}

async function errMsg(res: Response, fallback: string): Promise<string> {
  const msg = ((await res.json().catch(() => ({}))) as { error?: string })
    .error;
  return msg || `${fallback}: ${res.status}`;
}

/** Per-project CalDAV config as returned by the server (never includes the password). */
export interface CalDavConfig {
  project_id: string;
  base_url: string | null;
  username: string | null;
  todo_url: string | null;
  event_url: string | null;
  sync_tasks: boolean;
  sync_events: boolean;
  enabled: boolean;
  frequency_seconds: number;
  default_event_minutes: number;
  last_sync_at: string | null;
  last_status: string | null;
  has_password: boolean;
}

export interface CalDavConfigInput {
  base_url?: string;
  username?: string;
  /** Omit (or send empty) to keep the stored password. */
  password?: string;
  todo_url?: string;
  event_url?: string;
  sync_tasks?: boolean;
  sync_events?: boolean;
  enabled?: boolean;
  frequency_seconds?: number;
  default_event_minutes?: number;
}

export async function getCaldavConfig(
  projectId: string,
): Promise<CalDavConfig | null> {
  const res = await fetch(url(`/api/projects/${projectId}/caldav`), {
    headers: authHeaders(getServerConfig()),
  });
  if (!res.ok) throw new Error(await errMsg(res, "load failed"));
  return ((await res.json()) as { config: CalDavConfig | null }).config;
}

export async function saveCaldavConfig(
  projectId: string,
  input: CalDavConfigInput,
): Promise<CalDavConfig> {
  const res = await fetch(url(`/api/projects/${projectId}/caldav`), {
    method: "PUT",
    headers: authHeaders(getServerConfig()),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await errMsg(res, "save failed"));
  return ((await res.json()) as { config: CalDavConfig }).config;
}

export async function deleteCaldavConfig(projectId: string): Promise<void> {
  const res = await fetch(url(`/api/projects/${projectId}/caldav`), {
    method: "DELETE",
    headers: authHeaders(getServerConfig()),
  });
  if (!res.ok) throw new Error(await errMsg(res, "delete failed"));
}

export async function testCaldav(
  projectId: string,
): Promise<{ ok: boolean; message: string }> {
  const res = await fetch(url(`/api/projects/${projectId}/caldav/test`), {
    method: "POST",
    headers: authHeaders(getServerConfig()),
  });
  return (await res.json()) as { ok: boolean; message: string };
}

export interface SyncNowResult {
  ok: boolean;
  status: string;
  pulled: number;
  pushed: number;
  errors: string[];
}

export async function syncCaldavNow(projectId: string): Promise<SyncNowResult> {
  const res = await fetch(url(`/api/projects/${projectId}/caldav/sync`), {
    method: "POST",
    headers: authHeaders(getServerConfig()),
  });
  if (!res.ok) throw new Error(await errMsg(res, "sync failed"));
  return (await res.json()) as SyncNowResult;
}
