import { useEffect, useState } from 'react';
import { Send, Copy, Check } from 'lucide-react';
import {
  getTelegramStatus,
  createTelegramCode,
  deleteTelegramLink,
  type TelegramStatus,
} from '@/lib/admin';
import { SettingsSection } from './settings/SettingsSection';
import { ErrorText, btnPrimary, btnSecondary } from './settings/controls';

export function Telegram() {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    try {
      setStatus(await getTelegramStatus());
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    void reload();
  }, []);

  async function connect() {
    setError(null);
    setBusy(true);
    try {
      const r = await createTelegramCode();
      setCode(r.code);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setError(null);
    setBusy(true);
    try {
      await deleteTelegramLink();
      setCode(null);
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copyCode() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable (insecure context) — the code is shown anyway */
    }
  }

  const botHandle = status?.botUsername ? `@${status.botUsername}` : 'the bot';

  return (
    <SettingsSection
      id="telegram"
      title="Telegram"
      description={
        <>
          Control Carbon from <strong>Telegram</strong>. Link your account, then message the bot in plain
          language — "add milk to my shopping list", "what's due tomorrow in the work project?", "untick my
          weekly shopping items". It uses the same AI agent as natural-language commands and acts as you.
        </>
      }
    >
      <div className="space-y-4">
        {!status ? (
          <p className="text-sm text-text-muted">Loading…</p>
        ) : !status.enabled ? (
          <p className="text-sm text-text-muted">
            No Telegram bot is configured on this server. An admin can set one up by creating a bot with{' '}
            <a
              href="https://t.me/BotFather"
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              @BotFather
            </a>{' '}
            and setting <code>TELEGRAM_BOT_TOKEN</code> (see the Telegram bot setup doc).
          </p>
        ) : status.link ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm">
              <Send size={14} className="text-success" />
              <span>
                Connected to {botHandle} as <strong>{status.link.username ?? 'you'}</strong>.
              </span>
            </div>
            <button onClick={disconnect} disabled={busy} className={btnSecondary}>
              Disconnect
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {!code ? (
              <button onClick={connect} disabled={busy} className={btnPrimary}>
                <Send size={14} /> Connect Telegram
              </button>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <code className="rounded-lg border border-border bg-surface-2 px-3 py-1.5 font-mono text-base tracking-widest">
                    {code}
                  </code>
                  <button
                    onClick={copyCode}
                    className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1.5 text-xs hover:bg-surface-2"
                    title="Copy code"
                  >
                    {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <ol className="list-decimal space-y-1 pl-5 text-sm text-text-muted">
                  <li>
                    Open Telegram and start a chat with {botHandle}
                    {status.botUsername && (
                      <>
                        {' '}
                        (
                        <a
                          href={`https://t.me/${status.botUsername}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-accent hover:underline"
                        >
                          open
                        </a>
                        )
                      </>
                    )}
                    .
                  </li>
                  <li>
                    Send <code>/start</code>, then send the code above (or <code>/link {code}</code>).
                  </li>
                </ol>
                <p className="text-xs text-text-faint">
                  The code expires in 10 minutes and can be used once. After linking, this section will show
                  your connection — reload to refresh.
                </p>
              </div>
            )}
          </div>
        )}

        <ErrorText>{error}</ErrorText>
      </div>
    </SettingsSection>
  );
}
