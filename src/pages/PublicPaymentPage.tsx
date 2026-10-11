import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { CircleCheck, Loader2, Lock, X } from 'lucide-react';
import { TipSelector } from '@/components/payments/TipSelector';
import { fetchPublicPayment, startPublicCheckout, type PublicPaymentSummary } from '@/lib/publicPayment';
import { computeTip, formatUsd, type TipSelection } from '@/lib/tipping';

export function PublicPaymentPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [params] = useSearchParams();
  const [summary, setSummary] = useState<PublicPaymentSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tip, setTip] = useState<TipSelection>({ kind: 'none' });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Pay securely';
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);

  useEffect(() => {
    let alive = true;
    fetchPublicPayment(token)
      .then((s) => alive && setSummary(s))
      .catch((e: Error) => alive && setLoadError(e.message));
    return () => {
      alive = false;
    };
  }, [token]);

  const effectiveTip: TipSelection = summary?.tip_enabled ? tip : { kind: 'none' };
  const tipResult = useMemo(
    () => (summary?.amount_cents ? computeTip(summary.amount_cents, effectiveTip) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [summary, tip],
  );

  async function handlePay() {
    if (!tipResult?.ok) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      window.location.assign(await startPublicCheckout(token, effectiveTip));
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
      setSubmitting(false);
    }
  }

  const shell = (children: React.ReactNode) => (
    <main className="flex min-h-screen items-center justify-center bg-bg-primary px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-border-primary bg-bg-secondary p-6 shadow-sm">{children}</div>
    </main>
  );

  if (loadError) return shell(<p role="alert" className="text-center text-sm text-danger">{loadError}</p>);
  if (!summary) return shell(<Loader2 className="mx-auto h-6 w-6 animate-spin text-text-secondary" aria-label="Loading" />);

  if (summary.status === 'paid') {
    return shell(
      <div className="text-center">
        <CircleCheck className="mx-auto mb-3 h-10 w-10 text-success" />
        <h1 className="text-lg font-bold text-text-primary">Already paid</h1>
        <p className="mt-1 text-sm text-text-secondary">Thank you — this invoice has been paid.</p>
      </div>,
    );
  }
  if (summary.status !== 'open' || !summary.amount_cents) {
    return shell(
      <div className="text-center">
        <X className="mx-auto mb-3 h-10 w-10 text-text-secondary" />
        <h1 className="text-lg font-bold text-text-primary">This payment link isn't available</h1>
        <p className="mt-1 text-sm text-text-secondary">It may have been canceled. Please contact the business.</p>
      </div>,
    );
  }

  const total = summary.amount_cents + (tipResult?.ok ? tipResult.tipCents : 0);

  return shell(
    <div className="space-y-5">
      <div>
        <p className="text-xs uppercase tracking-wider text-text-secondary">{summary.description}</p>
        <h1 className="mt-1 text-3xl font-bold text-text-primary">{formatUsd(summary.amount_cents)}</h1>
        {summary.customer_first_name && <p className="mt-1 text-sm text-text-secondary">Hi {summary.customer_first_name}, your invoice is ready.</p>}
      </div>

      {params.get('canceled') === '1' && <p className="rounded-lg bg-bg-tertiary px-3 py-2 text-xs text-text-secondary">No charge was made. You can try again below.</p>}

      {summary.tip_enabled && (
        <TipSelector baseCents={summary.amount_cents} presets={summary.presets ?? []} value={tip} onChange={setTip} disabled={submitting} technicianName={summary.technician_first_name} />
      )}

      <dl className="space-y-1 border-t border-border-primary pt-4 text-sm">
        <div className="flex justify-between text-text-secondary"><dt>Invoice</dt><dd>{formatUsd(summary.amount_cents)}</dd></div>
        {tipResult?.ok && tipResult.tipCents > 0 && <div className="flex justify-between text-text-secondary"><dt>Tip</dt><dd>{formatUsd(tipResult.tipCents)}</dd></div>}
        <div className="flex justify-between text-base font-bold text-text-primary"><dt>Total</dt><dd>{formatUsd(total)}</dd></div>
      </dl>

      {submitError && <p role="alert" className="text-sm text-danger">{submitError}</p>}

      <button
        type="button"
        onClick={handlePay}
        disabled={submitting || !tipResult?.ok}
        className="focus-ring flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-3.5 text-base font-semibold text-white disabled:opacity-50"
      >
        {submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : <Lock className="h-4 w-4" />}
        Pay {formatUsd(total)}
      </button>
      <p className="text-center text-xs text-text-secondary">Secure payment powered by Stripe. Your tip goes to your technician.</p>
    </div>,
  );
}
