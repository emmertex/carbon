import { useState } from 'react';
import { ArrowLeft, Loader2, Copy, Check } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  getServerConfig,
  saveServerConfig,
  splitServerUrl,
  workspaceUrl,
} from '@/lib/config';
import { isNative } from '@/lib/platform';
import { useStore } from '@/lib/store';
import { signIn, syncNow, resetLocalDataAndReload, saveSessionToken } from '@/lib/sync';
import { localItemCount } from '@/lib/db';
import {
  mfaEnrollEmailStart,
  mfaEnrollEmailConfirm,
  mfaEnrollTotpStart,
  mfaEnrollTotpConfirm,
  mfaEnrollFinish,
  mfaLoginEmailSend,
  mfaLoginVerify,
} from '@/lib/mfa';
import { QrCode } from '@/components/QrCode';

type Step = 'url' | 'creds' | 'enroll' | 'challenge' | 'recovery' | 'merge';
type EnrollMode = 'pick' | 'email' | 'totp';
type ChallengeMode = 'totp' | 'email' | 'recovery';

/**
 * Full-screen sign-in. Reached when the configured server requires a login
 * (store.authRequired) or when the user opens it on demand (store.loginOpen).
 *
 * Steps: workspace URL → credentials → (enroll 2FA | challenge 2FA) → optional
 * recovery-code display → merge/replace local data.
 */
