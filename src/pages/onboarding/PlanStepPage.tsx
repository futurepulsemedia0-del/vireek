/**
 * Plan selection — /onboarding/plan
 *
 * Flow: sign up -> verify email -> THIS PAGE -> Stripe Checkout -> existing onboarding (/dashboard).
 * Protected, owners only. Everything about the plans comes from PRICING_PLANS; the trial/payment policy comes from the
 * server (plan_onboarding_config) so nothing about it is hard-coded here. This page never changes entitlements: after
 * Stripe it only WAITS for the verified webhook to show up in the account state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, Check, Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { trackEvent } from '@/lib/analytics';
import { COMPARE_ROWS, COMPARE_VALUES, PRICING_PLANS, type BillingCycle, type PricingPlan } from '@/lib/pricing';
import {
  clearDeepLink,
  deepLinkFromMetadata,
  readDeepLink,
  resolveInitialSelection,
  type SelectablePlanId,
} from '@/lib/planOnboarding/intent';
import { ASSUMED_MINUTES_PER_CALL, hasAnyAnswer, recommendPlan, type ReasonCode, type SizeAnswers } from '@/lib/planOnboarding/recommend';
import {
  SAFE_STATE,
  fetchPlanState,
  reconcilePlanCheckout,
  savePlanIntent,
  skipPlanStep,
  startPlanCheckout,
  type CheckoutErrorCode,
  type PlanOnboardingState,
} from '@/lib/planOnboarding/api';
import { TRIAL_DAYS } from '@/lib/planOnboarding/trial';
import { usePlanStepT } from '@/i18n/planStepNamespace';

const PLANS = PRICING_PLANS.filter((p) => p.id !== 'free') as (PricingPlan & { id: SelectablePlanId })[];
const usd = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
const CONFIRM_POLL_MS = 2000;
const CONFIRM_MAX_MS = 45_000;

type Notice = { tone: 'info' | 'error'; key: string } | null;
const ERROR_KEYS: Record<CheckoutErrorCode, string> = {
  rate_limited: 'errors.rateLimited',
  promo_invalid: 'errors.promoInvalid',
  annual_unavailable: 'errors.annualUnavailable',
  not_eligible: 'errors.notEligible',
  not_configured: 'errors.notConfigured',
  unavailable: 'errors.unavailable',
};

function toInt(v: string): number | null {
  if (!/^\d{1,7}$/.test(v.trim())) return null;
  return Number(v.trim());
}

export function PlanStepPage() {
  const { t } = usePlanStepT();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const [state, setState] = useState<PlanOnboardingState | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [billing, setBilling] = useState<BillingCycle>('monthly');
  const [selected, setSelected] = useState<SelectablePlanId | null>(null);
  const [calls, setCalls] = useState('');
  const [techs, setTechs] = useState('');
  const [locs, setLocs] = useState('');
  const [promo, setPromo] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<'checkout' | 'skip' | 'sales' | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmTimedOut, setConfirmTimedOut] = useState(false);
  const noticeRef = useRef<HTMLDivElement>(null);
  const viewedRef = useRef(false);
  const returnHandledRef = useRef(false);

  const checkoutParam = params.get('checkout');

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const s = await fetchPlanState();
      setState(s);
      return s;
    } catch {
      setLoadError(true);
      setState(null);
      return null;
    }
  }, []);

  // 1) Load state; owners without a subscription stay, everyone else goes straight on.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const s = await load();
      if (cancelled || !s) return;
      if (!s.canUseStep && checkoutParam !== 'success') {
        navigate('/dashboard', { replace: true });
        return;
      }
      const sel = resolveInitialSelection({
        urlPlan: params.get('plan'),
        urlBilling: params.get('billing'),
        server: { plan: s.plan, billing: s.billing },
        deepLink: readDeepLink(),
        metadata: deepLinkFromMetadata(user?.user_metadata),
      });
      setSelected(sel.plan);
      setBilling(sel.billing);
      setConsent(s.reminderConsent);
      setCalls(s.sizeAnswers.monthlyCalls?.toString() ?? '');
      setTechs(s.sizeAnswers.technicians?.toString() ?? '');
      setLocs(s.sizeAnswers.locations?.toString() ?? '');
      // A choice that arrived from a deep link / sign-up metadata / URL is stored server-side so it survives any device.
      if (sel.plan && sel.origin !== 'server' && s.canUseStep) {
        void savePlanIntent({ plan: sel.plan, billing: sel.billing, source: sel.origin === 'url' ? 'plan_step' : 'pricing_page' }).catch(() => undefined);
      }
      clearDeepLink();
      if (!viewedRef.current) {
        viewedRef.current = true;
        trackEvent('plan_step_viewed', { source: sel.origin, has_preselect: !!sel.plan });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2) Coming back from Stripe.
  useEffect(() => {
    if (!state || returnHandledRef.current) return;
    if (checkoutParam === 'success') {
      returnHandledRef.current = true;
      setConfirming(true);
      const started = Date.now();
      const timer = window.setInterval(async () => {
        try {
          const s = await fetchPlanState();
          if (!s.canUseStep && s.reason === 'subscribed') {
            window.clearInterval(timer);
            trackEvent('plan_checkout_completed', { plan_id: state.plan ?? 'unknown', billing: state.billing });
            navigate('/dashboard', { replace: true });
            return;
          }
        } catch {
          /* keep polling until the deadline */
        }
        if (Date.now() - started > CONFIRM_MAX_MS) {
          window.clearInterval(timer);
          setConfirming(false);
          setConfirmTimedOut(true);
        }
      }, CONFIRM_POLL_MS);
      return () => window.clearInterval(timer);
    }
    if (checkoutParam === 'cancelled') {
      returnHandledRef.current = true;
      trackEvent('plan_checkout_abandoned', { plan_id: state.plan ?? 'unknown', billing: state.billing, reason: 'cancelled' });
      setNotice({ tone: 'info', key: 'notices.cancelled' });
      void reconcilePlanCheckout();
      setParams({}, { replace: true });
      return;
    }
    if (state.step === 'checkout') {
      // They left the payment page without finishing and came back later (closed tab, other device).
      returnHandledRef.current = true;
      trackEvent('plan_checkout_abandoned', { plan_id: state.plan ?? 'unknown', billing: state.billing, reason: 'closed' });
      void reconcilePlanCheckout().then((o) => {
        if (o === 'expired') setNotice({ tone: 'info', key: 'notices.expired' });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, checkoutParam]);

  useEffect(() => {
    if (notice && noticeRef.current) noticeRef.current.focus();
  }, [notice]);

  const answers: SizeAnswers = useMemo(
    () => ({ monthlyCalls: toInt(calls), technicians: toInt(techs), locations: toInt(locs) }),
    [calls, techs, locs],
  );
  const suggestion = useMemo(() => recommendPlan(answers), [answers]);

  const policy = (state ?? SAFE_STATE).policy;
  const trialOn = !!state?.trialEligible && policy.trialMode !== 'none';
  const plan = PLANS.find((p) => p.id === selected) ?? null;
  const isEnterprise = plan?.monthly === null;

  const priceFor = (p: PricingPlan) => (billing === 'annual' ? p.annual : p.monthly);
  const persist = (next: { plan?: SelectablePlanId | null; billing?: BillingCycle; consent?: boolean }) => {
    const pl = next.plan ?? selected;
    if (!pl || !state?.canUseStep) return;
    void savePlanIntent({
      plan: pl,
      billing: next.billing ?? billing,
      source: 'plan_step',
      answers: hasAnyAnswer(answers) ? answers : null,
      reminderConsent: next.consent ?? consent,
    }).catch(() => undefined); // best effort: the choice still works locally and is saved again at checkout
  };

  const choose = (id: SelectablePlanId, method: 'card' | 'suggestion') => {
    setSelected(id);
    setNotice(null);
    trackEvent('plan_selected', { plan_id: id, billing, method });
    persist({ plan: id });
  };

  const onBilling = (b: BillingCycle) => {
    setBilling(b);
    persist({ billing: b });
  };

  const onContinue = async () => {
    if (!plan || busy) return;
    setNotice(null);
    if (isEnterprise) {
      setBusy('sales');
      await savePlanIntent({ plan: plan.id, billing, source: 'plan_step', step: 'sales', reminderConsent: consent }).catch(() => undefined);
      navigate('/enterprise');
      return;
    }
    setBusy('checkout');
    try {
      await savePlanIntent({ plan: plan.id, billing, source: 'plan_step', answers: hasAnyAnswer(answers) ? answers : null, reminderConsent: consent });
    } catch {
      /* not fatal: the server re-validates the plan at checkout */
    }
    const res = await startPlanCheckout({ plan: plan.id as Exclude<SelectablePlanId, 'enterprise'>, billing, promoCode: promo });
    if (res.kind === 'redirect') {
      trackEvent('plan_checkout_started', { plan_id: plan.id, billing, trial: trialOn });
      window.location.assign(res.url);
      return;
    }
    if (res.kind === 'already_subscribed') {
      setConfirming(true);
      const s = await load();
      if (s && !s.canUseStep) navigate('/dashboard', { replace: true });
      setConfirming(false);
      setBusy(null);
      return;
    }
    setNotice({ tone: 'error', key: ERROR_KEYS[res.code] });
    setBusy(null);
  };

  const onSkip = async () => {
    if (busy) return;
    setBusy('skip');
    try {
      await skipPlanStep();
      trackEvent('plan_step_skipped');
      navigate('/dashboard', { replace: true });
    } catch {
      setNotice({ tone: 'error', key: 'errors.unavailable' });
      setBusy(null);
    }
  };

  const reasonText = (r: ReasonCode, rec: NonNullable<typeof suggestion>) => {
    const planName = PLANS.find((p) => p.id === rec.planId)?.name ?? '';
    return t(`suggest.reason.${r}`, {
      plan: planName,
      seats: rec.needs.seats ?? 0,
      locations: rec.needs.locations ?? 0,
      minutes: rec.needs.minutes ?? 0,
      overage: rec.overageMinutes,
    });
  };

  // ---------------------------------------------------------------- render
  if (confirming || confirmTimedOut) {
    return (
      <main id="main-content" className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-4 px-6 text-center">
        {confirming ? (
          <div role="status" aria-live="polite" className="flex flex-col items-center gap-3">
            <Loader2 className="animate-spin text-accent" size={28} aria-hidden="true" />
            <h1 className="text-2xl font-bold text-text-primary">{t('confirm.title')}</h1>
            <p className="text-sm text-text-secondary">{t('confirm.body')}</p>
          </div>
        ) : (
          <div role="status" className="flex flex-col items-center gap-3">
            <h1 className="text-2xl font-bold text-text-primary">{t('confirm.slowTitle')}</h1>
            <p className="text-sm text-text-secondary">{t('confirm.slowBody')}</p>
            <Button onClick={() => navigate('/dashboard', { replace: true })}>{t('confirm.continue')}</Button>
          </div>
        )}
      </main>
    );
  }

  if (loadError) {
    return (
      <main id="main-content" className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="text-2xl font-bold text-text-primary">{t('loadError.title')}</h1>
        <p role="alert" className="text-sm text-text-secondary">{t('loadError.body')}</p>
        <div className="flex gap-3">
          <Button onClick={() => void load()}>{t('loadError.retry')}</Button>
          <Button variant="secondary" onClick={() => navigate('/dashboard', { replace: true })}>{t('loadError.dashboard')}</Button>
        </div>
      </main>
    );
  }

  if (!state) {
    return (
      <main id="main-content" aria-busy="true" className="mx-auto min-h-screen max-w-6xl px-4 py-10">
        <p className="sr-only" role="status">{t('loading')}</p>
        <div className="h-9 w-72 max-w-full rounded bg-bg-secondary" />
        <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-[26rem] rounded-2xl border border-border bg-bg-secondary" />)}
        </div>
      </main>
    );
  }

  const planPrice = plan && !isEnterprise ? priceFor(plan) : null;
  const periodWord = t(billing === 'annual' ? 'period.year' : 'period.month');
  const ctaLabel = isEnterprise
    ? t('cta.sales')
    : trialOn
      ? t('cta.startTrial', { days: TRIAL_DAYS })
      : t('cta.pay');

  return (
    <main id="main-content" className="mx-auto min-h-screen max-w-6xl px-4 py-8 sm:px-6 lg:py-12">
      <header className="max-w-2xl">
        <h1 className="text-3xl font-bold tracking-tight text-text-primary">{t('title')}</h1>
        <p className="mt-2 text-text-secondary">{t('subtitle')}</p>
      </header>

      {/* reserved height: notices never push the cards around */}
      <div className="mt-4 min-h-[3.25rem]" aria-live="polite">
        {notice && (
          <div
            ref={noticeRef}
            tabIndex={-1}
            role={notice.tone === 'error' ? 'alert' : 'status'}
            className={`rounded-lg border px-4 py-3 text-sm outline-none ${notice.tone === 'error' ? 'border-danger text-danger' : 'border-border text-text-primary'}`}
          >
            {t(notice.key)}
          </div>
        )}
      </div>

      {/* billing cycle */}
      <fieldset className="mt-4">
        <legend className="mb-2 text-sm font-medium text-text-primary">{t('billing.legend')}</legend>
        <div className="inline-flex rounded-lg border border-border p-1">
          {(['monthly', 'annual'] as const).map((b) => (
            <label key={b} className="relative">
              <input type="radio" name="billing" value={b} checked={billing === b} onChange={() => onBilling(b)} className="peer sr-only" />
              <span className="block min-h-[44px] cursor-pointer rounded-md px-4 py-2.5 text-sm font-medium text-text-secondary peer-checked:bg-accent peer-checked:text-white peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2">
                {t(`billing.${b}`)}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {/* right-size helper */}
      <section aria-labelledby="size-h" className="mt-8 rounded-2xl border border-border bg-bg-secondary p-4 sm:p-6">
        <h2 id="size-h" className="text-lg font-semibold text-text-primary">{t('size.title')}</h2>
        <p className="mt-1 text-sm text-text-secondary">{t('size.hint', { minutes: ASSUMED_MINUTES_PER_CALL })}</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {([
            ['calls', calls, setCalls, 'size.calls'],
            ['techs', techs, setTechs, 'size.technicians'],
            ['locs', locs, setLocs, 'size.locations'],
          ] as const).map(([id, value, set, key]) => (
            <div key={id}>
              <label htmlFor={`size-${id}`} className="block text-sm font-medium text-text-primary">{t(key)} <span className="font-normal text-text-muted">({t('size.optional')})</span></label>
              <input
                id={`size-${id}`}
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="off"
                value={value}
                onChange={(e) => set(e.target.value.replace(/[^\d]/g, '').slice(0, 7))}
                className="focus-ring mt-1 min-h-[44px] w-full rounded-lg border border-border bg-bg-primary px-3 text-text-primary"
              />
            </div>
          ))}
        </div>
        <div role="status" aria-live="polite" className="mt-4 min-h-[3rem] text-sm text-text-primary">
          {suggestion && (
            <div className="flex flex-wrap items-center gap-3">
              <p>
                <strong>{t('suggest.lead', { plan: PLANS.find((p) => p.id === suggestion.planId)?.name })}</strong>{' '}
                {suggestion.reasons.map((r) => reasonText(r, suggestion)).join(' ')}
              </p>
              {selected !== suggestion.planId && (
                <Button size="sm" variant="secondary" onClick={() => choose(suggestion.planId, 'suggestion')}>{t('suggest.use')}</Button>
              )}
            </div>
          )}
        </div>
        <p className="mt-1 text-xs text-text-muted">{t('suggest.editable')}</p>
      </section>

      {/* plan cards */}
      <fieldset className="mt-8">
        <legend className="mb-3 text-lg font-semibold text-text-primary">{t('plans.legend')}</legend>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {PLANS.map((p) => {
            const price = priceFor(p);
            const checked = selected === p.id;
            const saving = p.monthly !== null && p.annual !== null ? p.monthly * 12 - p.annual : 0;
            const badges = [
              p.recommended ? t('plans.popular') : null,
              suggestion?.planId === p.id ? t('plans.suggested') : null,
            ].filter(Boolean) as string[];
            return (
              <label key={p.id} className="relative block h-full">
                <input type="radio" name="plan" value={p.id} checked={checked} onChange={() => choose(p.id, 'card')} className="peer sr-only" />
                <span className="flex h-full cursor-pointer flex-col rounded-2xl border border-border bg-bg-secondary p-5 transition-colors peer-checked:border-accent peer-checked:ring-2 peer-checked:ring-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2">
                  <span className="flex min-h-[1.75rem] flex-wrap gap-2">
                    {badges.map((b) => <span key={b} className="rounded-full bg-accent/10 px-2.5 py-0.5 text-xs font-semibold text-accent">{b}</span>)}
                  </span>
                  <span className="mt-2 text-xl font-bold text-text-primary">{p.name}</span>
                  <span className="mt-1 text-sm text-text-secondary">{p.tagline}</span>
                  <span className="mt-4 block min-h-[4.5rem]">
                    {price === null ? (
                      <>
                        <span className="text-2xl font-bold text-text-primary">{t('plans.custom')}</span>
                        {p.startingAt ? <span className="block text-sm text-text-secondary">{t('plans.from', { price: usd(p.startingAt) })}</span> : null}
                      </>
                    ) : (
                      <>
                        <span className="text-3xl font-bold text-text-primary">{usd(billing === 'annual' ? Math.round(price / 12) : price)}</span>
                        <span className="text-sm text-text-secondary"> / {t('period.month')}</span>
                        <span className="block text-sm text-text-secondary">
                          {billing === 'annual' ? t('plans.billedYearly', { price: usd(price), saving: usd(saving) }) : t('plans.billedMonthly')}
                        </span>
                      </>
                    )}
                  </span>
                  <ul className="mt-4 space-y-1.5 text-sm text-text-primary">
                    {p.features.slice(0, 6).map((f) => (
                      <li key={f} className="flex gap-2"><Check size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" /><span>{f}</span></li>
                    ))}
                  </ul>
                  <span className="sr-only">{checked ? t('plans.selected') : ''}</span>
                </span>
              </label>
            );
          })}
        </div>
        <p className="mt-3 text-xs text-text-muted">{t('plans.taxNote')}</p>
      </fieldset>

      {/* plain comparison */}
      <section aria-labelledby="compare-h" className="mt-8">
        <h2 id="compare-h" className="text-lg font-semibold text-text-primary">{t('compare.title')}</h2>
        <div className="mt-3 overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[640px] text-sm">
            <caption className="sr-only">{t('compare.caption')}</caption>
            <thead>
              <tr className="bg-bg-secondary">
                <th scope="col" className="p-3 text-start font-medium text-text-secondary">{t('compare.feature')}</th>
                {PLANS.map((p) => <th key={p.id} scope="col" className="p-3 text-start font-semibold text-text-primary">{p.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {COMPARE_ROWS.map((row) => (
                <tr key={row.key} className="border-t border-border">
                  <th scope="row" className="p-3 text-start font-medium text-text-secondary">{row.label}</th>
                  {PLANS.map((p) => {
                    const direct = ({ minutes: p.minutes, overage: p.overage, seats: p.seats, locations: p.locations } as Record<string, string | null>)[row.key];
                    const v = direct !== undefined ? direct : COMPARE_VALUES[row.key]?.[p.id];
                    return (
                      <td key={p.id} className="p-3 text-text-primary">
                        {v === true ? t('compare.yes') : v === false || v === undefined || v === null ? t('compare.no') : v}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* terms shown BEFORE payment */}
      <section aria-labelledby="terms-h" className="mt-8 rounded-2xl border border-border p-4 sm:p-6">
        <h2 id="terms-h" className="text-lg font-semibold text-text-primary">{t('terms.title')}</h2>
        {!plan ? (
          <p className="mt-2 text-sm text-text-secondary">{t('terms.pick')}</p>
        ) : isEnterprise ? (
          <p className="mt-2 text-sm text-text-secondary">{t('terms.enterprise')}</p>
        ) : (
          <ul className="mt-2 list-disc space-y-1 ps-5 text-sm text-text-primary">
            <li>
              {trialOn && policy.trialMode === 'card_required' && t('terms.trialCard', { days: TRIAL_DAYS, price: usd(planPrice ?? 0), period: periodWord })}
              {trialOn && policy.trialMode === 'no_card' && t('terms.trialNoCard', { days: TRIAL_DAYS, price: usd(planPrice ?? 0), period: periodWord })}
              {!trialOn && t('terms.payNow', { price: usd(planPrice ?? 0), period: periodWord })}
            </li>
            <li>{t('terms.renews', { period: periodWord })}</li>
            <li>{t('terms.cancel')}</li>
            <li>{t('terms.tax')}</li>
          </ul>
        )}
        <p className="mt-3 text-sm text-text-secondary">
          {t('terms.links.lead')}{' '}
          <Link className="text-accent underline" to="/terms">{t('terms.links.terms')}</Link>,{' '}
          <Link className="text-accent underline" to="/refund-policy">{t('terms.links.refunds')}</Link>,{' '}
          <Link className="text-accent underline" to="/privacy">{t('terms.links.privacy')}</Link>.
        </p>

        {plan && !isEnterprise && (
          <div className="mt-4">
            <label htmlFor="promo" className="block text-sm font-medium text-text-primary">{t('promo.label')} <span className="font-normal text-text-muted">({t('size.optional')})</span></label>
            <input
              id="promo"
              value={promo}
              onChange={(e) => setPromo(e.target.value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40))}
              autoComplete="off"
              spellCheck={false}
              className="focus-ring mt-1 min-h-[44px] w-full max-w-xs rounded-lg border border-border bg-bg-primary px-3 text-text-primary"
            />
          </div>
        )}

        <Checkbox
          className="mt-4"
          label={t('reminder.label', { hours: policy.reminderDelayHours })}
          helperText={t('reminder.help')}
          checked={consent}
          onChange={(e) => { setConsent(e.target.checked); persist({ consent: e.target.checked }); }}
        />

        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Button size="lg" tone="cta" loading={busy === 'checkout' || busy === 'sales'} loadingLabel={t('cta.working')} disabled={!plan || !!busy} disabledReason={!plan ? t('cta.pickFirst') : undefined} onClick={() => void onContinue()}>
            {ctaLabel}
            <ArrowRight size={18} aria-hidden="true" className="rtl:rotate-180" />
          </Button>
          {policy.allowSkip && state.canUseStep && (
            <Button variant="ghost" size="lg" loading={busy === 'skip'} disabled={!!busy} onClick={() => void onSkip()}>{t('skip.label')}</Button>
          )}
        </div>
        {policy.allowSkip && <p className="mt-2 text-xs text-text-muted">{t('skip.help')}</p>}
      </section>
    </main>
  );
}

export default PlanStepPage;
