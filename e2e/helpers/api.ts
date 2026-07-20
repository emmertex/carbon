import { Secret, TOTP } from 'otpauth';

const DEFAULT_BASE = 'http://localhost:3069';
/** Stable device id so e2e logins stay trusted after the first MFA enrollment. */
const E2E_DEVICE_ID = 'e2e-runner';
/** TOTP secrets from enrollments in this process (for needs_2fa on a new device id). */
const totpSecrets = new Map<string, string>();

export interface LoginResult {
  token: string;
  /** @deprecated Prefer `token` — Basic can no longer call admin/API routes. */
  basic: string;
  user: { id: string; username: string };
}

function totpNow(secretBase32: string): string {
  return new TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  }).generate();
}

/**
 * Password login with MFA: enrolls TOTP on first use, then trusts `e2e-runner`
 * so later calls in the same workspace skip the challenge.
 */
export async function login(
  baseUrl = DEFAULT_BASE,
  username: string,
  password: string,
): Promise<LoginResult> {
  const basic = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  const res = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { Authorization: basic, 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: E2E_DEVICE_ID, device_name: 'E2E' }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    token?: string;
    open?: boolean;
    status?: string;
    challenge?: string;
    user?: { id: string; username: string };
  };

  if (body.open) {
    throw new Error('login: server is in open mode (no users)');
  }
  if (body.token && body.user) {
    return { token: body.token, basic, user: body.user };
  }

  if (body.status === 'needs_enrollment' && body.challenge) {
    const start = await fetch(`${baseUrl}/api/mfa/enroll/totp/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${body.challenge}` },
    });
    if (!start.ok) throw new Error(`mfa enroll start failed: ${start.status}`);
    const { secret } = (await start.json()) as { secret: string };
    totpSecrets.set(username, secret);
    const confirm = await fetch(`${baseUrl}/api/mfa/enroll/totp/confirm`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${body.challenge}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code: totpNow(secret) }),
    });
    if (!confirm.ok) throw new Error(`mfa enroll confirm failed: ${confirm.status}`);
    const finish = await fetch(`${baseUrl}/api/mfa/enroll/finish`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${body.challenge}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        device_id: E2E_DEVICE_ID,
        device_name: 'E2E',
        issue_recovery_codes: false,
      }),
    });
    if (!finish.ok) throw new Error(`mfa enroll finish failed: ${finish.status}`);
    const done = (await finish.json()) as { token: string; user: { id: string; username: string } };
    return { token: done.token, basic, user: done.user };
  }

  if (body.status === 'needs_2fa' && body.challenge) {
    const secret = totpSecrets.get(username);
    if (!secret) {
      throw new Error(
        `login needs_2fa for ${username} but no TOTP secret in this process — re-run after enroll or reset MFA`,
      );
    }
    const verify = await fetch(`${baseUrl}/api/mfa/login/verify`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${body.challenge}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        device_id: E2E_DEVICE_ID,
        device_name: 'E2E',
        totp: totpNow(secret),
      }),
    });
    if (!verify.ok) throw new Error(`mfa verify failed: ${verify.status}`);
    const done = (await verify.json()) as { token: string; user: { id: string; username: string } };
    return { token: done.token, basic, user: done.user };
  }

  throw new Error(`login unexpected response: ${JSON.stringify(body)}`);
}

export async function health(baseUrl = DEFAULT_BASE): Promise<{ ok: boolean }> {
  const res = await fetch(`${baseUrl}/api/health`);
  if (!res.ok) throw new Error(`health failed: ${res.status}`);
  return res.json() as Promise<{ ok: boolean }>;
}

export interface TaskSummary {
  id: string;
  title: string;
  status?: string;
}

export async function createTask(
  token: string,
  title: string,
  baseUrl = DEFAULT_BASE,
): Promise<TaskSummary> {
  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`createTask failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<TaskSummary>;
}

export async function listTasks(
  token: string,
  baseUrl = DEFAULT_BASE,
  query = '',
): Promise<TaskSummary[]> {
  const res = await fetch(`${baseUrl}/api/tasks${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`listTasks failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { tasks: TaskSummary[] };
  return body.tasks;
}

export async function completeTask(
  token: string,
  taskId: string,
  baseUrl = DEFAULT_BASE,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/tasks/${taskId}/complete`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`completeTask failed: ${res.status} ${await res.text()}`);
}

export async function addComment(
  token: string,
  taskId: string,
  body: string,
  baseUrl = DEFAULT_BASE,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/tasks/${taskId}/comments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`addComment failed: ${res.status} ${await res.text()}`);
}

export async function agentLists(
  token: string,
  baseUrl = DEFAULT_BASE,
): Promise<{ lists: { id: string; name: string }[] }> {
  const res = await fetch(`${baseUrl}/api/agent/lists`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`agentLists failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ lists: { id: string; name: string }[] }>;
}

export async function createUser(
  sessionToken: string,
  username: string,
  password: string,
  role: 'member' | 'admin' = 'member',
  baseUrl = DEFAULT_BASE,
): Promise<{ username: string }> {
  const res = await fetch(`${baseUrl}/api/admin/users`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username, password, role }),
  });
  if (!res.ok) throw new Error(`createUser failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ username: string }>;
}

export async function createApiToken(
  sessionToken: string,
  name: string,
  scopes: string[],
  baseUrl = DEFAULT_BASE,
): Promise<{ token: string }> {
  const res = await fetch(`${baseUrl}/api/admin/tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, scopes }),
  });
  if (!res.ok) throw new Error(`createApiToken failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ token: string }>;
}
