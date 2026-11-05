import { useMemo, useState } from 'react';
import { formatMinutes, formatPct, formatUsd } from '@/lib/staffUsage';
import { enterpriseQuote, projectPlan, rateSensitivity, breakEvenMinutes, type PlanTerms } from '@/lib/marginModel';
import { monthlyMinutesSamples, planAdvice, type PlanStat, type TenantMargin } from '@/lib/marginDashboard';
import { planEconomics } from '@/lib/staffUsage';
import { Field, INPUT, Section, TableWrap, TD, TDR, TH, THR } from './shared';

const CHANGES = [-20, -10, 0, 10, 25, 50];
const numOrNull = (s: string): number | null => (s.trim() === '' || !Number.isFinite(Number(s)) ? null : Number(s));

export function PlanningPanel({ margins, plans, days, defaultCpm }: { margins: TenantMargin[]; plans: PlanStat[]; days: number; defaultCpm: number | null }) {
  const priced = plans.filter((p) => planEconomics(p.plan).monthlyPrice !== null);
  const [planId, setPlanId] = useState(priced[0]?.plan ?? '');
  const base = planEconomics(planId);
  const [price, setPrice] = useState('');
  const [included, setIncluded] = useState('');
  const [overage, setOverage] = useState('');
  const [cpm, setCpm] = useState(defaultCpm === null ? '' : String(Number(defaultCpm.toFixed(4))));
  const [fixed, setFixed] = useState('0');

  const terms: PlanTerms | null = useMemo(() => {
    const priceV = numOrNull(price) ?? base.monthlyPrice;
    const incV = numOrNull(included) ?? (Number.isFinite(base.includedMinutes) ? base.includedMinutes : null);
    if (priceV === null || incV === null || priceV < 0 || incV < 0) return null;
    const ov = overage.trim() === '' ? base.overageRate : numOrNull(overage);
    return { planId, priceUsd: priceV, includedMinutes: incV, overageRateUsd: ov !== null && ov >= 0 ? ov : null };
  }, [price, included, overage, base, planId]);

  const cpmV = numOrNull(cpm);
  const fixedV = numOrNull(fixed) ?? 0;
  const samples = useMemo(() => monthlyMinutesSamples(margins, planId, days), [margins, planId, days]);
  const ready = terms !== null && cpmV !== null && cpmV >= 0;
  const proj = useMemo(() => (ready ? projectPlan(terms, samples, cpmV, fixedV) : null), [ready, terms, samples, cpmV, fixedV]);
  const be = ready ? breakEvenMinutes(terms, cpmV, fixedV) : null;
  const sens = useMemo(() => (ready ? rateSensitivity(terms, samples, cpmV, CHANGES, fixedV) : []), [ready, terms, samples, cpmV, fixedV]);

  const [qMin, setQMin] = useState('10000');
  const [qFixed, setQFixed] = useState('0');
  const [qTarget, setQTarget] = useState('60');
  const quote = useMemo(() => {
    const m = numOrNull(qMin); const f = numOrNull(qFixed); const t = numOrNull(qTarget);
    if (m === null || f === null || t === null || cpmV === null) return { error: 'Fill in minutes, fixed cost, target margin and a cost per minute above.' as const };
    try { return { value: enterpriseQuote({ minutesPerMonth: m, costPerMinuteUsd: cpmV, fixedCostUsd: f, targetMarginPct: t }) }; }
    catch (e) { return { error: e instanceof Error ? e.message : 'Invalid input' }; }
  }, [qMin, qFixed, qTarget, cpmV]);

  return (
    <div className="space-y-6">
      <p className="rounded-xl border border-border bg-bg-secondary p-3 text-sm text-text-secondary">Everything here is an <strong>estimate</strong> built from your inputs and this window&apos;s usage. It recommends; it never changes prices.</p>
      <Section title="Pricing simulator">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <Field label="Plan"><select value={planId} onChange={(e) => { setPlanId(e.target.value); setPrice(''); setIncluded(''); setOverage(''); }} className={INPUT}>{priced.map((p) => <option key={p.plan} value={p.plan}>{p.planName}</option>)}</select></Field>
          <Field label="Price / month (USD)" hint={`current ${formatUsd(base.monthlyPrice)}`}><input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder={String(base.monthlyPrice ?? '')} className={INPUT} /></Field>
          <Field label="Included minutes" hint={`current ${Number.isFinite(base.includedMinutes) ? base.includedMinutes : '—'}`}><input inputMode="numeric" value={included} onChange={(e) => setIncluded(e.target.value)} placeholder={Number.isFinite(base.includedMinutes) ? String(base.includedMinutes) : ''} className={INPUT} /></Field>
          <Field label="Overage $/min" hint={`current ${formatUsd(base.overageRate)}`}><input inputMode="decimal" value={overage} onChange={(e) => setOverage(e.target.value)} placeholder={String(base.overageRate ?? '')} className={INPUT} /></Field>
          <Field label="Provider cost $/min" hint="measured value is prefilled when available"><input inputMode="decimal" value={cpm} onChange={(e) => setCpm(e.target.value)} className={INPUT} /></Field>
          <Field label="Fixed cost / org / month"><input inputMode="decimal" value={fixed} onChange={(e) => setFixed(e.target.value)} className={INPUT} /></Field>
        </div>
        {!ready || !proj ? <p role="status" className="mt-4 text-sm text-text-secondary">Enter a provider cost per minute (no measured value is available yet) to see projections.</p> : (
          <div className="mt-4 space-y-4">
            <TableWrap caption="Projected margin at historical usage percentiles">
              <thead><tr><th scope="col" className={TH}>Usage percentile</th><th scope="col" className={THR}>Minutes / month</th><th scope="col" className={THR}>Revenue</th><th scope="col" className={THR}>Cost</th><th scope="col" className={THR}>Margin</th></tr></thead>
              <tbody>{([['p10', proj.p10], ['p50', proj.p50], ['p90', proj.p90]] as const).map(([k, pt]) => (
                <tr key={k} className="border-t border-border"><th scope="row" className={`${TD} font-medium`}>{k}</th><td className={TDR}>{pt ? formatMinutes(pt.minutes) : '—'}</td><td className={TDR}>{formatUsd(pt?.revenueUsd)}</td><td className={TDR}>{formatUsd(pt?.costUsd)}</td><td className={TDR}>{pt ? `${formatUsd(pt.marginUsd)} (${formatPct(pt.marginPct)})` : '—'}</td></tr>))}</tbody>
            </TableWrap>
            <p className="text-sm text-text-secondary">Sample: {proj.sampleSize} orgs on this plan · {proj.negativeShare === null ? '—' : formatPct(proj.negativeShare * 100)} would lose money · margin turns negative at {be === null ? 'never (at these inputs)' : formatMinutes(be)}/month.</p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-text-primary">{terms && planAdvice(proj, be, terms.includedMinutes).map((a) => <li key={a}>{a}</li>)}</ul>
            <h3 className="text-sm font-semibold text-text-primary">If the provider price per minute changes</h3>
            <TableWrap caption="Sensitivity to provider cost per minute">
              <thead><tr><th scope="col" className={TH}>Change</th><th scope="col" className={THR}>$/min</th><th scope="col" className={THR}>p50 margin</th><th scope="col" className={THR}>p90 margin</th><th scope="col" className={THR}>Break-even</th></tr></thead>
              <tbody>{sens.map((r) => <tr key={r.changePct} className="border-t border-border"><th scope="row" className={`${TD} font-medium`}>{r.changePct > 0 ? `+${r.changePct}` : r.changePct}%</th><td className={TDR}>{formatUsd(r.costPerMinuteUsd)}</td><td className={TDR}>{formatPct(r.p50MarginPct)}</td><td className={TDR}>{formatPct(r.p90MarginPct)}</td><td className={TDR}>{r.breakEvenMinutes === null ? 'never' : formatMinutes(r.breakEvenMinutes)}</td></tr>)}</tbody>
            </TableWrap>
          </div>)}
      </Section>
      <Section title="Enterprise quote (cost-to-serve and price floor)">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Minutes / month"><input inputMode="numeric" value={qMin} onChange={(e) => setQMin(e.target.value)} className={INPUT} /></Field>
          <Field label="Fixed cost / month (USD)"><input inputMode="decimal" value={qFixed} onChange={(e) => setQFixed(e.target.value)} className={INPUT} /></Field>
          <Field label="Target gross margin %"><input inputMode="decimal" value={qTarget} onChange={(e) => setQTarget(e.target.value)} className={INPUT} /></Field>
        </div>
        <div className="mt-4" role="status" aria-live="polite">
          {'error' in quote ? <p className="text-sm text-text-secondary">{quote.error}</p> : (
            <p className="text-sm text-text-primary">Estimated cost to serve <strong>{formatUsd(quote.value.costToServeUsd)}</strong> / month. Suggested price floor <strong>{formatUsd(quote.value.priceFloorUsd)}</strong> / month{quote.value.floorPerMinuteUsd !== null ? ` (${formatUsd(quote.value.floorPerMinuteUsd)} per minute)` : ''}. Uses the provider cost per minute above; excludes SMS, storage and support.</p>)}
        </div>
      </Section>
    </div>
  );
}
