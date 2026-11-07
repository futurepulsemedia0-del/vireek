// Customer-facing ROI card. Shows a RANGE with its assumptions and a list of the exact outcome ids behind it, or
// "Not enough data yet" (never a made-up number). Cost side is the list price of the tenant's plan.
import { useEffect, useState } from 'react';
import { fetchTenantRoi, type TenantRoi } from '@/lib/tenantRoi';

const usd = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const x = (r: number) => `${(r + 1).toFixed(1)}×`;

export function TenantRoiCard({ planId, days = 90 }: { planId: string; days?: number }) {
  const [data, setData] = useState<TenantRoi | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    fetchTenantRoi(planId, days).then((d) => { if (live) setData(d); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [planId, days]);

  if (failed) return <p role="alert" className="text-sm text-danger">We couldn’t load your ROI right now.</p>;
  if (!data) return <div role="status" aria-label="Loading ROI" className="h-28 animate-pulse rounded-2xl bg-bg-tertiary" />;
  const r = data.result;
  return (
    <section aria-label="Measured return on investment" className="rounded-2xl border border-border bg-bg-secondary p-5">
      <h2 className="text-base font-semibold text-text-primary">Measured return (last {data.days} days)</h2>
      {r.status === 'not_enough_data' ? (
        <p className="mt-2 text-sm text-text-secondary">Not enough data yet to show a reliable figure. We only count outcomes we can attribute with confidence ({r.included} so far).</p>
      ) : (
        <>
          <p className="mt-2 text-2xl font-bold tabular-nums text-text-primary">{x(r.roiLow)} – {x(r.roiHigh)}</p>
          <p className="mt-1 text-sm text-text-secondary">Attributed value {usd(r.valueCentsLow)} – {usd(r.valueCentsHigh)} against plan cost {usd(r.planCostCents)}.</p>
          <p className="mt-2 text-xs text-text-secondary">
            Low end weights each outcome by our confidence in it; high end counts them in full. Excluded as not attributable: {r.excluded.preceded_action} recorded before the action, {r.excluded.low_confidence} low-confidence, {r.excluded.invalid} invalid.
            Plan cost uses the monthly list price. Rules: {r.rules.join(', ')}.
          </p>
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="focus-ring mt-3 min-h-[44px] text-sm font-medium text-accent underline">{open ? 'Hide' : 'Show'} the {r.included} outcomes behind this</button>
          {open && <ul className="mt-2 max-h-64 overflow-auto text-xs text-text-secondary">{data.outcomes.filter((o) => r.inputIds.includes(o.id)).map((o) => <li key={o.id}>{o.id.slice(0, 8)} · {o.rule.replace('agent_action_outcome:', '')} · {usd(o.valueCents)} · {(o.confidence * 100).toFixed(0)}% confidence</li>)}</ul>}
        </>
      )}
    </section>
  );
}
