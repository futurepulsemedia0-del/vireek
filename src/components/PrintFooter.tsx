import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/**
 * Paper-only footer: the canonical URL plus a QR code, so a printed help
 * article or blog post can be traced back to the live page.
 * Hidden on screen (`.print-only`, defined in styles/print-documents.css).
 */
export function PrintFooter({ url, label = 'Read online' }: { url?: string; label?: string }) {
  const href = url ?? (typeof window !== 'undefined' ? window.location.href.split('#')[0]! : '');
  const [qr, setQr] = useState('');

  useEffect(() => {
    if (!href) return;
    let cancelled = false;
    QRCode.toDataURL(href, { width: 160, margin: 1, errorCorrectionLevel: 'M' })
      .then((d) => { if (!cancelled) setQr(d); })
      .catch(() => { if (!cancelled) setQr(''); });
    return () => { cancelled = true; };
  }, [href]);

  if (!href) return null;
  return (
    <footer className="print-only mt-8 flex items-center gap-4 border-t border-black pt-3" aria-hidden="true">
      {qr && <img src={qr} alt="" width={72} height={72} />}
      <p className="text-[9pt] leading-snug">
        <strong>{label}:</strong>
        <br />
        <span className="break-all">{href}</span>
      </p>
    </footer>
  );
}
