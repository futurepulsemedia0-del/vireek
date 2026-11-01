import { useState } from 'react';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { useTrustT } from '@/hooks/useTrustT';
import { generateIncidentId } from '@/lib/incident';
import { captureIncident } from '@/lib/incidentReporting';
import { verifyAuditChain, type ChainVerification } from '@/lib/trust/recordHistory';
import type { AppError } from '@/lib/trust/appError';

/** One-click "Verify integrity" for the owner's audit log (recomputes the hash chain server-side). */
export function AuditIntegrityBadge({ className = '' }: { className?: string }) {
  const { t } = useTrustT();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ChainVerification | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [brokenRef, setBrokenRef] = useState('');

  const run = async () => {
    setBusy(true);
    setError(null);
    const r = await verifyAuditChain();
    if (r.ok) {
      setResult(r.result);
      if (!r.result.ok) {
        // Never show the internal reason code: log it under a reference ID support can search.
        const ref = generateIncidentId();
        captureIncident(new Error(`audit chain ${r.result.reason ?? 'invalid'} at seq ${r.result.firstBadSeq ?? '?'}`), { incidentId: ref });
        setBrokenRef(ref);
      }
    } else setError(r.error);
    setBusy(false);
  };

  return (
    <div className={`flex flex-wrap items-center gap-3 text-sm ${className}`}>
      <button type="button" onClick={run} disabled={busy} className="focus-ring inline-flex items-center gap-2 rounded-xl border border-border px-3.5 py-2 text-sm font-medium text-text-primary hover:bg-bg-tertiary disabled:opacity-60">
        <ShieldCheck size={16} aria-hidden="true" />
        {busy ? t('history.verifying') : t('history.verify')}
      </button>
      <div role="status" aria-live="polite">
        {result?.ok && (
          <span className="inline-flex items-center gap-1.5 text-success-500">
            <ShieldCheck size={15} aria-hidden="true" /> {t('history.verified', { count: result.checked })}
            <span className="text-xs text-text-secondary"> · {t('history.legacyNote')}</span>
          </span>
        )}
        {result && !result.ok && (
          <span className="inline-flex items-center gap-1.5 text-danger">
            <ShieldAlert size={15} aria-hidden="true" /> {t('history.broken', { seq: result.firstBadSeq ?? 0, ref: brokenRef })}
          </span>
        )}
        {error && <span className="text-danger">{t(`error.${error.kind}.title`)} · {error.referenceId}</span>}
      </div>
    </div>
  );
}
