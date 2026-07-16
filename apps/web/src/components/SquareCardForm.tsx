import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { SquareConfig } from '@/lib/billing';
import { cn } from '@/lib/cn';
import { btnPrimary, ErrorText } from './ui/controls';

// Minimal shape of the Square Web Payments SDK we use.
interface SquareCard {
  attach: (el: HTMLElement) => Promise<void>;
  tokenize: () => Promise<{ status: string; token?: string; errors?: { message: string }[] }>;
  destroy: () => void;
}
interface SquarePayments {
  card: () => Promise<SquareCard>;
}
interface SquareSdk {
  payments: (appId: string, locationId: string) => SquarePayments;
}
declare global {
  interface Window {
    Square?: SquareSdk;
  }
}

const SDK_URLS: Record<string, string> = {
  sandbox: 'https://sandbox.web.squarecdn.com/v1/square.js',
  production: 'https://web.squarecdn.com/v1/square.js',
};

let sdkPromise: Promise<void> | null = null;
function loadSquareSdk(environment: string): Promise<void> {
  if (window.Square) return Promise.resolve();
  if (sdkPromise) return sdkPromise;
  const src = SDK_URLS[environment] ?? SDK_URLS.production;
  sdkPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load the Square payment SDK'));
    document.head.appendChild(s);
  });
  return sdkPromise;
}

/**
 * Square Web Payments SDK card form. Collects + tokenizes a card entirely on Square's
 * side (PCI-safe); the resulting single-use token is handed to onToken, which the
 * server exchanges for a card-on-file when creating the subscription.
 */
export function SquareCardForm({
  config,
  submitLabel,
  busy,
  onToken,
}: {
  config: SquareConfig;
  submitLabel: string;
  busy: boolean;
  onToken: (token: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<SquareCard | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tokenizing, setTokenizing] = useState(false);

  useEffect(() => {
    let canceled = false;
    (async () => {
      try {
        await loadSquareSdk(config.environment);
        if (canceled || !window.Square || !containerRef.current) return;
        const payments = window.Square.payments(config.appId, config.locationId);
        const card = await payments.card();
        if (canceled) return;
        await card.attach(containerRef.current);
        cardRef.current = card;
        setReady(true);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
    return () => {
      canceled = true;
      try {
        cardRef.current?.destroy();
      } catch {
        /* already gone */
      }
      cardRef.current = null;
    };
  }, [config.appId, config.locationId, config.environment]);

  async function pay() {
    if (!cardRef.current) return;
    setError(null);
    setTokenizing(true);
    try {
      const result = await cardRef.current.tokenize();
      if (result.status === 'OK' && result.token) {
        onToken(result.token);
      } else {
        setError(result.errors?.map((x) => x.message).join('; ') || 'Card was not accepted');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTokenizing(false);
    }
  }

  return (
    <div className="space-y-3">
      <div ref={containerRef} className="rounded-lg border border-border bg-surface p-2" />
      <ErrorText>{error}</ErrorText>
      <button
        onClick={pay}
        disabled={!ready || busy || tokenizing}
        className={cn(btnPrimary, 'justify-center')}
      >
        {(busy || tokenizing) && <Loader2 className="animate-spin" size={15} />}
        {submitLabel}
      </button>
      {config.environment === 'sandbox' && (
        <p className="text-xs text-text-faint">
          Sandbox: use test card 4111 1111 1111 1111, any future expiry, any CVV/ZIP.
        </p>
      )}
    </div>
  );
}
