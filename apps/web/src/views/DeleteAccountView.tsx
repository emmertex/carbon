import { useState } from 'react';
import { Loader2, MailCheck, Download, TriangleAlert, Trash2, Check } from 'lucide-react';
import { Link } from 'react-router-dom';
import { deleteAccountStart, deleteAccountVerify, deleteAccountExport, deleteAccountConfirm } from '@/lib/host';
import { useStore } from '@/lib/store';

const inputCls = 'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent';

type Step = 'form' | 'code' | 'confirm' | 'done';

/** Best-effort guess of the workspace at this address, so visiting from a tenant
 *  subdomain pre-fills the field. Null on the apex / self-host / unknown host. */
function currentWorkspace(baseDomain: string | null): string {
  if (!baseDomain) return '';
  const host = window.location.hostname.toLowerCase();
  const base = baseDomain.toLowerCase();
  if (host === base || !host.endsWith('.' + base)) return '';
  const label = host.slice(0, host.length - base.length - 1);
  return label.includes('.') ? '' : label;
}

/**
 * Public, directly-reachable workspace deletion. Identity is proven by an emailed
 * one-time code sent to the workspace's contact address — being signed in is neither
 * required nor sufficient. After the code is verified the owner can download a full
 * backup, then permanently delete the workspace and all its data.
 */
export function DeleteAccountView() {
  const baseDomain = useStore((s) => s.baseDomain);
  const params = new URLSearchParams(window.location.search);
  const [step, setStep] = useState<Step>('form');
  const [workspace, setWorkspace] = useState(params.get('workspace') || currentWorkspace(baseDomain));
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [token, setToken] = useState('');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await deleteAccountStart(workspace.trim(), email.trim());
      setStep('code');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setBusy(true);
    setError(null);
    setResent(false);
    try {
      await deleteAccountStart(workspace.trim(), email.trim());
      setResent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const t = await deleteAccountVerify(workspace.trim(), email.trim(), code.trim());
      setToken(t);
      setStep('confirm');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    setBusy(true);
    setError(null);
    try {
      await deleteAccountExport(token);
      setDownloaded(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    setBusy(true);
    setError(null);
    try {
      await deleteAccountConfirm(token);
      setStep('done');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (step === 'done') {
    return (
      <div className="mx-auto flex min-h-full max-w-md flex-col justify-center px-6 py-12">
        <div className="rounded-xl border border-border bg-surface p-6 text-center">
          <Check className="mx-auto mb-3 text-green-500" size={32} />
          <h1 className="mb-1 text-lg font-semibold">Workspace deleted</h1>
          <p className="mb-4 text-sm text-text-muted">
            The workspace <strong>{workspace.trim()}</strong> and all of its data have been permanently removed. Thanks
            for using Carbon.
          </p>
          {baseDomain && (
            <a
              href={`https://${baseDomain}`}
              className="inline-block rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
            >
              Go to {baseDomain}
            </a>
          )}
        </div>
      </div>
    );
  }

  if (step === 'confirm') {
    return (
      <div className="mx-auto flex min-h-full max-w-md flex-col justify-center px-6 py-12">
        <h1 className="mb-1 text-xl font-semibold">Delete {workspace.trim()}</h1>
        <p className="mb-6 text-sm text-text-muted">
          Your email is verified. Download a backup of everything first if you want to keep it — then permanently delete
          the workspace.
        </p>

        <button
          onClick={download}
          disabled={busy}
          className="mb-6 flex w-full items-center justify-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-surface-2 disabled:opacity-50"
        >
          {busy ? <Loader2 className="animate-spin" size={16} /> : <Download size={16} />}
          {downloaded ? 'Download again' : 'Download a backup (.json)'}
        </button>

        <div className="rounded-lg border border-red-500/40 bg-red-500/5 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-red-500">
            <TriangleAlert size={16} /> This cannot be undone
          </div>
          <p className="mb-3 text-sm text-text-muted">
            Deleting removes the workspace, every task, attachment, and account in it. There is no recovery.
          </p>
          <label className="mb-3 flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>
              I understand this permanently deletes <strong>{workspace.trim()}</strong> and all its data.
            </span>
          </label>
          {error && <p className="mb-3 text-sm text-red-500">{error}</p>}
          <button
            onClick={confirmDelete}
            disabled={busy || !ack}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {busy ? <Loader2 className="animate-spin" size={16} /> : <Trash2 size={16} />}
            Permanently delete workspace
          </button>
        </div>
        <div className="mt-6 text-center text-sm">
          <Link to="/" className="text-text-muted hover:text-text">
            Cancel
          </Link>
        </div>
      </div>
    );
  }

  if (step === 'code') {
    return (
      <div className="mx-auto flex min-h-full max-w-md flex-col justify-center px-6 py-12">
        <MailCheck className="mb-3 text-accent" size={28} />
        <h1 className="mb-1 text-xl font-semibold">Check your email</h1>
        <p className="mb-6 text-sm text-text-muted">
          If <strong>{email.trim()}</strong> is the contact address for <strong>{workspace.trim()}</strong>, we sent it
          a 6-digit code. Enter it to continue.
        </p>
        <form onSubmit={verify} className="space-y-4">
          <input
            className={`${inputCls} text-center font-mono text-lg tracking-[0.4em]`}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
            inputMode="numeric"
            autoFocus
            autoComplete="one-time-code"
          />
          {error && <p className="text-sm text-red-500">{error}</p>}
          {resent && !error && <p className="text-sm text-green-600">New code sent.</p>}
          <button
            type="submit"
            disabled={busy || code.length !== 6}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy && <Loader2 className="animate-spin" size={16} />}
            Verify code
          </button>
        </form>
        <div className="mt-6 flex items-center justify-between text-sm">
          <button onClick={() => setStep('form')} className="text-text-muted hover:text-text">
            ← Back
          </button>
          <button onClick={resend} disabled={busy} className="text-accent disabled:opacity-50">
            Resend code
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col justify-center px-6 py-12">
      <h1 className="mb-1 text-xl font-semibold">Delete a Carbon workspace</h1>
      <p className="mb-6 text-sm text-text-muted">
        Permanently delete a workspace and all of its data. We'll email a one-time code to the workspace's contact
        address to confirm it's really you — no password needed. You'll be able to download a backup before anything is
        deleted.
      </p>
      <form onSubmit={start} className="space-y-4">
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Workspace</span>
          <input
            className={inputCls}
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value.toLowerCase())}
            placeholder="smiths"
            autoCapitalize="none"
            required
          />
          <span className="mt-1 block text-xs text-text-muted">
            The workspace's address
            {baseDomain ? ` (the part before .${baseDomain})` : ''}.
          </span>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Contact email</span>
          <input
            className={inputCls}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            autoCapitalize="none"
          />
          <span className="mt-1 block text-xs text-text-muted">The email the workspace was created with.</span>
        </label>
        {error && <p className="text-sm text-red-500">{error}</p>}
        <button
          type="submit"
          disabled={busy || !workspace.trim() || !email.trim()}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy && <Loader2 className="animate-spin" size={16} />}
          Send confirmation code
        </button>
      </form>
      <p className="mt-6 text-center text-sm text-text-muted">
        Changed your mind?{' '}
        <Link to="/" className="text-accent">
          Back to Carbon
        </Link>
      </p>
    </div>
  );
}
