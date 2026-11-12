import { CalendarDays, Phone, Users, Gauge, Receipt } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  estimateOverageUsd,
  formatMinutes,
  formatUsd,
  type LimitPolicy,
  type UsageSnapshot,
} from '@/lib/usageLimits';

export interface PlanLimitsCardProps {
  planName: string;
  snap: UsageSnapshot;
  policy: LimitPolicy;
  /** Overage rate in USD/min, read from PRICING_PLANS. Null when the plan has no metered overage. */
  rate: number | null;
  periodLabel: string;
  daysLeft: number;
  projectedOverageMinutes: number;
  seatsLimit: number | null;
  seatsUsed: number | null;
  locationsLimit: number | null;
  numbersActive: number | null;
  countsLoading: boolean;
}

function Row({ icon: Icon, label, children }: { icon: typeof Gauge; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <dt className="flex min-w-0 items-center gap-2 text-sm text-text-secondary">
        <Icon size={15} className="shrink-0" aria-hidden="true" />
        <span>{label}</span>
      </dt>
      <dd className="min-w-0 text-right text-sm font-medium text-text-primary">{children}</dd>
    </div>
  );
}

export function PlanLimitsCard(p: PlanLimitsCardProps) {
  const { snap } = p;
  const seatsPct = p.seatsLimit && p.seatsUsed !== null ? Math.min(100, (p.seatsUsed / p.seatsLimit) * 100) : null;
  const overageSoFar = estimateOverageUsd(snap.overageMinutes, p.rate);
  const overageProjected = estimateOverageUsd(p.projectedOverageMinutes, p.rate);

  return (
    <section
      aria-labelledby="plan-limits-heading"
      className="mb-5 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark"
    >
      <h3 id="plan-limits-heading" className="text-sm font-semibold text-text-primary">
        Plan limits &amp; billing period
      </h3>
      <p className="mt-1 text-xs text-text-secondary">{p.planName} plan</p>

      <dl className="mt-4 divide-y divide-border">
        <Row icon={CalendarDays} label="Billing period">
          {p.periodLabel}
          <span className="block text-xs font-normal text-text-secondary">
            {p.daysLeft} {p.daysLeft === 1 ? 'day' : 'days'} left
          </span>
        </Row>

        <Row icon={Gauge} label="Minutes">
          {formatMinutes(snap.used)} used
          {snap.unlimited ? (
            <span className="block text-xs font-normal text-text-secondary">Unlimited</span>
          ) : (
            <span className="block text-xs font-normal text-text-secondary">
              {formatMinutes(snap.included)} included
              {snap.bonus > 0 && ` + ${formatMinutes(snap.bonus)} bonus`} · {formatMinutes(snap.remaining ?? 0)} remaining
            </span>
          )}
        </Row>

        <Row icon={Receipt} label="Overage this period">
          {p.policy === 'bill' && p.rate !== null ? (
            <>
              {formatUsd(overageSoFar)}
              <span className="block text-xs font-normal text-text-secondary">
                {formatMinutes(snap.overageMinutes)} min × {formatUsd(p.rate)}/min
                {p.projectedOverageMinutes > 0 && ` · projected ${formatUsd(overageProjected)} by month end`}
              </span>
            </>
          ) : p.policy === 'block' ? (
            <span className="text-text-secondary">None — answering pauses at the limit</span>
          ) : (
            <span className="text-text-secondary">Not metered</span>
          )}
        </Row>

        <Row icon={Users} label="Team seats">
          {p.countsLoading && p.seatsUsed === null ? (
            <span className="text-text-secondary" aria-busy="true">—</span>
          ) : (
            <>
              {p.seatsUsed ?? '—'} / {p.seatsLimit ?? 'Unlimited'}
              {seatsPct !== null && (
                <span
                  className="mt-1.5 block h-1.5 w-28 overflow-hidden rounded-full bg-bg-tertiary"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(seatsPct)}
                  aria-label="Team seats in use"
                >
                  <span className={`block h-full rounded-full ${seatsPct >= 100 ? 'bg-danger' : seatsPct >= 80 ? 'bg-warning-500' : 'bg-accent'}`} style={{ width: `${seatsPct}%` }} />
                </span>
              )}
            </>
          )}
        </Row>

        <Row icon={Users} label="Locations">
          {p.locationsLimit === null ? 'Unlimited' : `Up to ${p.locationsLimit}`}
        </Row>

        <Row icon={Phone} label="Phone numbers">
          {p.countsLoading && p.numbersActive === null ? <span className="text-text-secondary" aria-busy="true">—</span> : (p.numbersActive ?? '—')}
          <span className="block text-xs font-normal text-text-secondary">in use</span>
        </Row>
      </dl>
    </section>
  );
}
