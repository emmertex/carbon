import { useEffect, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { getDeviceId } from '@/lib/device';
import { saveServerConfig, getServerConfig } from '@/lib/config';
import {
  fetchMfaStatus,
  type MfaStatusResponse,
  revokeTrustedDevice,
  resetOwnDeviceTrust,
  regenerateRecoveryCodes,
  settingsEmailStart,
  settingsEmailConfirm,
  settingsTotpStart,
  settingsTotpConfirm,
  revokeAllSessionsAndTrust,
} from '@/lib/mfa';
import { QrCode } from '@/components/QrCode';
import { SettingsSection } from './SettingsSection';
import { ErrorText, Card, btnPrimary, btnIcon, inputCls } from './controls';

export function SecuritySection() {
  const [status, setStatus] = useState<MfaStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [emailChallenge, setEmailChallenge] = useState('');
  const [code, setCode] = useState('');
  const [totp, setTotp] = useState<{ secret: string; uri: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const myId = getDeviceId();

  async function reload() {
    try {
      setStatus(await fetchMfaStatus());
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function addEmail(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const ch = await settingsEmailStart(email.trim());
      setEmailChallenge(ch);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmEmail(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await settingsEmailConfirm(emailChallenge, code.trim());
      setEmailChallenge('');
      setCode('');
      setEmail('');
      await reload();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function startTotp() {
    setBusy(true);
    setError(null);
    try {
      setTotp(await settingsTotpStart());
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
      await settingsTotpConfirm(code.trim());
      setTotp(null);
      setCode('');
      await reload();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function issueRecovery() {
    if (!window.confirm('Replace unused recovery codes with a new set? Save the new codes immediately.'))
      return;
    setBusy(true);
    setError(null);
    try {
      setRecoveryCodes(await regenerateRecoveryCodes());
      await reload();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function resetTrust() {
    if (!window.confirm('Forget all trusted devices? The next sign-in on every device will ask for 2FA.'))
      return;
    setBusy(true);
    setError(null);
    try {
      await resetOwnDeviceTrust();
      await reload();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function signOutEverywhere() {
    if (
      !window.confirm(
        'Sign out everywhere and forget trusted devices? This device will stay signed in.',
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const token = await revokeAllSessionsAndTrust();
      saveServerConfig({ ...getServerConfig(), token });
      await reload();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    return (
      <SettingsSection id="security" title="Security">
        <p className="text-sm text-text-muted">Loading…</p>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection id="security" title="Security (2FA)">
      <p className="mb-3 text-sm text-text-muted">
        Two-factor authentication is required for sync accounts. Email and authenticator are
        backups of each other — either unlocks a new device. Devices stay trusted until you reset
        them.
      </p>

      <Card className="mb-3 divide-y divide-border">
        <div className="flex items-center justify-between px-3 py-2 text-sm">
          <span>Email</span>
          <span className={status.email_verified ? 'text-accent' : 'text-text-muted'}>
            {status.email_verified ? status.email : 'Not set'}
          </span>
        </div>
        <div className="flex items-center justify-between px-3 py-2 text-sm">
          <span>Authenticator</span>
          <span className={status.totp ? 'text-accent' : 'text-text-muted'}>
            {status.totp ? 'Enabled' : 'Not set'}
          </span>
        </div>
        <div className="flex items-center justify-between px-3 py-2 text-sm">
          <span>Recovery codes left</span>
          <span>{status.recovery_codes_remaining ?? 0}</span>
        </div>
      </Card>

      {!status.email_verified && !emailChallenge && (
        <form onSubmit={addEmail} className="mb-3 flex flex-wrap gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Backup email"
            className={inputCls}
          />
          <button type="submit" disabled={busy || !email.trim()} className={btnPrimary}>
            {busy && <Loader2 size={14} className="animate-spin" />} Add email
          </button>
        </form>
      )}
      {emailChallenge && (
        <form onSubmit={confirmEmail} className="mb-3 flex flex-wrap gap-2">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Email code"
            className={inputCls}
          />
          <button type="submit" disabled={busy || !code.trim()} className={btnPrimary}>
            Verify
          </button>
        </form>
      )}

      {!status.totp && !totp && (
        <button type="button" onClick={() => void startTotp()} disabled={busy} className={`${btnPrimary} mb-3`}>
          Add authenticator
        </button>
      )}
      {totp && (
        <form onSubmit={confirmTotp} className="mb-3 space-y-2">
          <QrCode value={totp.uri} size={160} />
          <p className="break-all font-mono text-xs">{totp.secret}</p>
          <div className="flex flex-wrap gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="6-digit code"
              className={inputCls}
            />
            <button type="submit" disabled={busy || !code.trim()} className={btnPrimary}>
              Confirm
            </button>
          </div>
        </form>
      )}

      <div className="mb-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => void issueRecovery()} disabled={busy} className={btnPrimary}>
          New recovery codes
        </button>
        <button type="button" onClick={() => void resetTrust()} disabled={busy} className={btnPrimary}>
          Reset device trust
        </button>
        <button type="button" onClick={() => void signOutEverywhere()} disabled={busy} className={btnPrimary}>
          Sign out everywhere
        </button>
      </div>

      {recoveryCodes && (
        <pre className="mb-3 overflow-auto rounded-lg border border-border bg-surface p-3 font-mono text-xs">
          {recoveryCodes.join('\n')}
        </pre>
      )}

      <h3 className="mb-2 text-sm font-medium">Trusted devices</h3>
      <Card className="mb-2 divide-y divide-border">
        {(status.devices ?? []).length === 0 && (
          <p className="px-3 py-2 text-sm text-text-muted">No trusted devices yet.</p>
        )}
        {(status.devices ?? []).map((d) => (
          <div key={d.device_id} className="flex items-center gap-2 px-3 py-2 text-sm">
            <span className="flex-1 truncate">
              {d.name || d.device_id}
              {d.device_id === myId && <span className="ml-1 text-xs text-accent">(this device)</span>}
            </span>
            {d.device_id !== myId && (
              <button
                type="button"
                className={btnIcon}
                title="Revoke trust"
                onClick={() =>
                  void revokeTrustedDevice(d.device_id)
                    .then(reload)
                    .catch((e) => setError(String(e)))
                }
              >
                <Trash2 size={15} />
              </button>
            )}
          </div>
        ))}
      </Card>

      <ErrorText className="mt-2">{error}</ErrorText>
    </SettingsSection>
  );
}
