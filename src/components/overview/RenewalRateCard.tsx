import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, RotateCcw } from 'lucide-react';
import { autoChargeCoverage, fetchRenewalKpis, formatRate, formatUsd, type RenewalKpis } from '@/lib/membershipRenewal';

/** Overview widget: maintenance-agreement renewal rate for the last 90 days, plus what's at risk. */
export function RenewalRateCard() {
  const [kpis, setKpis] = useState<RenewalKpis | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchRenewalKpis(90)
      .then((k) => alive && setKpis(k))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  const decided = kpis ? kpis.renewed + kpis.lapsed + kpis.cancelled : 0;
  const coverage = kpis ? autoChargeCoverage(kpis) : null;

  return (
    <div className="h-full rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
      <div className="flex items-center justify-between">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-success-500/10 text-success-500">
          <RotateCcw size={20} />
        </span>
        <Link
          to="/dashboard/memberships/renewals"
          className="focus-ring inline-flex items-center gap-1 rounded-lg text-xs font-medium text-accent hover:underline"
        >
          Renewal pipeline <ArrowRight size={12} />
        </Link>
      </div>

      <p className="mt-4 text-sm text-text-secondary">Agreement renewal rate</p>
      {!kpis && !failed && <div className="mt-2 h-9 w-24 animate-pulse rounded bg-bg-tertiary" aria-label="Loading renewal rate" />}
      {failed && <p className="mt-2 text-sm text-text-secondary">Couldn’t load renewal data right now.</p>}
      {kpis && (
        <>
          <p className="mt-1 text-3xl font-bold text-text-primary">{formatRate(kpis.renewal_rate)}</p>
          <p className="mt-1 text-xs text-text-secondary">
            {decided === 0 ? 'No renewals decided yet — last 90 days' : `${kpis.renewed} of ${decided} renewed · last ${kpis.window_days} days`}
          </p>
          <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-4 text-xs">
            <div>
              <dt className="text-text-secondary">Revenue at risk</dt>
              <dd className={`mt-0.5 text-sm font-semibold ${kpis.at_risk_cents > 0 ? 'text-warning-500' : 'text-text-primary'}`}>{formatUsd(kpis.at_risk_cents)}</dd>
            </div>
            <div>
              <dt className="text-text-secondary">Auto-charge ready</dt>
              <dd className="mt-0.5 text-sm font-semibold text-text-primary">{coverage === null ? '—' : `${coverage}%`}</dd>
            </div>
          </dl>
        </>
      )}
    </div>
  );
}
