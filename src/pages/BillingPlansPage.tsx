import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  Check,
  Clock,
  CreditCard,
  Loader as Loader2,
  Lock,
  Minus,
  Rocket,
  TriangleAlert as AlertTriangle,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton, SkeletonCard } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import { COMPARE_ROWS, COMPARE_VALUES, PRICING_PLANS, type PlanId, type PricingPlan } from '@/lib/pricing';
import {
  changeActionLabel,
  classifyPlanChange,
  computeUsageImpact,
  formatCardBrand,
  formatLongDate,
  formatMinor,
  isSelfServePlan,
  isStalePreviewError,
  type LivePrice,
  type PlanChangePreview,
  type SubscriptionState,
} from '@/lib/planChange';
import {
  applyPlanChange,
  cancelScheduledChange,
  fetchSubscriptionState,
  previewPlanChange,
  startPlanCheckout,
} from '@/lib/planChangeApi';

// ============================================================
// HELPERS
// ============================================================

const NAV_LABEL = 'Plans & Upgrades';

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function priceParts(plan: PricingPlan, live: LivePrice | undefined): { amount: string; suffix: string } {
  if (plan.id === 'enterprise') return { amount: `From $${plan.startingAt ?? 999}`, suffix: '/mo' };
  if (live) {
    return { amount: formatMinor(live.amountMinor, live.currency).replace(/[.,]00$/, ''), suffix: `/${live.interval}` };
  }
  return { amount: `$${plan.monthly ?? 0}`, suffix: '/mo' };
}

function compareValue(plan: PricingPlan, key: (typeof COMPARE_ROWS)[number]['key']): string | boolean {
  if (key === 'minutes') return plan.minutes;
  if (key === 'overage') return plan.overage ?? '—';
  if (key === 'seats') return plan.seats;
  if (key === 'locations') return plan.locations;
  return COMPARE_VALUES[key]?.[plan.id] ?? false;
}

// ============================================================
// PLAN CARD
// ============================================================

interface PlanCardProps {
  plan: PricingPlan;
  live: LivePrice | undefined;
  isCurrent: boolean;
  scheduledAt: string | null;
  kind: ReturnType<typeof classifyPlanChange> | null;
  blockReason: string | null;
  onSelect: (plan: PricingPlan) => void;
}

function PlanCard({ plan, live, isCurrent, scheduledAt, kind, blockReason, onSelect }: PlanCardProps) {
  const { amount, suffix } = priceParts(plan, live);

  let action: React.ReactNode;
  if (isCurrent) {
    action = (
      <Button variant="secondary" size="sm" className="w-full" disabled>
        Current plan
      </Button>
    );
  } else if (scheduledAt) {
    action = (
      <Button variant="secondary" size="sm" className="w-full" disabled>
        Starts {formatLongDate(scheduledAt)}
      </Button>
    );
  } else if (plan.id === 'enterprise') {
    action = (
      <Link
        to="/enterprise"
        className="focus-ring inline-flex min-h-[40px] w-full items-center justify-center rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-semibold text-text-primary transition-colors hover:border-accent/40 hover:bg-bg-tertiary"
      >
        Talk to sales
      </Link>
    );
  } else if (plan.id === 'free') {
    action = <p className="text-center text-xs text-text-secondary">To cancel a paid subscription, contact support.</p>;
  } else if (kind && kind !== 'same' && isSelfServePlan(plan.id)) {
    action = (
      <Button
        variant={kind === 'downgrade' ? 'secondary' : 'primary'}
        size="sm"
        className="w-full"
        disabled={blockReason !== null}
        title={blockReason ?? undefined}
        onClick={() => onSelect(plan)}
      >
        {changeActionLabel(kind, plan.name)}
      </Button>
    );
  }

  return (
    <Card
      className={`flex flex-col !p-6 ${isCurrent ? 'ring-2 ring-accent' : ''}`}
      aria-label={`${plan.name} plan`}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-bold text-text-primary">{plan.name}</h3>
        {isCurrent ? (
          <span className="rounded-full bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent">Current</span>
        ) : plan.recommended ? (
          <span className="rounded-full bg-success-500/10 px-2.5 py-1 text-xs font-medium text-success-500">
            Most popular
          </span>
        ) : null}
      </div>
      <p className="mt-3 text-3xl font-bold tracking-tight text-text-primary">
        {amount}
        <span className="text-sm font-normal text-text-secondary">{suffix}</span>
      </p>
      <p className="mt-1 text-xs text-text-secondary">
        {plan.minutes} included · {plan.seats} · {plan.locations}
      </p>
      <ul className="mt-4 flex-1 space-y-2">
        {plan.features.slice(0, 6).map((feature) => (
          <li key={feature} className="flex items-start gap-2 text-xs text-text-secondary">
            <Check size={14} className="mt-0.5 shrink-0 text-success-500" aria-hidden="true" />
            <span>{feature}</span>
          </li>
        ))}
      </ul>
      <div className="mt-5">{action}</div>
    </Card>
  );
}

