// Client for the cross-tenant control plane (/host/*). Signup is public; the
// tenant-management calls require host-admin Basic credentials, which the host
// operator enters in the Host Admin view (kept in-memory, not persisted).

import { getServerConfig, defaultServerUrl } from './config';
import { isNative } from './platform';

export interface TenantRecord {
  id: string;
  subdomain: string;
  display_name: string | null;
  status: 'active' | 'provisional' | 'suspended' | 'deleted';
  plan: string | null;
  created_at: string;
  db_path: string;
  blobs_dir: string;
  expires_at: string | null;
  locked_at: string | null;
  admin_email: string | null;
  blob_quota_bytes: number | null;
  /** Max human users (null = server default, 0 = unlimited). */
  max_users: number | null;
  /** 1 = agents may target private/loopback/LAN endpoints; null/0 = blocked. */
  allow_private_endpoints: number | null;
  url: string;
}

export interface TenantUsage {
  id: string;
  subdomain: string;
  users: number;
  /** Non-bot users (count against the seat limit). */
  humanUsers: number;
  /** Effective human-user cap (0 = unlimited). */
  maxUsers: number;
  dbBytes: number;
  lastActivity: string | null;
  blobBytes: number;
  /** Effective blob quota in bytes (0 = unlimited). */
  blobQuota: number;
}

export interface SignupResult {
  subdomain: string;
  url: string;
  status: string;
}

export interface SignupInput {
  email: string;
  subdomain?: string;
  adminUsername: string;
  adminPassword: string;
  displayName?: string;
}

// The control plane (/host/*) lives on the real server. In a browser that's the
// serving origin; inside a native shell (Capacitor/Tauri) the app is served from
// localhost, so fall back to the configured sync server or the hosted default —
// otherwise signup/delete requests hit the WebView's own localhost and silently go
// nowhere (e.g. the verification email is never sent). Mirrors sync.ts's resolution.
function base(): string {
  if (isNative) return getServerConfig().url || defaultServerUrl();
  return window.location.origin;
}

function hostAuthHeaders(creds: HostCreds): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: 'Basic ' + btoa(`${creds.username}:${creds.password}`),
  };
}

export interface HostCreds {
  username: string;
  password: string;
}

async function parseError(res: Response): Promise<string> {
  const msg = ((await res.json().catch(() => ({}))) as { error?: string }).error;
  return msg || `request failed: ${res.status}`;
}

/** Signup step 1: stage the workspace and email a one-time verification code.
 *  Pass `resend: true` when the user explicitly asks for a new code (bypasses
 *  the server's short duplicate-submit dedup window). */
export async function signupStart(
  input: SignupInput,
  opts?: { resend?: boolean },
): Promise<void> {
  const res = await fetch(`${base()}/host/signup/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, resend: opts?.resend === true }),
  });
  if (!res.ok) throw new Error(await parseError(res));
}

/** Signup step 2: verify the emailed code, creating the workspace + its first admin. */
export async function signupVerify(email: string, code: string): Promise<SignupResult> {
  const res = await fetch(`${base()}/host/signup/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as SignupResult;
}

// ----- self-service workspace deletion (public, email-OTC verified) ----------

/** Delete step 1: request a one-time code to the workspace's contact email. Always
 *  resolves (the server is deliberately non-committal about whether it matched). */
export async function deleteAccountStart(workspace: string, email: string): Promise<void> {
  const res = await fetch(`${base()}/host/delete/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace, email }),
  });
  if (!res.ok) throw new Error(await parseError(res));
}

/** Delete step 2: verify the code, returning a short-lived token for export + delete. */
export async function deleteAccountVerify(
  workspace: string,
  email: string,
  code: string,
): Promise<string> {
  const res = await fetch(`${base()}/host/delete/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace, email, code }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return ((await res.json()) as { token: string }).token;
}

/** Download a full backup of the workspace (authorized by the verified delete token). */
export async function deleteAccountExport(token: string): Promise<void> {
  const res = await fetch(`${base()}/host/delete/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') || '';
  const name = /filename="([^"]+)"/.exec(cd)?.[1] || 'carbon-backup.json';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Delete step 3: permanently delete the workspace and all its data. Irreversible. */
export async function deleteAccountConfirm(token: string): Promise<void> {
  const res = await fetch(`${base()}/host/delete/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new Error(await parseError(res));
}

export async function hostListTenants(creds: HostCreds): Promise<TenantRecord[]> {
  const res = await fetch(`${base()}/host/tenants`, { headers: hostAuthHeaders(creds) });
  if (!res.ok) throw new Error(await parseError(res));
  return ((await res.json()) as { tenants: TenantRecord[] }).tenants;
}

export async function hostCreateTenant(
  creds: HostCreds,
  input: { subdomain?: string; adminUsername: string; adminPassword: string; displayName?: string; plan?: string },
): Promise<TenantRecord> {
  const res = await fetch(`${base()}/host/tenants`, {
    method: 'POST',
    headers: hostAuthHeaders(creds),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as TenantRecord;
}

export async function hostPatchTenant(
  creds: HostCreds,
  id: string,
  patch: {
    status?: 'active' | 'provisional' | 'suspended';
    plan?: string | null;
    expiresAt?: string | null;
    locked?: boolean;
    blobQuotaMb?: number | null;
    maxUsers?: number | null;
    allowPrivateEndpoints?: boolean;
  },
): Promise<void> {
  const res = await fetch(`${base()}/host/tenants/${id}`, {
    method: 'PATCH',
    headers: hostAuthHeaders(creds),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(await parseError(res));
}

export async function hostDeleteTenant(creds: HostCreds, id: string): Promise<void> {
  const res = await fetch(`${base()}/host/tenants/${id}`, {
    method: 'DELETE',
    headers: hostAuthHeaders(creds),
  });
  if (!res.ok) throw new Error(await parseError(res));
}

export async function hostTenantUsage(creds: HostCreds, id: string): Promise<TenantUsage> {
  const res = await fetch(`${base()}/host/tenants/${id}/usage`, { headers: hostAuthHeaders(creds) });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as TenantUsage;
}
