import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { MiniLoader } from '@/components/ui/MiniLoader';
import { previewClaim, submitClaim, type ClaimPreview, type ClaimResult } from '@/lib/capacityGuard/api';
import { CAPACITY_GUARD_NS } from '@/lib/capacityGuard/i18n';

/** Public, token-gated page behind the SMS link. Viewing never claims; only the button (POST) does. */
export function BackfillClaimPage() {
  const { t } = useTranslation(CAPACITY_GUARD_NS);
  const { token = '' } = useParams<{ token: string }>();
  const [preview, setPreview] = useState<ClaimPreview | null>(null);
  const [result, setResult] = useState<ClaimResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    previewClaim(token).then((p) => { if (live) setPreview(p); }).catch(() => { if (live) setPreview({ status: 'invalid' }); });
    return () => { live = false; };
  }, [token]);

  const claim = async () => {
    setBusy(true);
    try { setResult(await submitClaim(token)); } catch { setResult({ status: 'error' }); } finally { setBusy(false); }
  };

  const final = result?.status ?? (preview && preview.status !== 'available' ? preview.status : null);
  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center p-4">
      <Card interactive={false} className="w-full space-y-4 p-6 text-center">
        <h1 className="text-xl font-semibold text-text-primary">{t('claim.title')}</h1>
        <div aria-live="polite" className="space-y-3">
          {!preview && <div className="flex justify-center py-4" role="status"><MiniLoader size={20} /><span className="sr-only">{t('claim.loading')}</span></div>}
          {preview && !final && (
            <>
              <p className="text-sm text-text-secondary">{t('claim.available')}</p>
              <p className="text-lg font-semibold text-text-primary">{preview.slot_label}</p>
              {preview.service_type && <p className="text-sm text-text-secondary">{preview.service_type}</p>}
              <Button className="w-full" onClick={() => void claim()} loading={busy}>{t('claim.button')}</Button>
              <p className="text-xs text-text-secondary">{t('claim.hold')}</p>
            </>
          )}
          {final === 'claimed' && (<><p className="text-lg font-semibold text-text-primary">{t('claim.claimed')}</p><p className="text-sm text-text-secondary">{t('claim.claimedDesc', { slot: result?.slot_label ?? preview?.slot_label ?? '' })}</p></>)}
          {final === 'already_filled' && (<><p className="text-lg font-semibold text-text-primary">{t('claim.filled')}</p><p className="text-sm text-text-secondary">{t('claim.filledDesc')}</p></>)}
          {final === 'expired' && <p className="text-sm text-text-primary">{t('claim.expired')}</p>}
          {final === 'unavailable' && <p className="text-sm text-text-primary">{t('claim.unavailable')}</p>}
          {final === 'invalid' && <p className="text-sm text-text-primary">{t('claim.invalid')}</p>}
          {final === 'error' && <p className="text-sm text-danger">{t('claim.error')}</p>}
        </div>
      </Card>
    </main>
  );
}
