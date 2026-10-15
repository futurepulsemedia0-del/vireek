import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { Loader2, Lock } from 'lucide-react';
import { getStripe } from '@/lib/stripeLoader';
import {
  GENERIC_PAYMENT_ERROR,
  PAYMENT_ELEMENT_OPTIONS,
  buildElementsOptions,
  describePaymentError,
  isValidPublishableKey,
  readAppearanceFromDom,
} from '@/lib/paymentElement';

export type PaymentOutcome = 'succeeded' | 'processing';

interface StripePaymentFormProps {
  /** Platform publishable key (pk_test_… / pk_live_…) served by the public-payment edge function. */
  publishableKey: string | null | undefined;
  /** Total to charge now (invoice + tip). Changing it updates the amount shown in Apple Pay / Google Pay. */
  amountCents: number;
  payLabel: string;
  /** Where redirect-based methods (3-D Secure, bank redirects) come back to. Wallets/cards stay on the page. */
  returnUrl: string;
  /** Creates the PaymentIntent on the server (called only after the form validates) and returns its client secret. */
  createIntent: () => Promise<string>;
  onSuccess: (outcome: PaymentOutcome) => void;
  onProcessingChange?: (processing: boolean) => void;
}

const UNAVAILABLE = 'Online payment isn’t available right now. Please contact the business.';

export function StripePaymentForm(props: StripePaymentFormProps) {
  const { publishableKey, amountCents } = props;
  const validKey = isValidPublishableKey(publishableKey);
  const stripePromise = useMemo(() => (validKey ? getStripe(publishableKey) : null), [validKey, publishableKey]);

  // Elements options are frozen at mount (react-stripe-js warns when they change);
  // later amount changes are applied with elements.update() inside the form.
  const optionsRef = useRef<ReturnType<typeof buildElementsOptions> | null>(null);
  if (!optionsRef.current) optionsRef.current = buildElementsOptions(amountCents, readAppearanceFromDom());

  if (!stripePromise) {
    return (
      <p role="alert" className="rounded-lg bg-bg-tertiary px-3 py-2 text-sm text-text-secondary">
        {UNAVAILABLE}
      </p>
    );
  }

  return (
    <Elements stripe={stripePromise} options={optionsRef.current}>
      <PaymentForm {...props} />
    </Elements>
  );
}

function PaymentForm({ amountCents, payLabel, returnUrl, createIntent, onSuccess, onProcessingChange }: StripePaymentFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [ready, setReady] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    elements?.update({ amount: amountCents });
  }, [elements, amountCents]);

  useEffect(() => {
    onProcessingChange?.(processing);
  }, [processing, onProcessingChange]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!stripe || !elements || inFlight.current) return;
    inFlight.current = true;
    setProcessing(true);
    setError(null);
    try {
      // Must be the first await: it validates the form and keeps the click's user-gesture for the wallet sheet.
      const { error: submitError } = await elements.submit();
      if (submitError) {
        setError(describePaymentError(submitError));
        return;
      }

      let clientSecret: string;
      try {
        clientSecret = await createIntent();
      } catch (err) {
        setError(err instanceof Error && err.message ? err.message : GENERIC_PAYMENT_ERROR);
        return;
      }

      const { error: confirmError, paymentIntent } = await stripe.confirmPayment({
        elements,
        clientSecret,
        confirmParams: { return_url: returnUrl },
        redirect: 'if_required',
      });
      if (confirmError) {
        setError(describePaymentError(confirmError));
        return;
      }
      if (paymentIntent?.status === 'succeeded' || paymentIntent?.status === 'processing') {
        onSuccess(paymentIntent.status);
        return;
      }
      setError(GENERIC_PAYMENT_ERROR);
    } catch {
      setError(GENERIC_PAYMENT_ERROR);
    } finally {
      inFlight.current = false;
      setProcessing(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" aria-busy={processing}>
      <div className="relative min-h-[120px]">
        {!ready && !loadFailed && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-text-secondary" aria-label="Loading secure payment form" />
          </div>
        )}
        <PaymentElement
          options={PAYMENT_ELEMENT_OPTIONS}
          onReady={() => setReady(true)}
          onLoadError={() => setLoadFailed(true)}
        />
      </div>

      {loadFailed && (
        <p role="alert" className="text-sm text-danger">
          The secure payment form couldn’t load. Check your connection or disable content blockers for this page, then reload.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={!stripe || !elements || !ready || processing}
        className="focus-ring flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-3.5 text-base font-semibold text-white disabled:opacity-50"
      >
        {processing ? <Loader2 className="h-5 w-5 animate-spin" /> : <Lock className="h-4 w-4" />}
        {processing ? 'Processing…' : payLabel}
      </button>
    </form>
  );
}
