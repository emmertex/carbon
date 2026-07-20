import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/** Renders an otpauth (or any) URI as a QR code image. */
export function QrCode({ value, size = 180 }: { value: string; size?: number }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void QRCode.toDataURL(value, {
      width: size,
      margin: 1,
      color: { dark: '#111111', light: '#ffffff' },
    }).then((url) => {
      if (!cancelled) setDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (!dataUrl) {
    return (
      <div
        className="mx-auto rounded-lg bg-surface-2"
        style={{ width: size, height: size }}
        aria-hidden
      />
    );
  }
  return (
    <img
      src={dataUrl}
      alt="Authenticator QR code"
      width={size}
      height={size}
      className="mx-auto rounded-lg border border-border bg-white p-2"
    />
  );
}
