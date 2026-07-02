const DEFAULT_BASE = 'http://localhost:3069';

export interface LoginResult {
  token: string;
  basic: string;
  user: { id: string; username: string };
}

export async function login(
  baseUrl = DEFAULT_BASE,
  username: string,
  password: string,
): Promise<LoginResult> {
  const basic = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  const res = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { Authorization: basic },
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { token: string; user: { id: string; username: string } };
  return { token: body.token, basic, user: body.user };
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
  basic: string,
  username: string,
  password: string,
  role: 'member' | 'admin' = 'member',
  baseUrl = DEFAULT_BASE,
): Promise<{ username: string }> {
  const res = await fetch(`${baseUrl}/api/admin/users`, {
    method: 'POST',
    headers: {
      Authorization: basic,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username, password, role }),
  });
  if (!res.ok) throw new Error(`createUser failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ username: string }>;
}

export async function createApiToken(
  basic: string,
  name: string,
  scopes: string[],
  baseUrl = DEFAULT_BASE,
): Promise<{ token: string }> {
  const res = await fetch(`${baseUrl}/api/admin/tokens`, {
    method: 'POST',
    headers: {
      Authorization: basic,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, scopes }),
  });
  if (!res.ok) throw new Error(`createApiToken failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ token: string }>;
}