export function SignInGate() {
  const closeLogin = useStore((s) => s.closeLogin);
  const initial = splitServerUrl(
    getServerConfig().url || (isNative ? '' : window.location.origin),
  );
  const [step, setStep] = useState<Step>(getServerConfig().url ? 'creds' : 'url');
  const [workspace, setWorkspace] = useState(initial.workspace);
  const [domain, setDomain] = useState(initial.domain);
  const [username, setUsername] = useState(getServerConfig().username);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localCount, setLocalCount] = useState(0);

  const [challenge, setChallenge] = useState('');
  const [factors, setFactors] = useState({ email: false, totp: false });
  const [enrollMode, setEnrollMode] = useState<EnrollMode>('pick');
  const [challengeMode, setChallengeMode] = useState<ChallengeMode>('totp');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [emailHint, setEmailHint] = useState('');
  const [totpSecret, setTotpSecret] = useState('');
  const [totpUri, setTotpUri] = useState('');
  const [enrolledEmail, setEnrolledEmail] = useState(false);
  const [enrolledTotp, setEnrolledTotp] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);

  const inputCls =
    'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent';

  const resolvedUrl = workspaceUrl(workspace, domain);

  function continueToCreds(e: React.FormEvent) {
    e.preventDefault();
    if (!resolvedUrl) return;
    saveServerConfig({ ...getServerConfig(), url: resolvedUrl });
    setError(null);
    setStep('creds');
  }

  async function afterSession(): Promise<void> {
    const n = localItemCount();
    if (n > 0) {
      setLocalCount(n);
      setStep('merge');
      return;
    }
    closeLogin();
    void syncNow();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const current = getServerConfig();
    saveServerConfig({
      ...current,
      url: current.url || resolvedUrl,
      username: username.trim(),
    });
    const result = await signIn(password);
    setBusy(false);
    if (result === 'ok' || result === 'open') {
      await afterSession();
    } else if (result === 'error') {
      setError('Could not reach the server. Check the address and try again.');
    } else if (result === 'badCredentials') {
      setError('Sign-in failed — check your username and password.');
    } else if (result.status === 'needs_enrollment') {
      setChallenge(result.challenge);
      setEnrollMode('pick');
      setEnrolledEmail(false);
      setEnrolledTotp(false);
      setStep('enroll');
    } else {
      setChallenge(result.challenge);
      setFactors(result.factors);
      setChallengeMode(result.factors.totp ? 'totp' : result.factors.email ? 'email' : 'recovery');
      setStep('challenge');
    }
  }

  async function finishWithToken(token: string, codes?: string[]) {
    saveSessionToken(token);
    setPassword('');
    if (codes?.length) {
      setRecoveryCodes(codes);
      setStep('recovery');
      return;
    }
    await afterSession();
  }

  async function sendEnrollEmail(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await mfaEnrollEmailStart(challenge, email.trim());
      setEnrollMode('email');
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnrollEmail(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await mfaEnrollEmailConfirm(challenge, code.trim());
      setEnrolledEmail(true);
      setCode('');
      setEnrollMode('pick');
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function startTotpEnroll() {
    setBusy(true);
    setError(null);
    try {
      const { secret, uri } = await mfaEnrollTotpStart(challenge);
      setTotpSecret(secret);
      setTotpUri(uri);
      setEnrollMode('totp');
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmTotp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await mfaEnrollTotpConfirm(challenge, code.trim());
      setEnrolledTotp(true);
      setCode('');
      setEnrollMode('pick');
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function finishEnroll() {
    setBusy(true);
    setError(null);
    try {
      const { token, recovery_codes } = await mfaEnrollFinish(challenge);
      await finishWithToken(token, recovery_codes);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function sendLoginEmail() {
    setBusy(true);
    setError(null);
    try {
      const { email_hint } = await mfaLoginEmailSend(challenge);
      setEmailHint(email_hint);
      setChallengeMode('email');
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function verifyChallenge(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const factor =
        challengeMode === 'totp'
          ? { totp: code.trim() }
          : challengeMode === 'email'
            ? { email_code: code.trim() }
            : { recovery_code: code.trim() };
      const { token } = await mfaLoginVerify(challenge, factor);
      await finishWithToken(token);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  function mergeLocal() {
    closeLogin();
    void syncNow();
  }

  function replaceLocal() {
    setBusy(true);
    void resetLocalDataAndReload();
  }

  async function copyRecovery() {
    if (!recoveryCodes) return;
    await navigator.clipboard.writeText(recoveryCodes.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div
      className="flex h-full items-center justify-center bg-bg px-6 text-text"
      data-testid="sign-in"
    >
      <div className="w-full max-w-sm">
        {step === 'url' ? (
          <>
            <h1 className="mb-1 text-xl font-semibold">Connect to Carbon</h1>
            <p className="mb-6 text-sm text-text-muted">
              Enter your workspace name. Self-hosting? Change the server below.
            </p>
            <form onSubmit={continueToCreds} className="space-y-4">
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Workspace</span>
                <div className="flex items-stretch overflow-hidden rounded-lg border border-border bg-surface focus-within:border-accent">
                  <input
                    className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm outline-none"
                    value={workspace}
                    onChange={(e) =>
                      setWorkspace(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                    }
                    placeholder="smiths"
                    autoCapitalize="none"
                    autoCorrect="off"
                    autoFocus
                  />
                  <span className="flex select-none items-center whitespace-nowrap border-l border-border bg-bg px-3 text-sm text-text-muted">
                    .{domain}
                  </span>
                </div>
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Server</span>
                <input
                  className={inputCls}
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder="carbon.etx.sx"
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  required
                />
                <span className="mt-1 block text-xs text-text-muted">
                  {resolvedUrl ? (
                    <>
                      Connects to <span className="font-mono">{resolvedUrl}</span>
                    </>
                  ) : (
                    'The domain your Carbon server runs on.'
                  )}
                </span>
              </label>
              <button
                type="submit"
                disabled={!resolvedUrl}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                Continue
              </button>
            </form>
            <button
              onClick={closeLogin}
              className="mt-6 flex w-full items-center justify-center gap-1 text-sm text-text-muted hover:text-text"
            >
              <ArrowLeft size={15} /> Back to Carbon
            </button>
          </>
        ) : step === 'creds' ? (
          <>
            <h1 className="mb-1 text-xl font-semibold">Sign in to Carbon</h1>
            <p className="mb-6 text-sm text-text-muted">
              {getServerConfig().url || resolvedUrl || 'your Carbon server'}
            </p>
            <form onSubmit={submit} className="space-y-4">
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Username</span>
                <input
                  className={inputCls}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoCapitalize="none"
                  autoFocus
                  required
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Password</span>
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
                disabled={busy || !username.trim() || !password}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy && <Loader2 className="animate-spin" size={16} />}
                Sign in
              </button>
            </form>
            <div className="mt-6 flex items-center justify-between text-sm">
              <button
                onClick={() => {
                  setError(null);
                  setStep('url');
                }}
                className="flex items-center gap-1 text-text-muted hover:text-text"
              >
                <ArrowLeft size={15} /> Change server
              </button>
              <Link to="/signup" className="text-accent">
                Create one
              </Link>
            </div>
          </>
        ) : step === 'enroll' ? (
          <>
            <h1 className="mb-1 text-xl font-semibold">Set up two-factor authentication</h1>
            <p className="mb-6 text-sm text-text-muted">
              Required for sync accounts. Add an email code and/or an authenticator app — either
              works on a new device.
            </p>
            {enrollMode === 'pick' && (
              <div className="space-y-3">
                <div className="rounded-lg border border-border bg-surface px-3 py-2 text-sm">
                  <div className="flex justify-between">
                    <span>Email</span>
                    <span className={enrolledEmail ? 'text-accent' : 'text-text-muted'}>
                      {enrolledEmail ? 'Ready' : 'Not set'}
                    </span>
                  </div>
                  <div className="mt-1 flex justify-between">
                    <span>Authenticator</span>
                    <span className={enrolledTotp ? 'text-accent' : 'text-text-muted'}>
                      {enrolledTotp ? 'Ready' : 'Not set'}
                    </span>
                  </div>
                </div>
                {!enrolledEmail && (
                  <form onSubmit={sendEnrollEmail} className="space-y-2">
                    <input
                      className={inputCls}
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@example.com"
                      required
                    />
                    <button
                      type="submit"
                      disabled={busy || !email.trim()}
                      className="flex w-full items-center justify-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium disabled:opacity-50"
                    >
                      {busy && <Loader2 className="animate-spin" size={16} />}
                      Set up email
                    </button>
                  </form>
                )}
                {!enrolledTotp && (
                  <button
                    type="button"
                    onClick={() => void startTotpEnroll()}
                    disabled={busy}
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium disabled:opacity-50"
                  >
                    Set up authenticator app
                  </button>
                )}
                {error && <p className="text-sm text-red-500">{error}</p>}
                <button
                  type="button"
                  onClick={() => void finishEnroll()}
                  disabled={busy || (!enrolledEmail && !enrolledTotp)}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {busy && <Loader2 className="animate-spin" size={16} />}
                  Continue
                </button>
              </div>
            )}
            {enrollMode === 'email' && (
              <form onSubmit={confirmEnrollEmail} className="space-y-4">
                <p className="text-sm text-text-muted">
                  Enter the 6-digit code sent to <strong>{email.trim()}</strong>.
                </p>
                <input
                  className={inputCls}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  required
                />
                {error && <p className="text-sm text-red-500">{error}</p>}
                <button
                  type="submit"
                  disabled={busy || !code.trim()}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {busy && <Loader2 className="animate-spin" size={16} />}
                  Verify email
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEnrollMode('pick');
                    setError(null);
                  }}
                  className="flex w-full items-center justify-center gap-1 text-sm text-text-muted"
                >
                  <ArrowLeft size={15} /> Back
                </button>
              </form>
            )}
            {enrollMode === 'totp' && (
              <form onSubmit={confirmTotp} className="space-y-4">
                <p className="text-sm text-text-muted">
                  Scan this QR with your authenticator or password manager, or enter the secret
                  manually.
                </p>
                {totpUri && <QrCode value={totpUri} />}
                <div className="rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs break-all">
                  {totpSecret}
                </div>
                <button
                  type="button"
                  onClick={() => void navigator.clipboard.writeText(totpUri)}
                  className="text-xs text-accent"
                >
                  Copy otpauth URI
                </button>
                <input
                  className={inputCls}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="6-digit code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  required
                />
                {error && <p className="text-sm text-red-500">{error}</p>}
                <button
                  type="submit"
                  disabled={busy || !code.trim()}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {busy && <Loader2 className="animate-spin" size={16} />}
                  Verify authenticator
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEnrollMode('pick');
                    setError(null);
                  }}
                  className="flex w-full items-center justify-center gap-1 text-sm text-text-muted"
                >
                  <ArrowLeft size={15} /> Back
                </button>
              </form>
            )}
          </>
        ) : step === 'challenge' ? (
          <>
            <h1 className="mb-1 text-xl font-semibold">Verify it&apos;s you</h1>
            <p className="mb-6 text-sm text-text-muted">
              This device isn&apos;t trusted yet. Use any enrolled factor.
            </p>
            <div className="mb-4 flex flex-wrap gap-2 text-xs">
              {factors.totp && (
                <button
                  type="button"
                  onClick={() => {
                    setChallengeMode('totp');
                    setCode('');
                    setError(null);
                  }}
                  className={`rounded-full px-3 py-1 ${challengeMode === 'totp' ? 'bg-accent text-white' : 'bg-surface-2'}`}
                >
                  Authenticator
                </button>
              )}
              {factors.email && (
                <button
                  type="button"
                  onClick={() => void sendLoginEmail()}
                  className={`rounded-full px-3 py-1 ${challengeMode === 'email' ? 'bg-accent text-white' : 'bg-surface-2'}`}
                >
                  Email code
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setChallengeMode('recovery');
                  setCode('');
                  setError(null);
                }}
                className={`rounded-full px-3 py-1 ${challengeMode === 'recovery' ? 'bg-accent text-white' : 'bg-surface-2'}`}
              >
                Recovery code
              </button>
            </div>
            <form onSubmit={verifyChallenge} className="space-y-4">
              {challengeMode === 'email' && emailHint && (
                <p className="text-sm text-text-muted">
                  Code sent to <strong>{emailHint}</strong>
                </p>
              )}
              <input
                className={inputCls}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={
                  challengeMode === 'recovery' ? 'xxxx-xxxx-xxxx-xxxx' : '6-digit code'
                }
                autoComplete="one-time-code"
                autoFocus
                required
              />
              {error && <p className="text-sm text-red-500">{error}</p>}
              <button
                type="submit"
                disabled={busy || !code.trim()}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy && <Loader2 className="animate-spin" size={16} />}
                Verify
              </button>
            </form>
          </>
        ) : step === 'recovery' && recoveryCodes ? (
          <>
            <h1 className="mb-1 text-xl font-semibold">Save your recovery codes</h1>
            <p className="mb-4 text-sm text-text-muted">
              Store these somewhere safe. Each code works once if you lose email and authenticator
              access.
            </p>
            <pre className="mb-3 max-h-48 overflow-auto rounded-lg border border-border bg-surface p-3 font-mono text-xs">
              {recoveryCodes.join('\n')}
            </pre>
            <button
              type="button"
              onClick={() => void copyRecovery()}
              className="mb-4 flex w-full items-center justify-center gap-2 rounded-lg border border-border px-4 py-2 text-sm"
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? 'Copied' : 'Copy codes'}
            </button>
            <button
              type="button"
              onClick={() => void afterSession()}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
            >
              I&apos;ve saved them — continue
            </button>
          </>
        ) : (
          <>
            <h1 className="mb-1 text-xl font-semibold">You have local tasks on this device</h1>
            <p className="mb-6 text-sm text-text-muted">
              Signed in as <span className="font-medium text-text">{username.trim()}</span>. This
              device already has {localCount} local {localCount === 1 ? 'item' : 'items'}. What
              should happen to {localCount === 1 ? 'it' : 'them'}?
            </p>
            <div className="space-y-3">
              <button
                onClick={mergeLocal}
                disabled={busy}
                className="w-full rounded-lg border border-border bg-surface p-3 text-left hover:border-accent disabled:opacity-50"
              >
                <span className="block text-sm font-medium text-text">Merge with my account</span>
                <span className="mt-0.5 block text-xs text-text-muted">
                  Keep the tasks on this device and combine them with everything in your account.
                  Recommended for normal sign-in.
                </span>
              </button>
              <button
                onClick={replaceLocal}
                disabled={busy}
                className="flex w-full flex-col items-start rounded-lg border border-red-500/40 p-3 text-left hover:bg-red-500/10 disabled:opacity-50"
              >
                <span className="flex items-center gap-2 text-sm font-medium text-red-500">
                  {busy && <Loader2 className="animate-spin" size={14} />}
                  Replace with my account&apos;s data
                </span>
                <span className="mt-0.5 block text-xs text-text-muted">
                  Erase this device&apos;s {localCount} local {localCount === 1 ? 'item' : 'items'}{' '}
                  and re-download everything from the server. Use this if the local copy is wrong or
                  out of date.
                </span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
