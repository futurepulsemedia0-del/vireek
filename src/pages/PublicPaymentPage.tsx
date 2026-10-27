import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { CircleCheck, Loader2, X } from 'lucide-react';
import { PricingBreakdown } from '@/components/payments/PricingBreakdown';
import { PricingBreakdown } from '@/components/payments/PricingBreakdown';
import { buildReceiptLines } from '@/lib/paymentPricing';
import { TipSelector } from '@/components/payments/TipSelector';
import { createPublicPaymentIntent, fetchPublicPayment, type PublicPaymentSummary } from '@/lib/publicPayment';
import { StripePaymentForm, type PaymentOutcome } from '@/components/payments/StripePaymentForm';
import { buildReturnUrl } from '@/lib/paymentElement';
import { computeTip, formatUsd, type TipSelection } from '@/lib/tipping';

export function PublicPaymentPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [params] = useSearchParams();
  const [summary, setSummary] = useState<PublicPaymentSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tip, setTip] = useState<TipSelection>({ kind: 'none' });
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<PaymentOutcome | null>(null);
  const [autoRenew, setAutoRenew] = useState(false);

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
    const receipt = summary?.amount_cents
    ? buildReceiptLines({
        baseCents: summary.amount_cents,
        tipCents: tipResult?.ok ? tipResult.tipCents : 0,
        feeCents: summary.pricing?.fee_cents ?? 0,
        feeRefundedCents: 0,
        feeLabel: summary.pricing?.fee_label ?? '',
      })
    : null;

  async function createIntent(): Promise<string> {
    if (!tipResult?.ok) throw new Error('Please check the tip amount.');
    return createPublicPaymentIntent(token, effectiveTip, autoRenew && !!summary?.auto_renew_offer);
  }

  const shell = (children: React.ReactNode) => (
    <main className="flex min-h-screen items-center justify-center bg-bg-primary px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-border-primary bg-bg-secondary p-6 shadow-sm">{children}</div>
    </main>
  );

  if (loadError) return shell(<p role="alert" className="text-center text-sm text-danger">{loadError}</p>);
  if (!summary) return shell(<Loader2 className="mx-auto h-6 w-6 animate-spin text-text-secondary" aria-label="Loading" />);
  if (outcome) {
    return shell(
      <div className="text-center">
        <CircleCheck className="mx-auto mb-3 h-10 w-10 text-success" />
        <h1 className="text-lg font-bold text-text-primary">{outcome === 'succeeded' ? 'Payment received' : 'Payment processing'}</h1>
        <p className="mt-1 text-sm text-text-secondary">
          {outcome === 'succeeded'
            ? 'Thank you — your payment was successful. You can close this page.'
            : 'Thanks — your payment is being processed and we’ll confirm it shortly. You can close this page.'}
        </p>
        {receipt && <PricingBreakdown className="mt-5 text-left" lines={receipt.lines} totalCents={receipt.totalCents} totalLabel="Total paid" />}
      </div>,
    );
  }
  
  if (summary.status === 'paid') {
    return shell(
      <div className="text-center">
        <CircleCheck className="mx-auto mb-3 h-10 w-10 text-success" />
        <h1 className="text-lg font-bold text-text-primary">Already paid</h1>
        <p className="mt-1 text-sm text-text-secondary">Thank you — this invoice has been paid.</p>
        {summary.receipt && <PricingBreakdown className="mt-5 text-left" lines={summary.receipt.lines} totalCents={summary.receipt.totalCents} totalLabel="Total paid" />}
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

  const total = receipt?.totalCents ?? summary.amount_cents;

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

      {receipt && <PricingBreakdown className="border-t border-border-primary pt-4" lines={receipt.lines} totalCents={receipt.totalCents} />}

      {summary.pricing?.cash_price_cents != null && (
        <p className="text-sm font-medium text-text-primary">Cash or check price: {formatUsd(summary.pricing.cash_price_cents)}</p>
      )}
      {summary.pricing?.disclosure && (
        <p className="rounded-lg bg-bg-tertiary px-3 py-2 text-xs leading-relaxed text-text-secondary">{summary.pricing.disclosure}</p>
      )}
      
      {summary.auto_renew_offer && (
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border-primary p-3 text-sm text-text-secondary">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={autoRenew} disabled={submitting} onChange={(e) => setAutoRenew(e.target.checked)} />
          <span>
            <span className="font-medium text-text-primary">Renew automatically every {summary.auto_renew_offer.interval === 'monthly' ? 'month' : 'year'}</span>
            <br />
            Save this card and charge {formatUsd(summary.amount_cents)} at each renewal until I cancel. We’ll remind you before every renewal, and you can cancel anytime from the link in those messages.
          </span>
        </label>
      )}

      <StripePaymentForm
        key={autoRenew && summary.auto_renew_offer ? 'save' : 'once'}
        saveForFuture={autoRenew && !!summary.auto_renew_offer}
        publishableKey={summary.publishable_key}
        amountCents={total}
        payLabel={`Pay ${formatUsd(total)}`}
        returnUrl={buildReturnUrl(window.location.origin)}
        createIntent={createIntent}
        onSuccess={setOutcome}
        onProcessingChange={setSubmitting}
      />
