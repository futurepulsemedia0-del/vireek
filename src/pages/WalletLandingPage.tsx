/**
 * Public "Add to Wallet" landing — /w/:token
 * Linked from SMS and the customer portal. Detects the phone and offers Apple Wallet / Google Wallet.
 * The token is the only secret; the page shows nothing but the business name and pass type.
 */

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { Smartphone } from 'lucide-react';
import { fetchWalletLanding, walletFunctionBase } from '@/lib/walletPassesApi';
import { WALLET_KIND_META, detectDevice, type WalletLanding } from '@/lib/walletPasses';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function WalletLandingPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [landing, setLanding] = useState<WalletLanding | null | undefined>(undefined);
  const [qr, setQr] = useState('');
  const device = useMemo(() => detectDevice(navigator.userAgent, navigator.maxTouchPoints), []);
  const valid = UUID.test(token);

  useEffect(() => {
    if (!valid) { setLanding(null); return; }
    let live = true;
    fetchWalletLanding(token).then((l) => live && setLanding(l)).catch(() => live && setLanding(null));
    return () => { live = false; };
  }, [token, valid]);

  useEffect(() => {
    if (device === 'other' && valid) QRCode.toDataURL(window.location.href, { width: 200, margin: 1 }).then(setQr).catch(() => setQr(''));
  }, [device, valid]);

  const base = walletFunctionBase();
  const appleHref = `${base}/p/${token}.pkpass`;
  const googleHref = `${base}/g/${token}`;
  const meta = landing ? WALLET_KIND_META[landing.kind] : null;
  const unavailable = landing === null || landing?.status === 'voided';

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg-primary px-4 py-10">
      <div className="w-full max-w-sm rounded-3xl border border-border bg-bg-secondary p-6 text-center shadow-sm">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl text-white" style={{ background: landing?.color ?? '#2563EB' }}>
          <Smartphone className="h-7 w-7" aria-hidden />
        </div>

        {landing === undefined ? (
          <p className="mt-5 text-sm text-text-secondary" aria-busy="true">Loading…</p>
        ) : unavailable ? (
          <>
            <h1 className="mt-5 text-lg font-semibold text-text-primary">This pass isn&apos;t available</h1>
            <p className="mt-1 text-sm text-text-secondary">The link may have expired or been replaced. Please contact the business for a new one.</p>
          </>
        ) : (
          <>
            <p className="mt-5 text-xs font-medium uppercase tracking-wide text-text-secondary">{landing?.org_name}</p>
            <h1 className="mt-1 text-xl font-semibold text-text-primary">Add your {meta?.noun} to your phone</h1>
            <p className="mt-1 text-sm text-text-secondary">{meta?.description}</p>

            <div className="mt-6 space-y-3">
              {device !== 'android' && (
                <a href={appleHref} className="focus-ring flex h-12 items-center justify-center rounded-xl bg-black text-sm font-semibold text-white transition-opacity hover:opacity-90">
                  Add to Apple Wallet
                </a>
              )}
              {device !== 'ios' && (
                <a href={googleHref} className="focus-ring flex h-12 items-center justify-center rounded-xl border border-border bg-white text-sm font-semibold text-[#1f1f1f] transition-colors hover:bg-gray-50">
                  Add to Google Wallet
                </a>
              )}
            </div>

            {device === 'other' && qr && (
              <div className="mt-6 border-t border-border pt-5">
                <img src={qr} alt="QR code to open this page on your phone" width={160} height={160} className="mx-auto rounded-lg bg-white p-1" />
                <p className="mt-2 text-xs text-text-secondary">On a computer? Scan with your phone.</p>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}

export default WalletLandingPage;
