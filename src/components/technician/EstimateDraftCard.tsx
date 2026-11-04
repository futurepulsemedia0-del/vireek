// Findings -> money (phase D): good/better/best DRAFT from an approved voice log, with a financing
// pre-check and a plain-language customer summary. Nothing is saved or sent from here.
import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, X } from 'lucide-react';
import type { FieldEstimateResult } from '@/lib/fieldEstimate';
import { monthlyPaymentCents } from '@/lib/estimates';
import { MIN_FINANCING_AMOUNT_CENTS, fetchFinancingConnection } from '@/lib/financing';
import { formatCents } from '@/lib/priceBook';
import { useVoiceLogT } from '@/i18n/voiceLogNamespace';
import { draftEstimateFromLog, financingPrecheck, summarizeDraft, type FinancingPrecheck } from '@/lib/voiceLog/findingsToMoney';
import type { VoiceExtraction } from '../../../supabase/functions/_shared/voice-log/extract';

type TFn = (key: string, opts?: Record<string, unknown>) => string;
type Phase = { k: 'idle' } | { k: 'busy' } | { k: 'error'; msg: 'draftFailed' | 'draftNotEnough' } | { k: 'ready'; result: FieldEstimateResult };
const TIER_KEY: Record<string, string> = { good: 'tierGood', better: 'tierBetter', best: 'tierBest' };
const btn = 'min-h-[56px] w-full rounded-lg bg-accent px-4 py-3 text-base font-semibold text-white disabled:opacity-50';

export function EstimateDraftCard({ extraction, onClose }: { extraction: VoiceExtraction; onClose: () => void }) {
  const { t } = useVoiceLogT();
  const tt = t as unknown as TFn;
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  const [summary, setSummary] = useState('');
  const [copied, setCopied] = useState(false);
  const [fin, setFin] = useState<FinancingPrecheck | null>(null);

  async function run() {
    setPhase({ k: 'busy' });
    try {
      const result = await draftEstimateFromLog(extraction);
      setSummary(result.diagnosis.customer_summary);
      setPhase({ k: 'ready', result });
    } catch (e) {
      setPhase({ k: 'error', msg: e instanceof Error && e.message === 'not_enough_detail' ? 'draftNotEnough' : 'draftFailed' });
    }
  }

  const ready = phase.k === 'ready' ? phase.result : null;
  const sum = ready ? summarizeDraft(ready) : null;
  const recommendedTotal = sum?.tiers.find((x) => x.recommended)?.totalCents ?? null;

  useEffect(() => {
    if (recommendedTotal === null) return undefined;
    let cancelled = false;
    void fetchFinancingConnection()
      .then((c) => { if (!cancelled) setFin(financingPrecheck(recommendedTotal, c?.status === 'connected', MIN_FINANCING_AMOUNT_CENTS)); })
      .catch(() => { if (!cancelled) setFin(financingPrecheck(recommendedTotal, false, MIN_FINANCING_AMOUNT_CENTS)); });
    return () => { cancelled = true; };
  }, [recommendedTotal]);

  async function copy() {
    try { await navigator.clipboard.writeText(summary); setCopied(true); window.setTimeout(() => setCopied(false), 2000); } catch { /* clipboard blocked */ }
  }

  return (
    <section className="space-y-3 rounded-lg border border-border bg-bg-secondary p-3" aria-labelledby="estimate-draft-title">
      <div className="flex items-center justify-between gap-2">
        <h2 id="estimate-draft-title" className="text-base font-semibold text-text-primary">{tt('draftEstimateTitle')}</h2>
        <button type="button" onClick={onClose} aria-label={tt('discard')} className="flex min-h-[48px] min-w-[48px] items-center justify-center rounded-md border border-border text-text-primary">
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>

      {phase.k === 'idle' && <button type="button" className={btn} onClick={() => void run()}>{tt('draftEstimateCta')}</button>}
      <div role="status" aria-live="polite">
        {phase.k === 'busy' && <p className="flex items-center gap-2 text-sm text-text-secondary"><Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />{tt('drafting')}</p>}
        {phase.k === 'error' && (
          <div className="space-y-2">
            <p className="flex items-center gap-1 text-sm font-medium text-danger"><AlertTriangle className="h-4 w-4" aria-hidden="true" />{tt(phase.msg)}</p>
            {phase.msg === 'draftFailed' && <button type="button" className={btn} onClick={() => void run()}>{tt('retry')}</button>}
          </div>
        )}
      </div>

      {ready && sum && (
        <>
          <p className="rounded-md bg-bg-tertiary p-2 text-sm font-medium text-text-primary">{tt('estimateAiLabel')}</p>
          {sum.safetyFlags.length > 0 && (
            <div role="note" className="space-y-1 text-sm font-medium text-danger">
              <p>{tt('estimateSafetyFlags')}</p>
              <ul className="list-disc ps-5">{sum.safetyFlags.map((f) => <li key={f}>{f}</li>)}</ul>
            </div>
          )}
          <ul className="space-y-2">
            {sum.tiers.map((x) => (
              <li key={x.tier} className={`flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 ${x.recommended ? 'border-accent' : 'border-border'}`}>
                <span className="text-base font-semibold text-text-primary">
                  {tt(TIER_KEY[x.tier] ?? 'tierBetter')}{x.recommended && <span className="ms-2 rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent">{tt('recommended')}</span>}
                </span>
                <span className="text-base font-semibold text-text-primary">{formatCents(x.totalCents)}</span>
                <span className={`w-full text-sm ${x.reviewLines ? 'text-warning-500' : 'text-success-500'}`}>
                  {x.reviewLines ? tt('reviewLines', { count: x.reviewLines }) : tt('allLinesFromBook')}
                </span>
              </li>
            ))}
          </ul>

          {fin && (
            <div className="space-y-1 rounded-md border border-border p-3 text-sm text-text-primary">
              <h3 className="font-semibold">{tt('financingTitle')}</h3>
              <p className="flex items-center gap-1">
                {fin.status === 'eligible' && <CheckCircle2 className="h-4 w-4 text-success-500" aria-hidden="true" />}
                {fin.status === 'eligible' ? tt('financingEligible') : fin.status === 'below_minimum' ? tt('financingBelowMin', { min: formatCents(fin.minCents) }) : tt('financingNotConnected')}
              </p>
              {fin.status === 'eligible' && recommendedTotal !== null && (
                <p className="text-text-secondary">{tt('financingMonthly', { amount: formatCents(monthlyPaymentCents(recommendedTotal)) })}</p>
              )}
            </div>
          )}

          <label className="block text-sm font-semibold text-text-primary">{tt('customerSummary')}
            <textarea className="mt-1 min-h-[96px] w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-base font-normal text-text-primary" value={summary} onChange={(e) => setSummary(e.target.value.slice(0, 2000))} />
          </label>
          <p className="text-sm text-text-secondary">{tt('customerSummaryNote')}</p>
          <button type="button" className="min-h-[48px] rounded-md border border-border px-4 py-2 text-base font-medium text-text-primary" onClick={() => void copy()}>
            {copied ? tt('copied') : tt('copySummary')}
          </button>
        </>
      )}
    </section>
  );
}
