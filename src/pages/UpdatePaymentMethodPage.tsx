import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { CreditCard, ShieldCheck, TriangleAlert as AlertTriangle, Loader as Loader2, ArrowLeft } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase } from '@/lib/supabase';

// ============================================================
// UpdatePaymentMethodPage
// ============================================================
//
// Reached from the dunning banner (PaymentFailedBanner) and from the
// escalation emails sent by supabase/functions/stripe-webhook. Its only
// job is to create a Stripe Billing Portal session scoped to updating the
// payment method (via create-billing-portal-session) and hand the customer
// off to it — card details are never entered anywhere in our own app, so
// there's nothing here to keep PCI-compliant beyond this redirect itself.
//
// Kept as its own route (rather than folding straight into BillingPage)
// so it can be linked directly from emails with a single, memorable URL,
// and so the "why are you here" framing below can speak specifically to
// someone arriving because a payment failed.

export function UpdatePaymentMethodPage() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'loading' | 'redirecting' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState('');

  const startPortalSession = useCallback(async () => {
    setStatus('loading');
    setErrorMessage('');
    try {
      const { data, error } = await supabase.functions.invoke<{ url?: string; error?: string }>(
        'create-billing-portal-session',
        { body: {} },
      );
      if (error || !data?.url) {
        throw new Error(data?.error || error?.message || 'Could not start the billing session.');
      }
      setStatus('redirecting');
      window.location.href = data.url;
    } catch (err) {
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    }
  }, []);

  useEffect(() => {
    startPortalSession();
  }, [startPortalSession]);

  const isPastDue = profile?.subscription_status === 'past_due';
  const isSuspended = profile?.subscription_status === 'suspended';

  return (
    <DashboardLayout activeLabel="Billing">
      <div className="mx-auto max-w-lg py-10">
        <button
          type="button"
          onClick={() => navigate('/dashboard/billing')}
          className="focus-ring mb-6 flex items-center gap-1.5 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
        >
          <ArrowLeft size={15} />
          Back to Billing
        </button>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          className="rounded-2xl border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark"
        >
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <CreditCard size={26} />
          </span>

          <h1 className="mt-5 text-xl font-bold text-text-primary">Update your payment method</h1>

          {(isPastDue || isSuspended) && (
            <div
              className={`mx-auto mt-4 flex max-w-sm items-start gap-2.5 rounded-xl border p-3 text-left text-sm ${
                isSuspended
                  ? 'border-danger/30 bg-danger/10 text-danger'
                  : 'border-warning-500/30 bg-warning-500/10 text-warning-500'
              }`}
            >
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>
                {isSuspended
                  ? "Your Vireek account is currently suspended because a payment couldn't be completed. Adding a new card will restore access automatically."
                  : "We couldn't process your last payment. Update your card below to keep Sarah answering your calls without interruption."}
              </span>
            </div>
          )}

          <p className="mx-auto mt-4 max-w-sm text-sm leading-relaxed text-text-secondary">
            {status === 'error'
              ? 'We hit a snag opening the secure payment page.'
              : "You'll be redirected to Stripe's secure payment page — your card details are never stored on Vireek's servers."}
          </p>

          {status === 'error' ? (
            <div className="mt-6 flex flex-col items-center gap-3">
              <p className="text-sm text-danger">{errorMessage}</p>
              <button
                type="button"
                onClick={startPortalSession}
                className="focus-ring rounded-xl bg-cta px-5 py-2.5 text-sm font-semibold text-white shadow-glow-cta transition-all duration-150 ease-out hover:brightness-110 active:brightness-95"
              >
                Try again
              </button>
              <p className="text-xs text-text-secondary">
                Still stuck?{' '}
                <a href="mailto:support@vireek.com" className="font-medium text-accent hover:underline">
                  Contact support
                </a>
              </p>
            </div>
          ) : (
            <div className="mt-6 flex items-center justify-center gap-2 text-sm font-medium text-text-secondary">
              <Loader2 size={16} className="animate-spin text-accent" aria-hidden="true" />
              {status === 'redirecting' ? 'Redirecting you to Stripe…' : 'Preparing your secure payment page…'}
            </div>
          )}

          <div className="mt-8 flex items-center justify-center gap-1.5 border-t border-border pt-5 text-xs text-text-secondary">
            <ShieldCheck size={13} className="text-accent" />
            Secured and PCI-compliant, powered by Stripe
          </div>
        </motion.div>
      </div>
    </DashboardLayout>
  );
}
