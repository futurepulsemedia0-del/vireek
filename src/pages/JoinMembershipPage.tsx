/**
 * Public membership signup — /join/:planSlug
 *
 * Anyone with the link can read the plan (token-style: the unguessable
 * slug + the owner's opt-in switch) and pay through Stripe Checkout. The
 * membership is created as "offered" by membership-join-checkout and is
 * activated by the Stripe webhook once the payment lands. Renewals are
 * invoiced by the membership lifecycle agent — customers are NOT charged
 * automatically, and this page says so.
 */

import { ChangeEvent, FormEvent, useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { AlertCircle, Check, CheckCircle2, Lock, RefreshCw } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/Skeleton';
import {
  JOIN_FAILURE_MESSAGES,
  fetchPublicMembershipPlan,
  formatPlanPrice,
  intervalNoun,
  monthlyEquivalentLabel,
  startMembershipCheckout,
  validateJoinForm,
  type JoinFormErrors,
  type JoinFormValues,
  type PublicMembershipPlan,
  type PublicMembershipPlanResult,
} from '@/lib/membershipJoin';

export function JoinMembershipPage() {
  const { planSlug = '' } = useParams<{ planSlug: string }>();
  const [searchParams] = useSearchParams();
  const checkout = searchParams.get('checkout');
  const [result, setResult] = useState<PublicMembershipPlanResult | undefined>(undefined);

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
    setResult(await fetchPublicMembershipPlan(planSlug));
  }, [planSlug]);

  useEffect(() => {
    void load();
  }, [load]);

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
            <Card aria-busy="true" aria-label="Loading membership">
              <Skeleton className="mx-auto h-4 w-40" />
              <Skeleton className="mx-auto mt-5 h-6 w-56" />
              <Skeleton className="mx-auto mt-4 h-10 w-32" />
              <Skeleton className="mt-6 h-4 w-full" />
              <Skeleton className="mt-3 h-4 w-5/6" />
            </Card>
          )}

          {result?.state === 'not_found' && (
            <Card className="text-center">
              <AlertCircle size={28} className="mx-auto mb-3 text-text-secondary" aria-hidden />
              <h1 className="text-lg font-semibold text-text-primary">Membership not available</h1>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">This link isn't valid, or this membership is no longer offered. Please contact the business that shared it with you.</p>
            </Card>
          )}

          {result?.state === 'error' && (
            <Card className="text-center">
              <AlertCircle size={28} className="mx-auto mb-3 text-danger" aria-hidden />
              <h1 className="text-lg font-semibold text-text-primary">We couldn't load this membership</h1>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">Check your connection and try again.</p>
              <Button className="mt-5" variant="secondary" onClick={retry}>
                <RefreshCw size={16} aria-hidden /> Try again
              </Button>
            </Card>
          )}

          {result?.state === 'ok' && <PlanView plan={result.plan} planSlug={planSlug} checkout={checkout} />}
        </div>
      </main>
      <Footer />
    </div>
  );
}

