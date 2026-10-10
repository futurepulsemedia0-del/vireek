/**
 * Customer-facing financing page — /financing/:token
 *
 * Token-gated (financing_offers.public_token), read-only. Shows where the
 * customer's financing application stands and sends them to the lending
 * partner's hosted flow to apply or confirm. Vireek never makes the credit
 * decision or holds the loan; this page only reflects the provider's status.
 * Reads only through the token-gated RPC in lib/financing.ts.
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { AlertCircle, Check, CheckCircle2, Clock, CreditCard, RefreshCw, XCircle } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/Skeleton';
import {
  PUBLIC_FINANCING_STEPS,
  estimateMonthlyPaymentCents,
  fetchPublicFinancingOffer,
  formatApr,
  formatFinancingAmount,
  getPublicFinancingPhase,
  getPublicFinancingSteps,
  isPublicFinancingPhaseFinal,
  isSafeApplicationUrl,
  type PublicFinancingPhase,
  type PublicFinancingResult,
} from '@/lib/financing';

const POLL_MS = 30_000;

const COPY: Record<PublicFinancingPhase, { title: string; body: string }> = {
  preparing: { title: 'Your financing offer is being prepared', body: 'This page updates automatically. Check back in a minute.' },
  ready: { title: 'Check your rate in about a minute', body: "Applying uses a soft credit check that won't affect your credit score, and there is no obligation to accept." },
  in_review: { title: 'Your application is in review', body: "The lending partner is reviewing your application. The decision will appear here as soon as it's ready." },
  approved: { title: "You're approved", body: 'Review your terms and confirm your loan with the lending partner to finish.' },
  confirmed: { title: 'Your financing is complete', body: 'Your loan is confirmed. No further action is needed here. Thank you.' },
  declined: { title: "We couldn't approve this application", body: "The lending partner wasn't able to approve financing this time and will send you the details of their decision. Please contact the business to arrange payment another way." },
  closed: { title: 'This offer is no longer active', body: "It has expired or was canceled. Contact the business if you'd still like to finance this job." },
};

export function FinancingOfferPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [searchParams] = useSearchParams();
  const returned = searchParams.get('returned');
  const [result, setResult] = useState<PublicFinancingResult | undefined>(undefined);

  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => {
      document.head.removeChild(meta);
    };
  }, []);

  const load = useCallback(async () => {
    const next = await fetchPublicFinancingOffer(token);
    // A transient network error must not blank a page that is already showing an offer.
    setResult((prev) => (next.state === 'error' && prev?.state === 'ok' ? prev : next));
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const phase = result?.state === 'ok' ? getPublicFinancingPhase(result.offer.status) : null;
  const shouldPoll = phase !== null && !isPublicFinancingPhaseFinal(phase);

  useEffect(() => {
    if (!shouldPoll) return;
    const refresh = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const id = setInterval(refresh, POLL_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [shouldPoll, load]);

  const retry = () => {
    setResult(undefined);
    void load();
  };

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="flex-1 px-4 py-8 sm:py-12">
        <div className="mx-auto w-full max-w-lg">
          {result === undefined && (
            <Card aria-busy="true" aria-label="Loading your financing offer">
              <Skeleton className="mx-auto h-4 w-40" />
              <Skeleton className="mx-auto mt-6 h-10 w-10 rounded-full" />
              <Skeleton className="mx-auto mt-4 h-5 w-56" />
              <Skeleton className="mx-auto mt-3 h-4 w-64" />
            </Card>
          )}

          {result?.state === 'not_found' && (
            <Card className="text-center">
              <AlertCircle size={28} className="mx-auto mb-3 text-text-secondary" aria-hidden />
              <h1 className="text-lg font-semibold text-text-primary">Financing offer not available</h1>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">This link isn't valid. Please contact the business that sent it to you.</p>
            </Card>
          )}

          {result?.state === 'error' && (
            <Card className="text-center">
              <AlertCircle size={28} className="mx-auto mb-3 text-danger" aria-hidden />
              <h1 className="text-lg font-semibold text-text-primary">We couldn't load your offer</h1>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">Check your connection and try again.</p>
              <Button className="mt-5" variant="secondary" onClick={retry}>
                <RefreshCw size={16} aria-hidden /> Try again
              </Button>
            </Card>
          )}

          {result?.state === 'ok' && phase && <OfferView offer={result.offer} phase={phase} returned={returned} />}
        </div>
      </main>
      <Footer />
    </div>
  );
}

function OfferView({ offer, phase, returned }: { offer: Extract<PublicFinancingResult, { state: 'ok' }>['offer']; phase: PublicFinancingPhase; returned: string | null }) {
  const copy = COPY[phase];
  const steps = getPublicFinancingSteps(phase);
  const applyUrl = isSafeApplicationUrl(offer.application_url) ? offer.application_url : null;
  const showCta = applyUrl !== null && (phase === 'ready' || phase === 'in_review' || phase === 'approved');
  const ctaLabel = phase === 'ready' ? 'Check my rate' : phase === 'approved' ? 'Review and confirm my loan' : 'View my application';
  const hasTerms = (phase === 'approved' || phase === 'confirmed') && offer.approved_amount_cents !== null;
  const amountCents = hasTerms ? (offer.approved_amount_cents as number) : offer.requested_amount_cents;
  const monthly = hasTerms ? estimateMonthlyPaymentCents(amountCents, offer.apr_bps, offer.term_months) : null;
  const good = phase === 'approved' || phase === 'confirmed';
  const Icon = good ? CheckCircle2 : phase === 'declined' ? XCircle : phase === 'in_review' || phase === 'preparing' ? Clock : CreditCard;
  const iconTone = good ? 'text-success-500' : phase === 'declined' ? 'text-danger' : 'text-accent';
  const business = offer.business_name ?? 'Your service provider';

  return (
    <div className="space-y-4">
      {returned === 'success' && (
        <p role="status" className="rounded-xl bg-success-500/10 px-4 py-3 text-sm text-success-500">
          Thanks for completing your application. This page shows your latest status.
        </p>
      )}
      {returned === 'cancel' && phase !== 'confirmed' && (
        <p role="status" className="rounded-xl bg-bg-tertiary px-4 py-3 text-sm text-text-secondary">
          You left the application before finishing. You can pick it up again whenever you're ready.
        </p>
      )}

      <Card className="text-center">
        <p className="break-words text-xs font-medium uppercase tracking-wide text-text-secondary">
          {business}
          {offer.service_type ? ` · ${offer.service_type}` : ''}
        </p>
        <Icon size={36} className={`mx-auto mt-4 ${iconTone}`} aria-hidden />
        <div aria-live="polite">
          <h1 className="mt-3 text-lg font-semibold text-text-primary">
            {offer.customer_first_name && phase === 'approved' ? `${offer.customer_first_name}, you're approved` : copy.title}
          </h1>
          <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-text-secondary">{copy.body}</p>
        </div>

        {phase !== 'closed' && phase !== 'declined' && (
          <div className="mt-6">
            <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{hasTerms ? 'Approved amount' : 'Financing requested'}</p>
            <p className="mt-1 text-3xl font-semibold text-text-primary">{formatFinancingAmount(amountCents)}</p>
          </div>
        )}

        {showCta && (
          <Button className="mt-6 w-full" size="lg" onClick={() => window.location.assign(applyUrl as string)}>
            {ctaLabel}
          </Button>
        )}
      </Card>

      {hasTerms && (
        <div className="rounded-xl border border-border bg-bg-secondary p-5">
          <h2 className="mb-3 text-sm font-semibold text-text-primary">Your terms</h2>
          <dl className="space-y-2 text-sm">
            <div className="flex items-center justify-between gap-4">
              <dt className="text-text-secondary">Rate</dt>
              <dd className="font-medium text-text-primary">{formatApr(offer.apr_bps)}</dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-text-secondary">Term</dt>
              <dd className="font-medium text-text-primary">{offer.term_months ? `${offer.term_months} months` : '—'}</dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-text-secondary">Estimated monthly payment</dt>
              <dd className="font-medium text-text-primary">{monthly !== null ? formatFinancingAmount(monthly) : '—'}</dd>
            </div>
          </dl>
        </div>
      )}

      {steps.length > 0 && (
        <div className="rounded-xl border border-border bg-bg-secondary p-5">
          <h2 className="mb-3 text-sm font-semibold text-text-primary">Progress</h2>
          <ol className="space-y-3">
            {PUBLIC_FINANCING_STEPS.map((label, i) => {
              const state = steps[i];
              const tone =
                state === 'done' ? 'bg-success-500/15 text-success-500' : state === 'failed' ? 'bg-danger/15 text-danger' : state === 'current' ? 'bg-accent/15 text-accent' : 'bg-bg-tertiary text-text-secondary/60';
              return (
                <li key={label} className="flex items-center gap-3 text-sm" aria-current={state === 'current' ? 'step' : undefined}>
                  <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${tone}`}>
                    {state === 'done' ? <Check size={14} aria-hidden /> : state === 'failed' ? <XCircle size={14} aria-hidden /> : <Clock size={14} aria-hidden />}
                  </span>
                  <span className={state === 'todo' ? 'text-text-secondary' : 'font-medium text-text-primary'}>
                    {label}
                    {state === 'failed' ? ' · not approved' : ''}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      <p className="px-2 text-center text-xs leading-relaxed text-text-secondary">
        Financing is offered by an independent lending partner and is subject to credit approval. {business} and Vireek don't make credit decisions or hold your loan. Any monthly payment shown is an estimate; your loan agreement has the final terms.
      </p>
      <p className="text-center text-xs text-text-secondary/70">Last updated {new Date(offer.updated_at).toLocaleString()}</p>
    </div>
  );
}
