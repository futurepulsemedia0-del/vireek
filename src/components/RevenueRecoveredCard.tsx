import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Zap, TrendingUp, PhoneCall, Info, X, Wrench } from 'lucide-react';
import type { Call, Job, BusinessProfile } from '@/lib/supabase';
import { PRICING_PLANS } from '@/lib/pricing';

type BusinessHours = BusinessProfile['business_hours'];

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

function formatCurrency(amount: number, opts: { compact?: boolean } = {}): string {
  if (opts.compact && Math.abs(amount) >= 1000) {
    return `$${(amount / 1000).toFixed(amount >= 10000 ? 0 : 1)}k`;
  }
  return amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

/**
 * A call counts as "would have been missed without 24/7 AI coverage" if it's
 * a flagged emergency, OR it happened outside the business's configured
 * hours for that day. Falls back to a sensible default window (before 8am,
 * after 6pm, or a weekend) when hours haven't been configured yet, so the
 * card still tells the truth on day one instead of showing zeros.
 */
function isOffHoursCall(call: Call, businessHours: BusinessHours): boolean {
  const dt = new Date(call.call_datetime);
  const dayKey = DAY_KEYS[dt.getDay()];
  const minutesOfDay = dt.getHours() * 60 + dt.getMinutes();

  if (businessHours && Object.keys(businessHours).length > 0) {
    const entry = businessHours[dayKey];
    if (!entry) return true; // day not listed = closed all day
    const [openH, openM] = entry.open.split(':').map(Number);
    const [closeH, closeM] = entry.close.split(':').map(Number);
    const openMinutes = openH * 60 + openM;
    const closeMinutes = closeH * 60 + closeM;
    return minutesOfDay < openMinutes || minutesOfDay >= closeMinutes;
  }

  const isWeekend = dayKey === 'sat' || dayKey === 'sun';
  const isBeforeOpen = minutesOfDay < 8 * 60;
  const isAfterClose = minutesOfDay >= 18 * 60;
  return isWeekend || isBeforeOpen || isAfterClose;
}

function isRecoverable(call: Call, businessHours: BusinessHours): boolean {
  return call.is_emergency || isOffHoursCall(call, businessHours);
}

interface RevenueRecoveredCardProps {
  calls: Call[];
  jobs: Job[];
  businessHours: BusinessHours;
  planId: string | null | undefined;
}

export function RevenueRecoveredCard({ calls, jobs, businessHours, planId }: RevenueRecoveredCardProps) {
  const [showMethodology, setShowMethodology] = useState(false);

  const data = useMemo(() => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const callMap = new Map(calls.map((c) => [c.id, c]));
    const recoverableCallIds = new Set(
      calls.filter((c) => isRecoverable(c, businessHours)).map((c) => c.id)
    );

    const jobIsRecovered = (j: Job) => j.call_id != null && recoverableCallIds.has(j.call_id);

    const thisMonthJobs = jobs.filter((j) => new Date(j.created_at) >= monthStart);
    const recoveredJobsThisMonth = thisMonthJobs.filter(jobIsRecovered);

    const paidRevenue = recoveredJobsThisMonth
      .filter((j) => j.invoice_status === 'paid')
      .reduce((sum, j) => sum + (j.invoice_amount ?? 0), 0);

    const pipelineRevenue = recoveredJobsThisMonth
      .filter((j) => j.invoice_status !== 'paid' && j.job_status !== 'cancelled')
      .reduce((sum, j) => sum + (j.invoice_amount ?? 0), 0);

    const emergencyCallsThisMonth = calls.filter(
      (c) => c.is_emergency && new Date(c.call_datetime) >= monthStart
    ).length;
    const offHoursCallsThisMonth = calls.filter(
      (c) => !c.is_emergency && isOffHoursCall(c, businessHours) && new Date(c.call_datetime) >= monthStart
    ).length;
    const recoveredJobsCount = recoveredJobsThisMonth.length;

    // Last 6 months trend of realized (paid) recovered revenue.
    const trend: { label: string; amount: number }[] = [];
    for (let i = 5; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      const amount = jobs
        .filter((j) => {
          if (!jobIsRecovered(j) || j.invoice_status !== 'paid') return false;
          const created = new Date(j.created_at);
          return created >= start && created < end;
        })
        .reduce((sum, j) => sum + (j.invoice_amount ?? 0), 0);
      trend.push({ label: start.toLocaleDateString('en-US', { month: 'short' }), amount });
    }

    const monthlyCost = PRICING_PLANS.find((p) => p.id === planId)?.monthly ?? null;
    const totalRecovered = paidRevenue + pipelineRevenue;
    const roiMultiple = monthlyCost && monthlyCost > 0 ? totalRecovered / monthlyCost : null;

    // Day-of-month the plan "paid for itself", based on cumulative paid revenue.
    let paybackDay: number | null = null;
    if (monthlyCost && monthlyCost > 0) {
      const paidThisMonthSorted = recoveredJobsThisMonth
        .filter((j) => j.invoice_status === 'paid')
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      let running = 0;
      for (const j of paidThisMonthSorted) {
        running += j.invoice_amount ?? 0;
        if (running >= monthlyCost) {
          paybackDay = new Date(j.created_at).getDate();
          break;
        }
      }
    }

    void callMap; // retained for clarity/future per-call breakdown use
    return {
      paidRevenue,
      pipelineRevenue,
      totalRecovered,
      emergencyCallsThisMonth,
      offHoursCallsThisMonth,
      recoveredJobsCount,
      trend,
      monthlyCost,
      roiMultiple,
      paybackDay,
      hasConfiguredHours: !!businessHours && Object.keys(businessHours).length > 0,
    };
  }, [calls, jobs, businessHours, planId]);

  const maxTrend = Math.max(...data.trend.map((t) => t.amount), 1);
  const hasAnyRecoveredEver = data.trend.some((t) => t.amount > 0) || data.totalRecovered > 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="relative overflow-hidden rounded-2xl border border-accent/20 bg-gradient-to-br from-accent/[0.07] via-bg-secondary to-cta/[0.06] p-6 shadow-card dark:shadow-card-dark"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-cta text-white shadow-glow-accent">
            <Zap size={20} />
          </span>
          <div>
            <div className="flex items-center gap-1.5">
              <h3 className="text-sm font-semibold text-text-primary">Revenue Vireek Recovered</h3>
              <button
                type="button"
                onClick={() => setShowMethodology(true)}
                aria-label="How this is calculated"
                className="focus-ring flex h-5 w-5 items-center justify-center rounded-full text-text-secondary/70 hover:text-accent"
              >
                <Info size={13} />
              </button>
            </div>
            <p className="mt-0.5 text-xs text-text-secondary">
              From emergency &amp; after-hours calls your team would otherwise have missed
            </p>
          </div>
        </div>

        {data.roiMultiple !== null && data.totalRecovered > 0 && (
          <span className="flex items-center gap-1.5 rounded-full border border-success-500/30 bg-success-500/10 px-3 py-1.5 text-xs font-bold text-success-500">
            <TrendingUp size={13} />
            {data.roiMultiple.toFixed(1)}× return this month
          </span>
        )}
      </div>

      <div className="mt-5 flex flex-wrap items-end gap-x-8 gap-y-4">
        <div>
          <p className="text-4xl font-bold tracking-tight text-text-primary md:text-5xl">
            {formatCurrency(data.paidRevenue)}
          </p>
          <p className="mt-1 text-xs text-text-secondary">
            Collected this month
            {data.pipelineRevenue > 0 && (
              <> &middot; {formatCurrency(data.pipelineRevenue)} more booked, not yet paid</>
            )}
          </p>
        </div>

        <div className="flex gap-6">
          <div>
            <p className="flex items-center gap-1.5 text-lg font-bold text-text-primary">
              <PhoneCall size={15} className="text-danger" />
              {data.emergencyCallsThisMonth + data.offHoursCallsThisMonth}
            </p>
            <p className="text-[11px] text-text-secondary">calls you'd have missed</p>
          </div>
          <div>
            <p className="flex items-center gap-1.5 text-lg font-bold text-text-primary">
              <Wrench size={15} className="text-accent" />
              {data.recoveredJobsCount}
            </p>
            <p className="text-[11px] text-text-secondary">turned into jobs</p>
          </div>
        </div>
      </div>

      {/* 6-month trend */}
      {hasAnyRecoveredEver && (
        <div className="mt-6 flex items-end gap-2">
          {data.trend.map((t) => (
            <div key={t.label} className="flex flex-1 flex-col items-center gap-1.5">
              <div className="flex h-16 w-full items-end">
                <div
                  className="w-full rounded-t-md bg-gradient-to-t from-accent to-cta transition-all"
                  style={{ height: `${Math.max(4, (t.amount / maxTrend) * 100)}%`, opacity: t.amount > 0 ? 1 : 0.15 }}
                  title={formatCurrency(t.amount)}
                />
              </div>
              <span className="text-[10px] text-text-secondary">{t.label}</span>
            </div>
          ))}
        </div>
      )}

      {data.monthlyCost && data.paybackDay && (
        <p className="mt-5 rounded-xl bg-success-500/10 px-4 py-2.5 text-xs font-medium text-success-500">
          Vireek paid for itself this month on day {data.paybackDay} — everything since is profit.
        </p>
      )}

      {!data.hasConfiguredHours && (
        <p className="mt-4 text-[11px] text-text-secondary/70">
          Using default after-hours estimate (before 8am, after 6pm, weekends).{' '}
          <a href="/dashboard/business-profile" className="font-medium text-accent hover:underline">
            Set your real business hours
          </a>{' '}
          for a more accurate number.
        </p>
      )}

      {showMethodology && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/40 backdrop-blur-sm p-4"
          onClick={() => setShowMethodology(false)}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-2xl border border-border bg-bg-secondary p-5 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-3">
              <h4 className="text-sm font-semibold text-text-primary">How this number is calculated</h4>
              <button
                type="button"
                onClick={() => setShowMethodology(false)}
                aria-label="Close"
                className="focus-ring flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary"
              >
                <X size={14} />
              </button>
            </div>
            <ol className="mt-3 list-decimal space-y-2 pl-4 text-xs leading-relaxed text-text-secondary">
              <li>We flag every call marked as an emergency, or that came in outside your business hours.</li>
              <li>We follow each of those calls to the job it created, if any.</li>
              <li>We sum the paid invoice amount on those jobs — this is real, collected revenue, not a projection.</li>
              <li>Jobs booked but not yet paid are shown separately as pipeline, never counted in the headline number.</li>
            </ol>
            <p className="mt-3 text-[11px] text-text-secondary/70">
              This is deliberately conservative: it only counts calls Vireek actually answered and that turned into
              real, invoiced work — not a hypothetical missed-call estimate.
            </p>
          </motion.div>
        </div>
      )}
    </motion.div>
  );
}
