import { useEffect, useState } from 'react';
import { Radar } from 'lucide-react';
import { fetchFleetJobCost, formatCents, formatMinutes, type FleetJobCost } from '@/lib/fleetIntelligence';

const CONFIDENCE_STYLE: Record<FleetJobCost['confidence'], string> = {
  high: 'bg-success-500/10 text-success-500',
  medium: 'bg-warning-500/10 text-warning-500',
  low: 'bg-bg-tertiary text-text-secondary',
};

/**
 * Fleet-attributed cost of ONE job, shown inside the Profitability job row.
 * Renders nothing when the job has no scored trip, so it is invisible for
 * accounts that don't use Fleet Intelligence.
 */
export function FleetJobCostCard({ jobId }: { jobId: string }) {
  const [cost, setCost] = useState<FleetJobCost | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCost(null);
    void fetchFleetJobCost(jobId).then((c) => {
      if (!cancelled) setCost(c);
    });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  if (!cost) return null;

  const lines: { label: string; cents: number }[] = [
    { label: 'Fuel', cents: cost.fuel_cost_cents },
    { label: 'Vehicle wear', cents: cost.wear_cost_cents },
    { label: 'Idle fuel', cents: cost.idle_cost_cents },
    { label: 'Fixed (payment + insurance share)', cents: cost.fixed_cost_cents },
    { label: 'Drive-time labor', cents: cost.drive_labor_cost_cents },
    { label: 'On-site labor', cents: cost.on_site_labor_cost_cents },
  ];

  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary">
          <Radar size={12} /> Fleet intelligence
        </p>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize ${CONFIDENCE_STYLE[cost.confidence]}`}>
          {cost.confidence} confidence
        </span>
      </div>
      <div className="rounded-xl border border-border bg-bg-primary p-3">
        <p className="mb-2 text-xs text-text-secondary">
          {cost.distance_miles != null ? `${cost.distance_miles.toFixed(1)} mi` : 'Distance unknown'} · {formatMinutes(cost.drive_minutes)} driving
        </p>
        <dl className="space-y-1">
          {lines.map((l) => (
            <div key={l.label} className="flex justify-between text-xs">
              <dt className="text-text-secondary">{l.label}</dt>
              <dd className="font-medium text-text-primary">{formatCents(l.cents)}</dd>
            </div>
          ))}
          <div className="flex justify-between border-t border-border pt-1.5 text-sm">
            <dt className="font-semibold text-text-primary">Fully loaded cost</dt>
            <dd className="font-semibold text-text-primary">{formatCents(cost.fully_loaded_cost_cents)}</dd>
          </div>
          {cost.revenue_cents > 0 && (
            <div className="flex justify-between text-sm">
              <dt className="text-text-secondary">After fleet &amp; labor</dt>
              <dd className={`font-semibold ${cost.contribution_cents < 0 ? 'text-danger' : 'text-success-500'}`}>
                {formatCents(cost.contribution_cents)}
                {cost.margin_pct != null && <span className="ml-1 font-normal text-text-secondary">({cost.margin_pct.toFixed(1)}%)</span>}
              </dd>
            </div>
          )}
        </dl>
        <p className="mt-2 text-[11px] text-text-secondary">
          Computed from truck GPS, technician timestamps and your vehicle expenses. Informational: it does not change the cost entries above.
        </p>
      </div>
    </div>
  );
}
