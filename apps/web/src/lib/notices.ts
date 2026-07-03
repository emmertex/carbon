import { getServerConfig, authHeaders } from './config';

// System-notice ("Carbon task") client helpers. A notice is delivered as an Inbox
// task marked `sys_kind`; the actionable truth lives server-side and is reached
// via these endpoints. Session-authed to the addressed user.

function joinUrl(base: string, path: string): string {
  return base.replace(/\/$/, '') + path;
}

export interface SystemNotice {
  id: string;
  user_id: string;
  item_id: string;
  kind: string;
  state: 'pending' | 'accepted' | 'declined' | 'expired';
  payload_json: string | null;
  action_token: string;
  created_at: string;
  resolved_at: string | null;
}

/** This user's open (pending) notices. Empty on error/offline. */
export async function fetchOpenNotices(): Promise<SystemNotice[]> {
  const cfg = getServerConfig();
  if (!cfg.url) return [];
  try {
    const res = await fetch(joinUrl(cfg.url, '/api/notices'), { headers: authHeaders(cfg) });
    if (!res.ok) return [];
    const body = (await res.json()) as { notices?: SystemNotice[] };
    return body.notices ?? [];
  } catch {
    return [];
  }
}

/** Act on a notice (accept | decline | dismiss). Returns the resolved notice. */
export async function actOnNotice(
  id: string,
  action: 'accept' | 'decline' | 'dismiss',
): Promise<SystemNotice | null> {
  const cfg = getServerConfig();
  if (!cfg.url) return null;
  const res = await fetch(joinUrl(cfg.url, `/api/notices/${id}/act`), {
    method: 'POST',
    headers: authHeaders(cfg),
    body: JSON.stringify({ action }),
  });
  if (!res.ok) throw new Error(`notice act failed: ${res.status}`);
  const body = (await res.json()) as { notice?: SystemNotice };
  return body.notice ?? null;
}
