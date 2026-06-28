import { useEffect, useState } from 'react';
import { Trash2, UserPlus, KeyRound } from 'lucide-react';
import {
  adminListUsers,
  adminCreateUser,
  adminUpdateUser,
  adminDeleteUser,
} from '@/lib/admin';
import { useStore } from '@/lib/store';
import type { CurrentUser } from '@/lib/config';
import { cn } from '@/lib/cn';
import { SettingsSection } from './settings/SettingsSection';
import { ErrorText, inputCls } from './settings/controls';

export function AdminUsers() {
  const me = useStore((s) => s.currentUser);
  const [users, setUsers] = useState<CurrentUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetPw, setResetPw] = useState('');

  async function reload() {
    try {
      setUsers(await adminListUsers());
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    void reload();
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await adminCreateUser({ username, password, role });
      setUsername('');
      setPassword('');
      setRole('member');
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }

  async function changeRole(id: string, r: 'admin' | 'member') {
    setError(null);
    try {
      await adminUpdateUser(id, { role: r });
      await reload();
    } catch (e) {
      setError(String(e));
      await reload(); // resync the dropdown to the server's actual state
    }
  }

  async function resetPassword(id: string) {
    if (!resetPw.trim()) return;
    setError(null);
    try {
      await adminUpdateUser(id, { password: resetPw });
      setResetFor(null);
      setResetPw('');
    } catch (e) {
      setError(String(e));
    }
  }

  async function remove(id: string) {
    if (!window.confirm('Delete this user?')) return;
    setError(null);
    try {
      await adminDeleteUser(id);
      await reload();
    } catch (e) {
      setError(String(e)); // e.g. "cannot delete the last admin"
    }
  }

  return (
    <SettingsSection id="users" title="Users (admin)">
      <div className="mb-3 divide-y divide-border rounded-xl border border-border">
        {users.map((u) => (
          <div key={u.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
            <span
              className="flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold text-white"
              style={{ background: u.avatar_color || 'var(--accent)' }}
            >
              {(u.display_name || u.username).charAt(0).toUpperCase()}
            </span>
            <span className="font-medium">{u.username}</span>
            {u.is_bot && <span className="rounded bg-surface-2 px-1.5 text-xs">bot</span>}
            <div className="flex-1" />
            <select
              value={u.role}
              disabled={u.id === me?.id}
              onChange={(e) => changeRole(u.id, e.target.value as 'admin' | 'member')}
              className={cn(inputCls, 'py-1 text-xs disabled:opacity-50')}
            >
              <option value="member">member</option>
              <option value="admin">admin</option>
            </select>
            <button
              onClick={() => {
                setResetFor(resetFor === u.id ? null : u.id);
                setResetPw('');
              }}
              className="rounded-lg p-1.5 text-text-muted hover:bg-surface-2"
              title="Reset password"
            >
              <KeyRound size={15} />
            </button>
            {u.id !== me?.id && (
              <button
                onClick={() => remove(u.id)}
                className="rounded-lg p-1.5 text-text-muted hover:bg-surface-2 hover:text-danger"
                title="Delete user"
              >
                <Trash2 size={15} />
              </button>
            )}
            {resetFor === u.id && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void resetPassword(u.id);
                }}
                className="flex w-full items-center gap-2 pt-1"
              >
                <input
                  autoFocus
                  type="password"
                  value={resetPw}
                  onChange={(e) => setResetPw(e.target.value)}
                  placeholder="New password"
                  className={cn(inputCls, 'flex-1')}
                />
                <button className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg">
                  Set
                </button>
              </form>
            )}
          </div>
        ))}
      </div>

      <form onSubmit={add} className="flex flex-wrap items-center gap-2">
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="username"
          className={inputCls}
          autoComplete="off"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="password"
          className={inputCls}
          autoComplete="new-password"
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as 'admin' | 'member')}
          className={inputCls}
        >
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
        <button
          type="submit"
          disabled={!username || !password}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
        >
          <UserPlus size={15} /> Add user
        </button>
      </form>

      <ErrorText className="mt-2">{error}</ErrorText>
    </SettingsSection>
  );
}
