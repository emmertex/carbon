import { getServerConfig, authHeaders } from './config';
import {
  getDeviceId,
  getDeviceName,
  getDeviceTrustToken,
  setDeviceTrustToken,
} from './device';

function joinUrl(base: string, path: string): string {
  return base.replace(/\/$/, '') + path;
}

/** Persist the rotated device secret that came back with a login. Every response
 *  that trusts this device carries one; missing it just costs a 2FA prompt next
 *  time, so an older server that doesn't send one still works. */
function rememberTrust(url: string, token: string | undefined): void {
  if (token) setDeviceTrustToken(url, token);
}

function challengeHeaders(challenge: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${challenge}`,
  };
}

export type LoginStatus = 'ok' | 'open' | 'needs_enrollment' | 'needs_2fa';

export interface LoginOk {
  status: 'ok';
  token: string;
  recovery_codes?: string[];
}

export interface LoginOpen {
  status: 'open';
}

export interface LoginNeedsEnrollment {
  status: 'needs_enrollment';
  challenge: string;
}

export interface LoginNeeds2fa {
  status: 'needs_2fa';
  challenge: string;
  factors: { email: boolean; totp: boolean };
}

export type LoginResponse = LoginOk | LoginOpen | LoginNeedsEnrollment | LoginNeeds2fa;

export interface MfaStatusResponse {
  email: string | null;
  email_verified: boolean;
  totp: boolean;
  ready: boolean;
  factors: { email: boolean; totp: boolean };
  recovery_codes_remaining?: number;
  devices?: TrustedDevice[];
}

export interface TrustedDevice {
  device_id: string;
  name: string | null;
  created_at: string;
  last_used_at: string | null;
}

async function errMsg(res: Response, fallback: string): Promise<string> {
  const msg = ((await res.json().catch(() => ({}))) as { error?: string }).error;
  return msg || `${fallback}: ${res.status}`;
}

/** Password login step — may return a session, open mode, or an MFA challenge. */
export async function loginWithPassword(
  username: string,
  password: string,
): Promise<LoginResponse | { status: 'badCredentials' } | { status: 'error' }> {
  const cfg = getServerConfig();
  if (!cfg.url || !username) return { status: 'badCredentials' };
  try {
    const res = await fetch(joinUrl(cfg.url, '/api/login'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + btoa(`${username}:${password}`),
      },
      body: JSON.stringify({
        device_id: getDeviceId(),
        device_name: getDeviceName(),
        device_token: getDeviceTrustToken(cfg.url),
      }),
    });
    if (res.status === 401) return { status: 'badCredentials' };
    if (!res.ok) return { status: 'error' };
    const data = (await res.json()) as {
      token?: string;
      open?: boolean;
      status?: string;
      challenge?: string;
      factors?: { email: boolean; totp: boolean };
      recovery_codes?: string[];
      device_token?: string;
    };
    if (data.open) return { status: 'open' };
    if (data.token) {
      rememberTrust(cfg.url, data.device_token);
      return { status: 'ok', token: data.token, recovery_codes: data.recovery_codes };
    }
    if (data.status === 'needs_enrollment' && data.challenge) {
      return { status: 'needs_enrollment', challenge: data.challenge };
    }
    if (data.status === 'needs_2fa' && data.challenge) {
      return {
        status: 'needs_2fa',
        challenge: data.challenge,
        factors: data.factors ?? { email: false, totp: false },
      };
    }
    return { status: 'error' };
  } catch {
    return { status: 'error' };
  }
}

export async function mfaEnrollEmailStart(challenge: string, email: string): Promise<void> {
  const cfg = getServerConfig();
  const res = await fetch(joinUrl(cfg.url, '/api/mfa/enroll/email/start'), {
    method: 'POST',
    headers: challengeHeaders(challenge),
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new Error(await errMsg(res, 'could not send code'));
}

export async function mfaEnrollEmailConfirm(challenge: string, code: string): Promise<void> {
  const cfg = getServerConfig();
  const res = await fetch(joinUrl(cfg.url, '/api/mfa/enroll/email/confirm'), {
    method: 'POST',
    headers: challengeHeaders(challenge),
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error(await errMsg(res, 'invalid code'));
}

export async function mfaEnrollTotpStart(
  challenge: string,
): Promise<{ secret: string; uri: string }> {
  const cfg = getServerConfig();
  const res = await fetch(joinUrl(cfg.url, '/api/mfa/enroll/totp/start'), {
    method: 'POST',
    headers: challengeHeaders(challenge),
  });
  if (!res.ok) throw new Error(await errMsg(res, 'could not start authenticator'));
  return (await res.json()) as { secret: string; uri: string };
}

export async function mfaEnrollTotpConfirm(challenge: string, code: string): Promise<void> {
  const cfg = getServerConfig();
  const res = await fetch(joinUrl(cfg.url, '/api/mfa/enroll/totp/confirm'), {
    method: 'POST',
    headers: challengeHeaders(challenge),
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error(await errMsg(res, 'invalid code'));
}

export async function mfaEnrollFinish(
  challenge: string,
): Promise<{ token: string; recovery_codes?: string[] }> {
  const cfg = getServerConfig();
  const res = await fetch(joinUrl(cfg.url, '/api/mfa/enroll/finish'), {
    method: 'POST',
    headers: challengeHeaders(challenge),
    body: JSON.stringify({
      device_id: getDeviceId(),
      device_name: getDeviceName(),
      issue_recovery_codes: true,
    }),
  });
  if (!res.ok) throw new Error(await errMsg(res, 'could not finish enrollment'));
  const data = (await res.json()) as {
    token: string;
    recovery_codes?: string[];
    device_token?: string;
  };
  rememberTrust(cfg.url, data.device_token);
  return data;
}

export async function mfaLoginEmailSend(
  challenge: string,
): Promise<{ email_hint: string }> {
  const cfg = getServerConfig();
  const res = await fetch(joinUrl(cfg.url, '/api/mfa/login/email/send'), {
    method: 'POST',
    headers: challengeHeaders(challenge),
  });
  if (!res.ok) throw new Error(await errMsg(res, 'could not send code'));
  return (await res.json()) as { email_hint: string };
}

export async function mfaLoginVerify(
  challenge: string,
  factor: { totp?: string; email_code?: string; recovery_code?: string },
): Promise<{ token: string }> {
  const cfg = getServerConfig();
  const res = await fetch(joinUrl(cfg.url, '/api/mfa/login/verify'), {
    method: 'POST',
    headers: challengeHeaders(challenge),
    body: JSON.stringify({
      device_id: getDeviceId(),
      device_name: getDeviceName(),
      ...factor,
    }),
  });
  if (!res.ok) throw new Error(await errMsg(res, 'invalid code'));
  const data = (await res.json()) as { token: string; device_token?: string };
  rememberTrust(cfg.url, data.device_token);
  return data;
}

export async function fetchMfaStatus(): Promise<MfaStatusResponse> {
  const res = await fetch(joinUrl(getServerConfig().url, '/api/mfa/status'), {
    headers: authHeaders(getServerConfig()),
  });
  if (!res.ok) throw new Error(await errMsg(res, 'mfa status failed'));
  return (await res.json()) as MfaStatusResponse;
}

export async function revokeTrustedDevice(deviceId: string): Promise<void> {
  const res = await fetch(
    joinUrl(getServerConfig().url, `/api/mfa/devices/${encodeURIComponent(deviceId)}`),
    { method: 'DELETE', headers: authHeaders(getServerConfig()) },
  );
  if (!res.ok) throw new Error(await errMsg(res, 'revoke failed'));
}

export async function resetOwnDeviceTrust(): Promise<void> {
  const cfg = getServerConfig();
  const res = await fetch(joinUrl(cfg.url, '/api/mfa/devices/reset'), {
    method: 'POST',
    headers: authHeaders(cfg),
  });
  if (!res.ok) throw new Error(await errMsg(res, 'reset failed'));
  // Every trust just died server-side, including this device's — drop the stale
  // secret so the next login doesn't spend a failed-attempt slot proving it.
  setDeviceTrustToken(cfg.url, null);
}

export async function regenerateRecoveryCodes(): Promise<string[]> {
  const res = await fetch(joinUrl(getServerConfig().url, '/api/mfa/recovery-codes'), {
    method: 'POST',
    headers: authHeaders(getServerConfig()),
  });
  if (!res.ok) throw new Error(await errMsg(res, 'could not issue codes'));
  return ((await res.json()) as { codes: string[] }).codes;
}

export async function settingsEmailStart(email: string): Promise<string> {
  const res = await fetch(joinUrl(getServerConfig().url, '/api/mfa/settings/email/start'), {
    method: 'POST',
    headers: authHeaders(getServerConfig()),
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new Error(await errMsg(res, 'could not send code'));
  return ((await res.json()) as { challenge: string }).challenge;
}

export async function settingsEmailConfirm(challenge: string, code: string): Promise<void> {
  const res = await fetch(joinUrl(getServerConfig().url, '/api/mfa/settings/email/confirm'), {
    method: 'POST',
    headers: authHeaders(getServerConfig()),
    body: JSON.stringify({ challenge, code }),
  });
  if (!res.ok) throw new Error(await errMsg(res, 'invalid code'));
}

export async function settingsTotpStart(): Promise<{ secret: string; uri: string }> {
  const res = await fetch(joinUrl(getServerConfig().url, '/api/mfa/settings/totp/start'), {
    method: 'POST',
    headers: authHeaders(getServerConfig()),
  });
  if (!res.ok) throw new Error(await errMsg(res, 'could not start authenticator'));
  return (await res.json()) as { secret: string; uri: string };
}

export async function settingsTotpConfirm(code: string): Promise<void> {
  const res = await fetch(joinUrl(getServerConfig().url, '/api/mfa/settings/totp/confirm'), {
    method: 'POST',
    headers: authHeaders(getServerConfig()),
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error(await errMsg(res, 'invalid code'));
}

export async function revokeAllSessionsAndTrust(): Promise<string> {
  const cfg = getServerConfig();
  const res = await fetch(joinUrl(cfg.url, '/api/mfa/sessions/revoke-all'), {
    method: 'POST',
    headers: authHeaders(cfg),
    body: JSON.stringify({
      device_id: getDeviceId(),
      device_name: getDeviceName(),
    }),
  });
  if (!res.ok) throw new Error(await errMsg(res, 'revoke failed'));
  const data = (await res.json()) as { token: string; device_token?: string };
  rememberTrust(cfg.url, data.device_token);
  return data.token;
}