// ============================================================
// CHANGE-PLAN DIALOG (preview + confirm)
// ============================================================

interface ChangePlanDialogProps {
  plan: PricingPlan;
  currentPlan: PricingPlan;
  minutesUsed: number;
  onClose: () => void;
  onApplied: (message: string) => void;
}

function ChangePlanDialog({ plan, currentPlan, minutesUsed, onClose, onApplied }: ChangePlanDialogProps) {
  const dialogRef = useFocusTrap(true);
  const [preview, setPreview] = useState<PlanChangePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEscapeToClose(!submitting, onClose);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    previewPlanChange(plan.id)
      .then((next) => {
        if (cancelled) return;
        setPreview(next);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPreview(null);
        setError(errorMessage(err, 'Could not load the price preview.'));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [plan.id, reloadKey]);

  const usageImpact = useMemo(() => computeUsageImpact(minutesUsed, plan), [minutesUsed, plan]);

  const handleConfirm = async () => {
    if (!preview || submitting) return;
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      if (preview.kind === 'new') {
        window.location.assign(await startPlanCheckout(plan.id));
        return; // leaving the page — keep the button locked
      }
      const result = await applyPlanChange(preview);
      onApplied(
        result.kind === 'upgrade'
          ? `You're now on the ${plan.name} plan.`
          : `Downgrade to ${plan.name} scheduled for ${formatLongDate(result.effectiveAt)}.`,
      );
    } catch (err) {
      if (isStalePreviewError(err)) {
        setNotice(errorMessage(err, 'The price changed. Please review it again.'));
        setReloadKey((key) => key + 1);
      } else {
        setError(errorMessage(err, 'Could not change your plan.'));
      }
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={submitting ? undefined : onClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="plan-change-title"
        tabIndex={-1}
        className="relative max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-border bg-bg-secondary p-5 shadow-card-hover focus:outline-none dark:shadow-card-hover-dark sm:rounded-2xl sm:p-6"
      >
        <h2 id="plan-change-title" className="text-lg font-bold text-text-primary">
          {currentPlan.name} → {plan.name}
        </h2>

        <div className="mt-4 space-y-4" aria-live="polite">
          {notice && (
            <p className="flex items-start gap-2 rounded-xl border border-warning-500/30 bg-warning-500/10 p-3 text-xs text-text-primary">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning-500" aria-hidden="true" />
              {notice}
            </p>
          )}

          {loading && (
            <div className="space-y-3" role="status" aria-label="Calculating your price">
              <Skeleton className="h-20 w-full rounded-xl" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          )}

          {!loading && error && (
            <div className="rounded-xl border border-danger/30 bg-danger/10 p-4" role="alert">
              <p className="text-sm text-text-primary">{error}</p>
              {!preview && (
                <Button variant="secondary" size="sm" className="mt-3" onClick={() => setReloadKey((key) => key + 1)}>
                  Try again
                </Button>
              )}
            </div>
          )}

          {!loading && preview && (
            <>
              {preview.kind === 'downgrade' ? (
                <div className="rounded-xl border border-border bg-bg-primary p-4">
                  <p className="text-xs text-text-secondary">Due today</p>
                  <p className="mt-1 text-3xl font-bold text-text-primary">{formatMinor(0, preview.currency)}</p>
                  <p className="mt-2 text-sm text-text-secondary">
                    You keep <span className="font-semibold text-text-primary">{currentPlan.name}</span> until{' '}
                    <span className="font-semibold text-text-primary">{formatLongDate(preview.effectiveAt)}</span>, then
                    switch to {plan.name} at {formatMinor(preview.newRecurringMinor, preview.currency)}/{preview.interval}.
                  </p>
                </div>
              ) : (
                <div className="rounded-xl border border-border bg-bg-primary p-4">
                  <p className="text-xs text-text-secondary">{preview.kind === 'new' ? 'Today' : 'Due today (prorated)'}</p>
                  <p className="mt-1 text-3xl font-bold text-text-primary">
                    {formatMinor(preview.dueNowMinor, preview.currency)}
                  </p>
                  {preview.kind === 'upgrade' && (
                    <p className="mt-2 text-sm text-text-secondary">
                      Then {formatMinor(preview.newRecurringMinor, preview.currency)}/{preview.interval} from{' '}
                      {formatLongDate(preview.nextBillingDate)}.
                    </p>
                  )}
                  {preview.kind === 'new' && (
                    <p className="mt-2 text-sm text-text-secondary">
                      Billed {formatMinor(preview.newRecurringMinor, preview.currency)}/{preview.interval}. You&apos;ll
                      finish on Stripe&apos;s secure checkout.
                    </p>
                  )}
                </div>
              )}

              {preview.lines.length > 0 && (
                <ul className="space-y-1.5 text-xs">
                  {preview.lines.map((line, index) => (
                    <li key={`${line.description}-${index}`} className="flex items-start justify-between gap-3">
                      <span className="text-text-secondary">{line.description}</span>
                      <span className={`shrink-0 font-medium ${line.amountMinor < 0 ? 'text-success-500' : 'text-text-primary'}`}>
                        {formatMinor(line.amountMinor, preview.currency)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {preview.creditMinor > 0 && (
                <p className="text-xs text-success-500">
                  {formatMinor(preview.creditMinor, preview.currency)} credit will be applied to your next invoice.
                </p>
              )}

              {preview.taxesApply && (
                <p className="text-xs text-text-secondary">Applicable taxes are calculated by Stripe and added to the invoice.</p>
              )}

              {preview.kind === 'downgrade' && usageImpact.exceedsTarget && (
                <p className="flex items-start gap-2 rounded-xl border border-warning-500/30 bg-warning-500/10 p-3 text-xs text-text-primary">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning-500" aria-hidden="true" />
                  <span>
                    You&apos;ve used {minutesUsed} min this month, more than {plan.name}&apos;s {plan.minutes}
                    {usageImpact.estimatedOverageUsd !== null
                      ? `. At this pace you'd pay about $${usageImpact.estimatedOverageUsd.toFixed(2)}/month in overage.`
                      : '.'}
                  </span>
                </p>
              )}

              {preview.kind === 'downgrade' && preview.hasDiscount && (
                <p className="text-xs text-text-secondary">
                  A promotional discount on your subscription applies to your current plan. Contact support if it should carry over.
                </p>
              )}
            </>
          )}
        </div>

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={handleConfirm} disabled={loading || !preview || submitting}>
            {submitting && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
            {preview
              ? changeActionLabel(preview.kind, plan.name, preview.dueNowMinor, preview.currency)
              : 'Confirm'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// COMPARISON TABLE
// ============================================================

function ComparisonTable({ currentPlanId }: { currentPlanId: PlanId }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-border bg-bg-secondary">
      <table className="w-full min-w-[720px] text-sm">
        <caption className="sr-only">Plan comparison</caption>
        <thead>
          <tr className="border-b border-border text-left text-xs text-text-secondary">
            <th scope="col" className="sticky left-0 bg-bg-secondary px-4 py-3 font-medium">
              Feature
            </th>
            {PRICING_PLANS.map((plan) => (
              <th
                key={plan.id}
                scope="col"
                className={`px-4 py-3 font-semibold ${plan.id === currentPlanId ? 'text-accent' : 'text-text-primary'}`}
              >
                {plan.name}
                {plan.id === currentPlanId && <span className="ml-1 text-[10px] font-medium uppercase">· current</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {COMPARE_ROWS.map((row) => (
            <tr key={row.key} className="border-b border-border/50 last:border-0">
              <th scope="row" className="sticky left-0 bg-bg-secondary px-4 py-3 text-left font-medium text-text-secondary">
                {row.label}
              </th>
              {PRICING_PLANS.map((plan) => {
                const value = compareValue(plan, row.key);
                return (
                  <td key={plan.id} className="px-4 py-3 text-text-primary">
                    {value === true ? (
                      <>
                        <Check size={16} className="text-success-500" aria-hidden="true" />
                        <span className="sr-only">Included</span>
                      </>
                    ) : value === false ? (
                      <>
                        <Minus size={16} className="text-text-secondary/60" aria-hidden="true" />
                        <span className="sr-only">Not included</span>
                      </>
                    ) : (
                      value
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function BillingPlansPage() {
  const { profile, profileLoading, isOwner, permissions, refreshProfile } = useAuth();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const canAccess = isOwner || permissions.can_view_billing;

  const [state, setState] = useState<SubscriptionState | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [target, setTarget] = useState<PricingPlan | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setStatus('loading');
    try {
      setState(await fetchSubscriptionState());
      setLoadError(null);
      setStatus('ready');
    } catch (err) {
      if (!silent) {
        setLoadError(errorMessage(err, 'Could not load your subscription.'));
        setStatus('error');
      }
    }
  }, []);

  useEffect(() => {
    if (canAccess && !profileLoading) void load();
  }, [canAccess, profileLoading, load]);

  // Returning from Stripe Checkout (?checkout=success|cancelled).
  useEffect(() => {
    const result = searchParams.get('checkout');
    if (!result) return;
    if (result === 'success') {
      toast('Payment received. Your plan is updating.', 'success');
      void refreshProfile();
      window.setTimeout(() => void load(true), 3500); // webhook may land a moment after the redirect
    } else if (result === 'cancelled') {
      toast('Checkout was cancelled. You have not been charged.', 'info');
    }
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams, toast, refreshProfile, load]);

  const currentPlanId = (state?.currentPlanId ?? profile?.plan ?? 'free') as PlanId;
  const currentPlan = PRICING_PLANS.find((p) => p.id === currentPlanId) ?? PRICING_PLANS[0];
  const hasSubscription = state?.hasSubscription ?? false;
  const paymentIssue = hasSubscription && profile != null && profile.subscription_status !== 'active';

  const blockReason: string | null = !state
    ? null
    : !state.canManage
      ? 'Only the account owner can change plans.'
      : paymentIssue
        ? 'Resolve your failed payment before changing plans.'
        : state.cancelAtPeriodEnd
          ? 'Your subscription is set to end this billing period.'
          : null;

  const minutesUsed = profile?.minutes_used_this_month ?? 0;
  const minutesIncluded = profile?.minutes_included ?? 0;
  const usagePercent = minutesIncluded > 0 ? Math.min(100, (minutesUsed / minutesIncluded) * 100) : 0;

  const handleApplied = (message: string) => {
    setTarget(null);
    toast(message, 'success');
    void refreshProfile();
    void load(true);
  };

  const handleCancelScheduled = async () => {
    setCancelling(true);
    try {
      await cancelScheduledChange();
      toast('Scheduled downgrade cancelled. You are staying on your current plan.', 'success');
      await load(true);
    } catch (err) {
      toast(errorMessage(err, 'Could not cancel the scheduled change.'), 'error');
    } finally {
      setCancelling(false);
    }
  };

  // ---- permission gate ----
  if (!profileLoading && !canAccess) {
    return (
      <DashboardLayout activeLabel={NAV_LABEL}>
        <EmptyState
          icon={Lock}
          title="You don't have access to this page"
          description="Billing access is restricted. Ask your account owner to grant you the “View Billing” permission."
        />
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel={NAV_LABEL}>
      <Link
        to="/dashboard/billing"
        className="focus-ring mb-4 inline-flex items-center gap-1.5 rounded-lg text-sm text-text-secondary transition-colors hover:text-text-primary"
      >
        <ArrowLeft size={14} aria-hidden="true" /> Back to billing
      </Link>

      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          <Rocket size={24} aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Plans &amp; Upgrades</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Compare plans and change yours. See the exact price before you confirm anything.
          </p>
        </div>
      </div>

      {(status === 'loading' || profileLoading) && (
        <div className="space-y-6" role="status" aria-label="Loading plans">
          <SkeletonCard rows={3} />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <SkeletonCard key={i} rows={4} withIcon={false} />
            ))}
          </div>
        </div>
      )}

      {status === 'error' && !profileLoading && (
        <EmptyState
          icon={AlertTriangle}
          title="We couldn't load your plans"
          description={loadError ?? undefined}
          action={{ label: 'Try again', onClick: () => void load() }}
        />
      )}

      {status === 'ready' && !profileLoading && state && (
        <div className="space-y-6">
          {paymentIssue && (
            <div className="flex flex-col gap-3 rounded-2xl border border-warning-500/30 bg-warning-500/10 p-4 sm:flex-row sm:items-center sm:justify-between" role="alert">
              <p className="flex items-start gap-2 text-sm text-text-primary">
                <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning-500" aria-hidden="true" />
                Your last payment didn&apos;t go through. Update your payment method to change plans.
              </p>
              <Link
                to="/dashboard/billing/update-payment"
                className="focus-ring inline-flex min-h-[40px] shrink-0 items-center justify-center rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-semibold text-text-primary hover:border-accent/40"
              >
                Update payment method
              </Link>
            </div>
          )}

          {state.scheduledChange && (
            <div className="flex flex-col gap-3 rounded-2xl border border-accent/30 bg-accent/5 p-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="flex items-start gap-2 text-sm text-text-primary">
                <Clock size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
                Your plan changes to{' '}
                <span className="font-semibold">
                  {PRICING_PLANS.find((p) => p.id === state.scheduledChange?.planId)?.name ?? state.scheduledChange.planId}
                </span>{' '}
                on {formatLongDate(state.scheduledChange.effectiveAt)}.
              </p>
              {state.canManage && (
                <Button variant="secondary" size="sm" onClick={handleCancelScheduled} disabled={cancelling}>
                  {cancelling && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
                  Keep {currentPlan.name}
                </Button>
              )}
            </div>
          )}

          {state.cancelAtPeriodEnd && (
            <p className="rounded-2xl border border-border bg-bg-secondary p-4 text-sm text-text-secondary">
              Your subscription ends on {formatLongDate(state.currentPeriodEnd)}. Plan changes are paused until you resume it.
            </p>
          )}

          <Card className="!p-6">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex-1">
                <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">Current plan</p>
                <h2 className="mt-1 text-xl font-bold text-text-primary">{currentPlan.name}</h2>
                <p className="mt-1 text-sm text-text-secondary">
                  {hasSubscription && state.currentAmountMinor !== null && state.currency
                    ? `${formatMinor(state.currentAmountMinor, state.currency)}/mo · renews ${formatLongDate(state.currentPeriodEnd)}`
                    : 'No paid subscription yet'}
                </p>
                {state.paymentMethod && (
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-text-secondary">
                    <CreditCard size={14} aria-hidden="true" />
                    {formatCardBrand(state.paymentMethod.brand)} •••• {state.paymentMethod.last4}
                  </p>
                )}
              </div>
              <div className="w-full sm:max-w-xs">
                <div className="mb-1.5 flex items-center justify-between text-xs">
                  <span className="font-medium text-text-secondary">Minutes this month</span>
                  <span className="font-semibold text-text-primary">
                    {minutesUsed} / {minutesIncluded}
                  </span>
                </div>
                <div
                  className="h-2.5 w-full overflow-hidden rounded-full bg-bg-tertiary"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(usagePercent)}
                  aria-label="Minutes used this month"
                >
                  <div
                    className={`h-full rounded-full transition-all ${usagePercent >= 90 ? 'bg-danger' : usagePercent >= 80 ? 'bg-warning-500' : 'bg-accent'}`}
                    style={{ width: `${usagePercent}%` }}
                  />
                </div>
              </div>
            </div>
          </Card>

          {blockReason && !paymentIssue && !state.cancelAtPeriodEnd && (
            <p className="text-xs text-text-secondary">{blockReason}</p>
          )}

          <section aria-labelledby="plans-heading">
            <h2 id="plans-heading" className="sr-only">
              Available plans
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
              {PRICING_PLANS.map((plan) => (
                <PlanCard
                  key={plan.id}
                  plan={plan}
                  live={state.prices[plan.id]}
                  isCurrent={plan.id === currentPlanId}
                  scheduledAt={state.scheduledChange?.planId === plan.id ? state.scheduledChange.effectiveAt : null}
                  kind={isSelfServePlan(plan.id) ? classifyPlanChange(currentPlanId, plan.id, hasSubscription) : null}
                  blockReason={blockReason}
                  onSelect={setTarget}
                />
              ))}
            </div>
          </section>

          <section aria-labelledby="compare-heading">
            <h2 id="compare-heading" className="mb-3 text-lg font-semibold text-text-primary">
              Compare plans
            </h2>
            <ComparisonTable currentPlanId={currentPlanId} />
          </section>

          <Card className="!p-6">
            <h2 className="text-sm font-semibold text-text-primary">How plan changes work</h2>
            <ul className="mt-3 space-y-2 text-sm text-text-secondary">
              <li>
                <span className="font-medium text-text-primary">Upgrades</span> take effect immediately. You pay only the prorated
                difference for the rest of this billing period.
              </li>
              <li>
                <span className="font-medium text-text-primary">Downgrades</span> start at the end of your billing period, so you keep
                what you&apos;ve paid for. You can cancel a scheduled downgrade any time before then.
              </li>
            </ul>
          </Card>
        </div>
      )}

      {target && (
        <ChangePlanDialog
          plan={target}
          currentPlan={currentPlan}
          minutesUsed={minutesUsed}
          onClose={() => setTarget(null)}
          onApplied={handleApplied}
        />
      )}
    </DashboardLayout>
  );
}