function PlanView({ plan, planSlug, checkout }: { plan: PublicMembershipPlan; planSlug: string; checkout: string | null }) {
  const [values, setValues] = useState<JoinFormValues>({ name: '', email: '', phone: '' });
  const [errors, setErrors] = useState<JoinFormErrors>({});
  const [honeypot, setHoneypot] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Coming back from Stripe with the browser's back button restores this page
  // from the back/forward cache with the button still disabled.
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) setSubmitting(false);
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  const business = plan.business_name ?? 'the business';
  const price = formatPlanPrice(plan.price_cents);
  const noun = intervalNoun(plan.billing_interval);
  const monthly = monthlyEquivalentLabel(plan.price_cents, plan.billing_interval);

  const setField = (field: keyof JoinFormValues) => (e: ChangeEvent<HTMLInputElement>) => {
    setValues((prev) => ({ ...prev, [field]: e.target.value }));
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const found = validateJoinForm(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSubmitting(true);
    setFormError(null);
    const res = await startMembershipCheckout(planSlug, values, honeypot);
    if (res.ok) {
      window.location.assign(res.url); // button stays disabled while the browser navigates
      return;
    }
    setFormError(JOIN_FAILURE_MESSAGES[res.reason]);
    setSubmitting(false);
  };

  if (checkout === 'success') {
    return (
      <Card className="text-center">
        <CheckCircle2 size={36} className="mx-auto text-success-500" aria-hidden />
        <h1 className="mt-3 text-lg font-semibold text-text-primary">Welcome to {plan.name}</h1>
        <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-text-secondary">
          Your payment went through and your membership is being activated. If you don't hear from {business} soon, please contact them directly.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {checkout === 'cancel' && (
        <p role="status" className="rounded-xl bg-bg-tertiary px-4 py-3 text-sm text-text-secondary">
          Checkout was canceled and you haven't been charged. You can try again whenever you're ready.
        </p>
      )}

      <Card className="text-center">
        <p className="break-words text-xs font-medium uppercase tracking-wide text-text-secondary">
          {business}
          {plan.service_type ? ` · ${plan.service_type}` : ''}
        </p>
        <h1 className="mt-3 break-words text-xl font-semibold text-text-primary">{plan.name}</h1>
        <p className="mt-4 text-4xl font-semibold text-text-primary">
          {price}
          <span className="text-base font-normal text-text-secondary"> / {noun}</span>
        </p>
        {monthly && <p className="mt-1 text-xs text-text-secondary">{monthly}</p>}
        {plan.visits_included_per_period > 0 && (
          <p className="mt-3 text-sm text-text-secondary">
            Includes {plan.visits_included_per_period} {plan.visits_included_per_period === 1 ? 'visit' : 'visits'} per {noun}
          </p>
        )}

        {plan.benefits.length > 0 && (
          <ul className="mt-5 space-y-2 text-left">
            {plan.benefits.map((benefit, i) => (
              <li key={i} className="flex items-start gap-2.5 text-sm text-text-primary">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success-500/15 text-success-500">
                  <Check size={12} aria-hidden />
                </span>
                <span className="break-words">{benefit}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {!plan.can_purchase ? (
        <div className="rounded-xl border border-border bg-bg-secondary p-5 text-center">
          <p className="text-sm font-semibold text-text-primary">Online signup isn't available right now</p>
          <p className="mt-1 text-sm text-text-secondary">Please contact {business} to join this membership.</p>
        </div>
      ) : (
        <form noValidate onSubmit={onSubmit} className="rounded-xl border border-border bg-bg-secondary p-5">
          <h2 className="mb-4 text-sm font-semibold text-text-primary">Your details</h2>
          <div className="space-y-4">
            <Input label="Full name" name="name" autoComplete="name" required value={values.name} onChange={setField('name')} error={errors.name} disabled={submitting} />
            <Input label="Email" name="email" type="email" inputMode="email" autoComplete="email" required value={values.email} onChange={setField('email')} error={errors.email} disabled={submitting} />
            <Input label="Phone (optional)" name="phone" type="tel" inputMode="tel" autoComplete="tel" value={values.phone} onChange={setField('phone')} error={errors.phone} disabled={submitting} />
            {/* Honeypot: hidden from people and assistive tech, bots tend to fill it. */}
            <div className="absolute -left-[9999px] h-0 w-0 overflow-hidden" aria-hidden="true">
              <label>
                Website
                <input type="text" name="website" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
              </label>
            </div>
          </div>

          {formError && (
            <p role="alert" className="mt-4 rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger">
              {formError}
            </p>
          )}

          <Button type="submit" size="lg" className="mt-5 w-full" disabled={submitting}>
            {submitting ? 'Opening secure checkout…' : `Pay ${price} and join`}
          </Button>

          <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-text-secondary">
            <Lock size={12} aria-hidden /> Secure payment by Stripe
          </p>
          <p className="mt-3 text-center text-xs leading-relaxed text-text-secondary">
            You pay {price} today. Before each renewal, {business} will send you a secure payment link. You won't be charged automatically.
          </p>
        </form>
      )}
    </div>
  );
}
