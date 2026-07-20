import { useEffect, useState } from 'react';
import { Trash2, UserPlus, KeyRound, Shield, ShieldOff, RefreshCw } from 'lucide-react';
import {
  adminListUsers,
  adminCreateUser,
  adminUpdateUser,
  adminDeleteUser,
  adminIssueRecoveryCode,
  adminResetMfa,
  adminResetTrust,
} from '@/lib/admin';
import { useStore } from '@/lib/store';
import type { CurrentUser } from '@/lib/config';
import { cn } from '@/lib/cn';
import { SettingsSection } from './settings/SettingsSection';
import { ErrorText, Card, btnPrimary, btnIcon, inputCls } from './settings/controls';

export function AdminUsers() {
  const me = useStore((s) => s.currentUser);
  const [users, setUsers] = useState<CurrentUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetPw, setResetPw] = useState('');
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);

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
      await adminCreateUser({
        username,
        password,
        role,
        ...(email.trim() ? { email: email.trim() } : {}),
      });
      setUsername('');
      setPassword('');
      setEmail('');
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
      await reload();
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

  async function issueRecovery(id: string) {
    setError(null);
    try {
      const code = await adminIssueRecoveryCode(id);
      setRecoveryCode(code);
    } catch (e) {
      setError(String(e));
    }
  }

  async function resetUserMfa(id: string) {
    if (!window.confirm('Clear this user’s 2FA and device trust? They must re-enroll on next login.'))
      return;
    setError(null);
    try {
      await adminResetMfa(id);
    } catch (e) {
      setError(String(e));
    }
  }

  async function resetUserTrust(id: string) {
    if (!window.confirm('Forget trusted devices for this user? Next login on every device needs 2FA.'))
      return;
    setError(null);
    try {
      await adminResetTrust(id);
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
      setError(String(e));
    }
  }

  return (
    <SettingsSection id="users" title="Users (admin)">
      <Card className="mb-3 divide-y divide-border">
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
              className={btnIcon}
              title="Reset password"
            >
              <KeyRound size={15} />
            </button>
            {!u.is_bot && (
              <>
                <button
                  onClick={() => void issueRecovery(u.id)}
                  className={btnIcon}
                  title="Issue one-use recovery code"
                >
                  <Shield size={15} />
                </button>
                <button
                  onClick={() => void resetUserTrust(u.id)}
                  className={btnIcon}
                  title="Reset device trust"
                >
                  <ShieldOff size={15} />
                </button>
                <button
                  onClick={() => void resetUserMfa(u.id)}
                  className={cn(btnIcon, 'hover:text-danger')}
                  title="Reset 2FA (force re-enroll)"
                >
                  <RefreshCw size={15} />
                </button>
              </>
            )}
            {u.id !== me?.id && (
              <button
                onClick={() => remove(u.id)}
                className={cn(btnIcon, 'hover:text-danger')}
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
                <button className={btnPrimary}>Set</button>
              </form>
            )}
          </div>
        ))}
      </Card>

      {recoveryCode && (
        <div className="mb-3 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2 text-sm">
          <p className="mb-1 font-medium">One-use recovery code (copy now):</p>
          <code className="font-mono text-xs">{recoveryCode}</code>
          <button
            type="button"
            className="ml-2 text-xs text-accent"
            onClick={() => setRecoveryCode(null)}
          >
            Dismiss
          </button>
        </div>
      )}

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
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="email (optional)"
          className={inputCls}
          autoComplete="off"
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as 'admin' | 'member')}
          className={inputCls}
        >
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
        <button type="submit" disabled={!username || !password} className={btnPrimary}>
          <UserPlus size={15} /> Add user
        </button>
      </form>

      <ErrorText className="mt-2">{error}</ErrorText>
    </SettingsSection>
  );
}
