import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { CreditCard, TrendingUp, TriangleAlert as AlertTriangle, ArrowUpRight, FileText, Loader as Loader2, Check, Clock, X, Lock, Receipt, Printer } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, Job } from '@/lib/supabase';
import { useKeyboardShortcut } from '@/lib/hooks';
import { formatMoney } from '@/lib/currency';
import { calculateVat } from '@/lib/tax';
import type { CurrencyCode } from '@/lib/currency';

// ============================================================
// CONSTANTS
// ============================================================

const PLANS = [
  {
    id: 'starter',
    name: 'Starter',
    price: 79,
    minutes: 400,
    overage: 0.20,
    features: ['400 included minutes/mo', 'AI call answering', 'Lead capture', 'Job scheduling'],
  },
  {
    id: 'professional',
    name: 'Professional',
    price: 199,
    minutes: 1500,
    overage: 0.15,
    features: ['1,500 included minutes/mo', 'Everything in Starter', 'Team management', 'Advanced analytics', 'Priority support'],
  },
  {
    id: 'business',
    name: 'Business',
    price: 399,
    minutes: 4000,
    overage: 0.12,
    features: ['4,000 included minutes/mo', 'Everything in Professional', 'Up to 3 business locations', 'Role-based team access', 'Dedicated Slack channel support'],
  },
] as const;

// ============================================================
// USAGE ALERT BANNER
// ============================================================

export function UsageAlertBanner({ onUpgrade }: { onUpgrade?: () => void }) {
  const { user, profile } = useAuth();
  const [dismissed, setDismissed] = useState(false);
  const [insightId, setInsightId] = useState<string | null>(null);

  const usagePercent = profile
    ? profile.minutes_included > 0
      ? Math.min(100, (profile.minutes_used_this_month / profile.minutes_included) * 100)
      : 0
    : 0;

  const shouldShow = usagePercent >= 80 && !dismissed;

  // Check for existing usage alert insight
  useEffect(() => {
    if (!user || !shouldShow) return;
    (async () => {
      const { data } = await supabase
        .from('ai_insights')
        .select('id')
        .eq('user_id', user.id)
        .eq('is_dismissed', false)
        .ilike('title', '%included minutes%')
        .order('created_at', { ascending: false })
        .limit(1);
      if (data && data.length > 0) {
        setInsightId(data[0].id);
      }
    })();
  }, [user, shouldShow]);

  const handleDismiss = async () => {
    setDismissed(true);
    if (insightId) {
      await supabase.from('ai_insights').update({ is_dismissed: true }).eq('id', insightId);
    }
  };

  if (!shouldShow) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="mb-6 flex items-center gap-4 rounded-2xl border border-warning-500/30 bg-warning-500/10 p-4"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-warning-500/15 text-warning-500">
        <AlertTriangle size={20} />
      </span>
      <div className="flex-1">
        <p className="text-sm font-semibold text-text-primary">
          You've used {Math.round(usagePercent)}% of your included minutes this month.
        </p>
        <p className="text-xs text-text-secondary">
          Consider upgrading to avoid overage charges.
        </p>
      </div>
      {onUpgrade && (
        <button
          type="button"
          onClick={onUpgrade}
          className="focus-ring flex shrink-0 items-center gap-1.5 rounded-xl bg-cta px-4 py-2 text-sm font-semibold text-white transition-all hover:brightness-110"
        >
          Upgrade Now <ArrowUpRight size={14} />
        </button>
      )}
      <button
        type="button"
        onClick={handleDismiss}
        className="focus-ring flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
        aria-label="Dismiss"
      >
        <X size={16} />
      </button>
    </motion.div>
  );
}

// ============================================================
// NO ACCESS STATE
// ============================================================

function NoAccess() {
  return (
    <DashboardLayout activeLabel="Billing">
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
          <Lock size={26} />
        </span>
        <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
          Billing access is restricted. Ask your account owner to grant you the "View Billing" permission.
        </p>
      </div>
    </DashboardLayout>
  );
}

// ============================================================
// MAIN BILLING PAGE
// ============================================================

