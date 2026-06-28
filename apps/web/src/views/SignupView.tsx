import { useState } from 'react';
import { Loader2, Check, MailCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { signupStart, signupVerify, type SignupInput, type SignupResult } from '@/lib/host';

const inputCls =
  'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent';

type Step = 'form' | 'code' | 'done';

/** Public self-service signup: collect details, verify the email with a one-time code,
 *  then create the workspace + its first admin. */
export function SignupView() {
  const [step, setStep] = useState<Step>('form');
  const [displayName, setDisplayName] = useState('');
  const [subdomain, setSubdomain] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<SignupResult | null>(null);
  const [resent, setResent] = useState(false);

  function input(): SignupInput {
    return {
      email: email.trim(),
      subdomain: subdomain.trim() || undefined,
      adminUsername: username.trim(),
      adminPassword: password,
      displayName: displayName.trim() || undefined,
    };
  }

  async function startSignup(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signupStart(input());
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
      await signupStart(input());
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
      const res = await signupVerify(email.trim(), code.trim());
      setDone(res);
      setStep('done');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (step === 'done' && done) {
    return (
      <div className="mx-auto flex min-h-full max-w-md flex-col justify-center px-6 py-12">
        <div className="rounded-xl border border-border bg-surface p-6 text-center">
          <Check className="mx-auto mb-3 text-green-500" size={32} />
          <h1 className="mb-1 text-lg font-semibold">Workspace ready</h1>
          <p className="mb-4 text-sm text-text-muted">Your workspace is live at</p>
          <a
            href={done.url}
            className="mb-4 block break-all rounded-lg bg-accent-soft px-3 py-2 font-mono text-sm text-accent"
          >
            {done.url}
          </a>
          <p className="mb-4 text-sm text-text-muted">
            Sign in there with <strong>{username}</strong> and the password you chose. You have a
            30-day trial to explore everything.
          </p>
          <a
            href={done.url}
            className="inline-block rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
          >
            Open your workspace
          </a>
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
          We sent a 6-digit code to <strong>{email.trim()}</strong>. Enter it to finish creating
          your workspace.
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
            Verify & create workspace
          </button>
        </form>
        <div className="mt-6 flex items-center justify-between text-sm">
          <button onClick={() => setStep('form')} className="text-text-muted hover:text-text">
            ← Edit details
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
      <h1 className="mb-1 text-xl font-semibold">Create a Carbon workspace</h1>
      <p className="mb-6 text-sm text-text-muted">
        A private, synced space for you and your team. You'll be the admin and can invite others
        afterwards. Starts with a 30-day trial.
      </p>
      <form onSubmit={startSignup} className="space-y-4">
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Workspace name</span>
          <input
            className={inputCls}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="The Smith Family"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">
            Address <span className="font-normal text-text-muted">(optional — random if blank)</span>
          </span>
          <input
            className={inputCls}
            value={subdomain}
            onChange={(e) => setSubdomain(e.target.value.toLowerCase())}
            placeholder="smiths"
            autoCapitalize="none"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Email</span>
          <input
            className={inputCls}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            autoCapitalize="none"
          />
          <span className="mt-1 block text-xs text-text-muted">
            We'll email a code to verify it's really you.
          </span>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Admin username</span>
          <input
            className={inputCls}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoCapitalize="none"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Admin password</span>
          <input
            className={inputCls}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && <p className="text-sm text-red-500">{error}</p>}
        <button
          type="submit"
          disabled={busy || !email.trim() || !username.trim() || !password}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy && <Loader2 className="animate-spin" size={16} />}
          Continue
        </button>
      </form>
      <p className="mt-6 text-center text-sm text-text-muted">
        Already have one? <Link to="/" className="text-accent">Sign in</Link>
      </p>
    </div>
  );
}
