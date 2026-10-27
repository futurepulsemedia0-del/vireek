/**
 * Public pay page for ONE payer's share of a split invoice — /pay-share/:token
 *
 * The token is the payer's private link. They only ever see their own share,
 * the invoice number and the business; amounts come from the server. The
 * payment is booked into the invoice ledger by the Stripe webhook.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { CircleCheck, Loader2, TriangleAlert, X } from 'lucide-react';
import { StripePaymentForm, type PaymentOutcome } from '@/components/payments/StripePaymentForm';
import { buildReturnUrl } from '@/lib/paymentElement';
import { createSplitPaymentIntent, fetchPublicSplit, type PublicSplitReason, type PublicSplitSummary } from '@/lib/publicSplitPayment';
import { formatCents } from '@/lib/invoices';
import { SPLIT_ROLE_LABELS, type SplitRole } from '@/lib/invoiceSplit';

const BLOCKED_COPY: Record<PublicSplitReason, { title: string; body: string }> = {
  void: { title: 'This invoice was canceled', body: 'No payment is needed. Contact the business if you have questions.' },
  not_ready: { title: 'This invoice isn’t ready yet', body: 'The business hasn’t finalized it. Please try again later or contact them.' },
  changed: { title: 'This invoice was updated', body: 'The amount changed after your link was created. Please ask the business to send you a new link.' },
};

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg-primary px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-border-primary bg-bg-secondary p-6 shadow-sm">{children}</div>
    </main>
  );
}

function Notice({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="text-center">
      {icon}
      <h1 className="text-lg font-bold text-text-primary">{title}</h1>
      <p className="mt-1 text-sm text-text-secondary">{body}</p>
    </div>
  );
}

export function SplitPayerPayPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [summary, setSummary] = useState<PublicSplitSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<PaymentOutcome | null>(null);
  const [, setSubmitting] = useState(false);

  useEffect(() => {
    document.title = 'Pay your share';
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);

  useEffect(() => {
    let alive = true;
    setSummary(null);
    setLoadError(null);
    fetchPublicSplit(token)
      .then((s) => alive && setSummary(s))
      .catch((e: Error) => alive && setLoadError(e.message));
    return () => {
      alive = false;
    };
  }, [token]);

  if (loadError) {
    return (
      <Shell>
        <p role="alert" className="flex items-center justify-center gap-2 text-center text-sm text-danger">
          <TriangleAlert size={16} className="shrink-0" /> {loadError}
        </p>
      </Shell>
    );
  }
  if (!summary) {
    return (
      <Shell>
        <Loader2 className="mx-auto h-6 w-6 animate-spin text-text-secondary" aria-label="Loading" />
      </Shell>
    );
  }

  if (outcome) {
    return (
      <Shell>
        <Notice
          icon={<CircleCheck className="mx-auto mb-3 h-10 w-10 text-success" />}
          title={outcome === 'succeeded' ? 'Payment received' : 'Payment processing'}
          body={
            outcome === 'succeeded'
              ? 'Thank you — your payment was successful. You can close this page.'
              : 'Thanks — your payment is being processed and we’ll confirm it shortly. You can close this page.'
          }
        />
      </Shell>
    );
  }

  if (summary.status === 'paid') {
    return (
      <Shell>
        <Notice icon={<CircleCheck className="mx-auto mb-3 h-10 w-10 text-success" />} title="Your share is paid" body="Thank you — there is nothing left to pay on this link." />
      </Shell>
    );
  }

  if (summary.status === 'blocked') {
    const copy = BLOCKED_COPY[summary.reason ?? 'not_ready'] ?? BLOCKED_COPY.not_ready;
    return (
      <Shell>
        <Notice icon={<X className="mx-auto mb-3 h-10 w-10 text-text-secondary" />} title={copy.title} body={copy.body} />
      </Shell>
    );
  }

  const payable = summary.payable_cents ?? 0;
  if (summary.status !== 'open' || payable <= 0) {
    return (
      <Shell>
        <Notice icon={<X className="mx-auto mb-3 h-10 w-10 text-text-secondary" />} title="This payment link isn’t available" body="It may be incorrect or no longer active. Please contact the business." />
      </Shell>
    );
  }

  const roleLabel = SPLIT_ROLE_LABELS[summary.role as SplitRole] ?? null;
  const paid = summary.paid_cents ?? 0;

  return (
    <Shell>
      <div className="space-y-5">
        <div>
          <p className="text-xs uppercase tracking-wider text-text-secondary">
            Invoice {summary.invoice_number}
            {summary.business_name ? ` · ${summary.business_name}` : ''}
          </p>
          <h1 className="mt-1 text-3xl font-bold text-text-primary">{formatCents(payable)}</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Hi {summary.payer_name}, this is your share{roleLabel ? ` as ${roleLabel.toLowerCase()}` : ''}. Other parties pay their own portion separately.
          </p>
        </div>

        <dl className="space-y-1 border-t border-border-primary pt-4 text-sm">
          <div className="flex justify-between text-text-secondary"><dt>Your share</dt><dd>{formatCents(summary.share_cents ?? payable)}</dd></div>
          {paid > 0 && <div className="flex justify-between text-text-secondary"><dt>Already paid</dt><dd>−{formatCents(paid)}</dd></div>}
          <div className="flex justify-between text-base font-bold text-text-primary"><dt>Due now</dt><dd>{formatCents(payable)}</dd></div>
        </dl>

        <StripePaymentForm
          publishableKey={summary.publishable_key}
          amountCents={payable}
          payLabel={`Pay ${formatCents(payable)}`}
          returnUrl={buildReturnUrl(window.location.origin)}
          createIntent={() => createSplitPaymentIntent(token)}
          onSuccess={setOutcome}
          onProcessingChange={setSubmitting}
        />
      </div>
    </Shell>
  );
}