export function BillingPage() {
  const navigate = useNavigate();
  const { user, profile, profileLoading, isOwner, permissions } = useAuth();
  const { toast } = useToast();

  const [jobs, setJobs] = useState<Job[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(true);
  const [stripeReady] = useState(false); // Stripe not configured yet
  const [showPlans, setShowPlans] = useState(false);
  const [processingPlan, setProcessingPlan] = useState<string | null>(null);

  const canAccess = isOwner || permissions.can_view_billing;

  useKeyboardShortcut({
    key: '/', handler: () => navigate('/dashboard'), enabled: canAccess,
  });

  const loadJobs = useCallback(async () => {
    if (!user) return;
    setLoadingJobs(true);
    try {
      const { data, error } = await supabase
        .from('jobs')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      if (data) setJobs(data as Job[]);
    } catch {
      // empty state
    } finally {
      setLoadingJobs(false);
    }
  }, [user]);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  useEffect(() => {
    if (!profileLoading && profile && !profile.onboarding_completed) {
      navigate('/onboarding', { replace: true });
    }
  }, [profile, profileLoading, navigate]);

  // Usage alert: insert ai_insight when crossing 80%
  useEffect(() => {
    if (!user || !profile) return;
    const usagePercent = profile.minutes_included > 0
      ? (profile.minutes_used_this_month / profile.minutes_included) * 100
      : 0;
    if (usagePercent < 80) return;

    (async () => {
      // Check if alert already exists and is not dismissed
      const { data: existing } = await supabase
        .from('ai_insights')
        .select('id')
        .eq('user_id', user.id)
        .ilike('title', '%included minutes%')
        .order('created_at', { ascending: false })
        .limit(1);

      if (existing && existing.length > 0) return;

      await supabase.from('ai_insights').insert({
        user_id: user.id,
        insight_type: 'alert',
        title: 'Minutes usage approaching plan limit',
        description: `You've used ${Math.round(usagePercent)}% of your included minutes this month (${profile.minutes_used_this_month} of ${profile.minutes_included}). Consider upgrading to avoid overage charges.`,
      });
    })();
  }, [user, profile]);

  const currentPlan = useMemo(
    () => PLANS.find((p) => p.id === profile?.plan) ?? PLANS[0],
    [profile],
  );

  const usagePercent = profile
    ? profile.minutes_included > 0
      ? Math.min(100, (profile.minutes_used_this_month / profile.minutes_included) * 100)
      : 0
    : 0;

  const minutesRemaining = profile
    ? Math.max(0, profile.minutes_included - profile.minutes_used_this_month)
    : 0;

  // Customer invoices from jobs
  const invoiceCurrency = (profile?.invoice_currency ?? 'USD') as CurrencyCode;
  const invoicedJobs = useMemo(
    () => jobs.filter((j) => j.invoice_status !== 'not_sent' || j.invoice_amount !== null),
    [jobs],
  );
    const invoicedJobsWithTax = useMemo(
    () => invoicedJobs.map((j) => {
      const subtotal = j.invoice_amount ?? 0;
      const vat = j.invoice_vat_amount != null
        ? { vatAmount: j.invoice_vat_amount, total: subtotal + j.invoice_vat_amount, vatRate: j.invoice_vat_rate ?? 0 }
        : calculateVat({
            sellerCountry: profile?.business_country,
            customerCountry: j.customer_country,
            customerVatNumber: j.customer_vat_number,
            subtotal,
          });
      return { job: j, subtotal, ...vat };
    }),
    [invoicedJobs, profile?.business_country],
  );
  const totalOwed = useMemo(
    () => invoicedJobsWithTax
      .filter((x) => x.job.invoice_status === 'sent')
      .reduce((sum, x) => sum + x.total, 0),
    [invoicedJobsWithTax],
  );

  const totalCollected = useMemo(
    () => invoicedJobsWithTax
      .filter((x) => x.job.invoice_status === 'paid')
      .reduce((sum, x) => sum + x.total, 0),
    [invoicedJobsWithTax],
  );

  const handleSelectPlan = async (planId: string) => {
    if (planId === profile?.plan) return;
    if (!stripeReady) {
      toast('Stripe is not configured yet. Connect Stripe to enable plan upgrades.', 'info');
      return;
    }
    setProcessingPlan(planId);
    // Stripe checkout would happen here via edge function
    setTimeout(() => {
      setProcessingPlan(null);
      setShowPlans(false);
      toast('Stripe integration coming soon.', 'info');
    }, 1000);
  };

  if (!canAccess) return <NoAccess />;

  return (
    <DashboardLayout activeLabel="Billing">
      {/* Usage alert banner */}
      <UsageAlertBanner onUpgrade={() => setShowPlans(true)} />

      {/* Page header */}
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          <CreditCard size={24} />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Billing</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Manage your Vireek subscription and track customer payments.
          </p>
        </div>
      </div>

      {/* SECTION 1: Your Vireek Subscription */}
      <div className="mb-8">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-lg font-semibold text-text-primary">Your Vireek Subscription</h2>
          <span className="rounded-full bg-accent/10 px-2.5 py-0.5 text-xs font-medium text-accent">
            Plan billing
          </span>
        </div>

        {/* Current plan card */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark"
        >
          <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-3">
                <h3 className="text-xl font-bold text-text-primary">{currentPlan.name}</h3>
                <span className="rounded-full bg-success-500/10 px-2.5 py-1 text-xs font-medium text-success-500">
                  Active
                </span>
              </div>
              <p className="mt-1 text-sm text-text-secondary">
                ${currentPlan.price}/mo · {currentPlan.minutes.toLocaleString()} included minutes
              </p>

              {/* Usage progress bar */}
              <div className="mt-5">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-xs font-medium text-text-secondary">Minutes used this month</span>
                  <span className="text-xs font-semibold text-text-primary">
                    {profile?.minutes_used_this_month ?? 0} / {profile?.minutes_included ?? 50} min
                  </span>
                </div>
                <div className="h-3 w-full overflow-hidden rounded-full bg-bg-tertiary">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${usagePercent}%` }}
                    transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                    className={`h-full rounded-full ${
                      usagePercent >= 90
                        ? 'bg-danger'
                        : usagePercent >= 80
                          ? 'bg-warning-500'
                          : 'bg-accent'
                    }`}
                  />
                </div>
                <div className="mt-1.5 flex items-center justify-between">
                  <span className="text-xs text-text-secondary/70">
                    {minutesRemaining} minutes remaining
                  </span>
                  {usagePercent >= 80 && (
                    <span className="flex items-center gap-1 text-xs font-medium text-warning-500">
                      <AlertTriangle size={12} /> Approaching limit
                    </span>
                  )}
                </div>
              </div>

              {/* Overage info */}
              <div className="mt-4 flex items-center gap-2 rounded-xl border border-border bg-bg-primary p-3">
                <Clock size={16} className="shrink-0 text-text-secondary" />
                <p className="text-xs text-text-secondary">
                  Overage rate: <span className="font-semibold text-text-primary">${currentPlan.overage}/min</span> after included minutes are used.
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setShowPlans(true)}
              className="focus-ring flex shrink-0 items-center gap-2 rounded-xl bg-cta px-5 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-110"
            >
              <TrendingUp size={16} />
              {profile?.plan && profile.plan !== PLANS[0].id ? 'Change Plan' : 'Upgrade'}
            </button>
          </div>
        </motion.div>

        {/* Billing history */}
        <div className="mt-4 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
          <div className="flex items-center gap-2">
            <Receipt size={18} className="text-text-secondary" />
            <h3 className="text-sm font-semibold text-text-primary">Billing History</h3>
          </div>
          {stripeReady ? (
            <div className="mt-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-text-secondary">
                    <th className="pb-2 font-medium">Date</th>
                    <th className="pb-2 font-medium">Amount</th>
                    <th className="pb-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {/* Stripe invoices would populate here */}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="mt-4 flex items-center gap-3 rounded-xl border border-dashed border-border bg-bg-primary p-4">
              <Lock size={16} className="shrink-0 text-text-secondary" />
              <p className="text-xs text-text-secondary">
                Billing history will appear here once Stripe is connected. Your Starter plan is free — no charges yet.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* SECTION 2: Customer Invoices */}
<div className="mb-8 printable-invoice" id="invoice-print-area">
  <div className="mb-3 flex items-center justify-between gap-2">
    <div className="flex items-center gap-2">
      <h2 className="text-lg font-semibold text-text-primary">Customer Invoices</h2>
      <span className="rounded-full bg-bg-tertiary px-2.5 py-0.5 text-xs font-medium text-text-secondary no-print">
        From your jobs
      </span>
    </div>
    <button
      type="button"
      onClick={() => window.print()}
      className="no-print focus-ring flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-3.5 py-2 text-sm font-medium text-text-primary transition-colors hover:border-accent/40"
    >
      <Printer size={16} className="text-text-secondary" />
      <span>Print</span>
    </button>
  </div>

  {/* Summary cards */}
        <div className="mb-4 grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
            <div className="flex items-center gap-2">
              <Clock size={16} className="text-warning-500" />
              <span className="text-xs font-medium text-text-secondary">Outstanding</span>
            </div>
            <p className="mt-2 text-2xl font-bold tracking-tight text-text-primary">
              {formatMoney(totalOwed, invoiceCurrency)}
            </p>
            <p className="mt-0.5 text-xs text-text-secondary">Awaiting payment from customers</p>
          </div>
          <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
            <div className="flex items-center gap-2">
              <Check size={16} className="text-success-500" />
              <span className="text-xs font-medium text-text-secondary">Collected</span>
            </div>
            <p className="mt-2 text-2xl font-bold tracking-tight text-text-primary">
              {formatMoney(totalCollected, invoiceCurrency)}
            </p>
            <p className="mt-0.5 text-xs text-text-secondary">Paid by customers</p>
          </div>
        </div>

        {/* Invoice list */}
        <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
          {loadingJobs ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4">
                  <div className="h-5 w-24 animate-pulse rounded bg-bg-tertiary" />
                  <div className="h-5 w-32 animate-pulse rounded bg-bg-tertiary" />
                  <div className="h-5 w-16 animate-pulse rounded bg-bg-tertiary" />
                </div>
              ))}
            </div>
          ) : invoicedJobs.length === 0 ? (
            <div className="flex items-center gap-3 rounded-xl border border-dashed border-border bg-bg-primary p-4">
              <FileText size={18} className="text-text-secondary" />
              <p className="text-sm text-text-secondary">
                No customer invoices yet. Invoices are created when you set invoice details on completed jobs.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-text-secondary">
                    <th className="pb-3 pr-4 font-medium">Date</th>
                    <th className="pb-3 pr-4 font-medium">Customer</th>
                    <th className="pb-3 pr-4 font-medium">Service</th>
                    <th className="pb-3 pr-4 font-medium">Subtotal</th>
                    <th className="pb-3 pr-4 font-medium">VAT</th>
                    <th className="pb-3 pr-4 font-medium">Total</th>
                    <th className="pb-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {invoicedJobsWithTax.map(({ job, subtotal, vatRate, vatAmount, total }) => (
                    <tr key={job.id} className="border-b border-border/50 last:border-0">
                      <td className="py-3 pr-4 text-text-secondary">
                        {new Date(job.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      </td>
                      <td className="py-3 pr-4 font-medium text-text-primary">{job.customer_name}</td>
                      <td className="py-3 pr-4 text-text-secondary">{job.service_type ?? '—'}</td>
                      <td className="py-3 pr-4 text-text-secondary">
                        {job.invoice_amount !== null ? formatMoney(subtotal, invoiceCurrency) : '—'}
                      </td>
                      <td className="py-3 pr-4 text-text-secondary">
                        {job.invoice_amount !== null && vatRate > 0 ? `${vatRate}% · ${formatMoney(vatAmount, invoiceCurrency)}` : job.invoice_reverse_charge ? 'Reverse charge' : '—'}
                      </td>
                      <td className="py-3 pr-4 font-medium text-text-primary">
                        {job.invoice_amount !== null ? formatMoney(total, invoiceCurrency) : '—'}
                      </td>
                      <td className="py-3">
                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${
                            job.invoice_status === 'paid'
                              ? 'bg-success-500/10 text-success-500'
                              : job.invoice_status === 'sent'
                                ? 'bg-blue-500/10 text-blue-500'
                                : 'bg-bg-tertiary text-text-secondary'
                          }`}
                        >
                          {job.invoice_status === 'paid' ? 'Paid' : job.invoice_status === 'sent' ? 'Sent' : 'Not Sent'}
                        </span>
                      </td>
                    </tr>
                  ))}
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Plan selection modal */}
      {showPlans && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setShowPlans(false)} />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="relative w-full max-w-2xl rounded-2xl border border-border bg-bg-secondary p-6 shadow-card-hover dark:shadow-card-hover-dark"
          >
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-lg font-bold text-text-primary">Choose Your Plan</h2>
              <button
                type="button"
                onClick={() => setShowPlans(false)}
                className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
              >
                <X size={18} />
              </button>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              {PLANS.map((plan) => {
                const isCurrent = plan.id === profile?.plan;
                return (
                  <div
                    key={plan.id}
                    className={`rounded-2xl border p-5 ${
                      isCurrent
                        ? 'border-accent bg-accent/5'
                        : 'border-border bg-bg-primary'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <h3 className="text-base font-bold text-text-primary">{plan.name}</h3>
                      {isCurrent && (
                        <span className="rounded-full bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent">
                          Current
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-2xl font-bold tracking-tight text-text-primary">
                      ${plan.price}
                      <span className="text-sm font-normal text-text-secondary">/mo</span>
                    </p>
                    <p className="mt-1 text-xs text-text-secondary">
                      {plan.minutes.toLocaleString()} included minutes
                    </p>
                    <ul className="mt-4 space-y-1.5">
                      {plan.features.map((f) => (
                        <li key={f} className="flex items-center gap-2 text-xs text-text-secondary">
                          <Check size={12} className="shrink-0 text-success-500" /> {f}
                        </li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      onClick={() => handleSelectPlan(plan.id)}
                      disabled={isCurrent || processingPlan !== null}
                      className={`focus-ring mt-4 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-all disabled:opacity-50 ${
                        isCurrent
                          ? 'border border-border text-text-secondary'
                          : 'bg-cta text-white hover:brightness-110'
                      }`}
                    >
                      {processingPlan === plan.id ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : isCurrent ? (
                        'Current Plan'
                      ) : (
                        `Switch to ${plan.name}`
                      )}
                    </button>
                  </div>
                );
              })}
            </div>

            {!stripeReady && (
              <p className="mt-4 text-center text-xs text-text-secondary/60">
                Stripe payment integration is not yet configured. Plan switching will be available once Stripe is connected.
              </p>
            )}
          </motion.div>
        </div>
      )}
    </DashboardLayout>
  );
}
