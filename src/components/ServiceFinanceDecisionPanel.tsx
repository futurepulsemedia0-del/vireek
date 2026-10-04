import { useMemo, useState } from 'react';
import { ChevronDown, Info, Landmark, PiggyBank, TrendingUp } from 'lucide-react';
import type { PropertyTwin } from '@/lib/propertyTwin';
import { Input } from '@/components/ui/Input';
import {
  FINANCE_CONFIDENCE_LABELS,
  FINANCE_HORIZON_YEARS,
  FINANCE_TIMING_LABELS,
  computeServiceFinancePlan,
  type CreditBand,
  type CustomerEconomics,
  type CustomerSegment,
  type FinanceRisk,
  type FinanceTiming,
  type PathEvaluation,
  type UnitFinanceDecision,
} from '@/lib/serviceFinance';

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd = (n: number) => USD.format(Math.round(n));
const percent = (n: number) => `${Math.round(n * 100)}%`;

const TIMING_STYLES: Record<FinanceTiming, string> = {
  now: 'bg-accent/10 text-accent',
  plan: 'bg-warning-500/10 text-warning-500',
  monitor: 'bg-success-500/10 text-success-500',
};

const RISK_STYLES: Record<FinanceRisk, string> = {
  low: 'bg-success-500/10 text-success-500',
  medium: 'bg-warning-500/10 text-warning-500',
  high: 'bg-danger/10 text-danger',
};

const CREDIT_OPTIONS: ReadonlyArray<{ value: CreditBand; label: string }> = [
  { value: 'unknown', label: 'Not known yet' },
  { value: 'excellent', label: 'Excellent (740+)' },
  { value: 'good', label: 'Good (680–739)' },
  { value: 'fair', label: 'Fair (620–679)' },
  { value: 'poor', label: 'Below 620' },
];

const STAY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: `${FINANCE_HORIZON_YEARS}+ years` },
  { value: '7', label: 'About 7 years' },
  { value: '5', label: 'About 5 years' },
  { value: '3', label: 'About 3 years' },
  { value: '2', label: 'About 2 years' },
];

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary focus-visible:border-accent';

/** Digits and one decimal point only; empty or non-positive means "not provided". */
function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[^\d.]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function sanitizeAmount(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, '');
  const firstDot = cleaned.indexOf('.');
  return firstDot === -1 ? cleaned : cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '');
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg-primary p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-text-primary">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-text-secondary">{hint}</p>}
    </div>
  );
}

function terms(p: PathEvaluation): string {
  if (p.termMonths === null) return p.path === 'replace_cash' ? 'One payment' : p.upfrontCash > 0 ? 'Annual fee' : '—';
  return `${p.termMonths} mo @ ${((p.apr ?? 0) * 100).toFixed(1)}%`;
}

function PathTable({ unit, years }: { unit: UnitFinanceDecision; years: number }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[460px] text-left text-xs">
        <caption className="sr-only">Financial paths for {unit.label}, ranked by expected cost to the customer</caption>
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-text-secondary">
            <th scope="col" className="py-1.5 pr-3 font-medium">Path</th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium">{years}-yr cost</th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium">Due today</th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium">Monthly</th>
            <th scope="col" className="py-1.5 font-medium">Terms</th>
          </tr>
        </thead>
        <tbody>
          {unit.paths.map((p) => (
            <tr key={p.path} className={`border-t border-border ${p.feasible ? '' : 'text-text-secondary'}`}>
              <th scope="row" className="py-2 pr-3 font-medium text-text-primary">
                <span className={p.feasible ? '' : 'text-text-secondary'}>{p.label}</span>
                {p.rank === 1 && <span className="ml-2 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">Best</span>}
                {!p.feasible && p.infeasibleReason && <span className="mt-0.5 block text-[11px] font-normal">{p.infeasibleReason}</span>}
              </th>
              <td className="py-2 pr-3 text-right tabular-nums">{p.feasible ? usd(p.expectedCost) : '—'}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{p.feasible ? usd(p.upfrontCash) : '—'}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{p.feasible && p.monthlyPayment > 0 ? usd(p.monthlyPayment) : '—'}</td>
              <td className="py-2 tabular-nums">{p.feasible ? terms(p) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UnitCard({ unit, years }: { unit: UnitFinanceDecision; years: number }) {
  const best = unit.recommended;
  const c = best.contractor;
  return (
    <li className="rounded-xl border border-border bg-bg-primary p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-text-primary">{unit.label}</p>
          <p className="text-[11px] text-text-secondary">
            {unit.categoryLabel} · {unit.ageAssumed ? 'age assumed ' : ''}
            {unit.ageYears} yr old · {unit.lifespanYears} yr expected life
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${RISK_STYLES[unit.risk]}`}>{percent(unit.risk12m)} fail risk (12 mo)</span>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${TIMING_STYLES[unit.timing]}`}>{FINANCE_TIMING_LABELS[unit.timing]}</span>
        </div>
      </div>

      <div className="mt-3 rounded-lg bg-accent/5 p-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">Best economic path</p>
        <p className="mt-0.5 text-sm font-semibold text-text-primary">{best.label}</p>
        <p className="mt-0.5 text-xs text-text-secondary">{unit.nextAction}</p>
        {(c.grossRevenue > 0 || c.recurringRevenue > 0) && (
          <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-text-secondary">
            {c.grossRevenue > 0 && (
              <span className="tabular-nums">
                Your revenue {usd(c.grossRevenue)}
                {c.financingFee > 0 ? ` − ${usd(c.financingFee)} lender fee = ${usd(c.netRevenue)} net` : ''}
              </span>
            )}
            {c.recurringRevenue > 0 && <span className="tabular-nums">+{usd(c.recurringRevenue)}/yr recurring</span>}
          </p>
        )}
      </div>

      <ul className="mt-3 list-disc space-y-1 pl-4 text-xs text-text-secondary">
        {unit.rationale.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      {unit.flags.length > 0 && (
        <ul className="mt-2 space-y-1">
          {unit.flags.map((flag) => (
            <li key={flag} className="flex items-start gap-1 text-[11px] text-warning-500">
              <Info size={11} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{flag}</span>
            </li>
          ))}
        </ul>
      )}

      <PathTable unit={unit} years={years} />

      <p className="mt-2 text-[11px] text-text-secondary">
        {FINANCE_CONFIDENCE_LABELS[unit.confidence]}
        {unit.runnerUp ? ` · ahead of ${unit.runnerUp.label} by ${usd(unit.margin)}` : ''}
      </p>
    </li>
  );
}

export function ServiceFinanceDecisionPanel({ twin }: { twin: PropertyTwin }) {
  const [segment, setSegment] = useState<CustomerSegment>('residential');
  const [creditBand, setCreditBand] = useState<CreditBand>('unknown');
  const [cash, setCash] = useState('');
  const [budget, setBudget] = useState('');
  const [energy, setEnergy] = useState('');
  const [stay, setStay] = useState('');

  const economics = useMemo<Partial<CustomerEconomics>>(
    () => ({
      segment,
      creditBand,
      cashAvailable: parseAmount(cash),
      monthlyBudget: parseAmount(budget),
      annualEnergyCost: parseAmount(energy),
      expectedStayYears: stay === '' ? null : Number(stay),
    }),
    [segment, creditBand, cash, budget, energy, stay],
  );

  const plan = useMemo(() => computeServiceFinancePlan(twin, economics), [twin, economics]);
  const p = plan.portfolio;

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Landmark size={16} className="text-cta" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold text-text-primary">Service Finance Decision Engine</p>
            <p className="text-xs text-text-secondary">
              Which financial structure fits each system’s real economics — cash, loan, lease, membership, repair or replacement.
            </p>
          </div>
        </div>
        <span className="rounded-full bg-border/50 px-2.5 py-0.5 text-[11px] text-text-secondary">{FINANCE_CONFIDENCE_LABELS[plan.confidence]}</span>
      </div>

      <fieldset className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <legend className="sr-only">Customer economics</legend>
        <div>
          <label htmlFor="sfd-segment" className="mb-1.5 block text-sm font-medium text-text-primary">Customer type</label>
          <select id="sfd-segment" className={selectClass} value={segment} onChange={(e) => setSegment(e.target.value as CustomerSegment)}>
            <option value="residential">Homeowner</option>
            <option value="commercial">Business / commercial</option>
          </select>
        </div>
        <div>
          <label htmlFor="sfd-credit" className="mb-1.5 block text-sm font-medium text-text-primary">Credit profile</label>
          <select id="sfd-credit" className={selectClass} value={creditBand} onChange={(e) => setCreditBand(e.target.value as CreditBand)}>
            {CREDIT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="sfd-stay" className="mb-1.5 block text-sm font-medium text-text-primary">Plans to keep the property</label>
          <select id="sfd-stay" className={selectClass} value={stay} onChange={(e) => setStay(e.target.value)}>
            {STAY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <Input id="sfd-cash" label="Cash available ($)" inputMode="decimal" placeholder="Unknown" value={cash} onChange={(e) => setCash(sanitizeAmount(e.target.value))} />
        <Input id="sfd-budget" label="Max monthly payment ($)" inputMode="decimal" placeholder="No limit" value={budget} onChange={(e) => setBudget(sanitizeAmount(e.target.value))} />
        <Input id="sfd-energy" label="Annual energy bill ($)" inputMode="decimal" placeholder="Use typical" value={energy} onChange={(e) => setEnergy(sanitizeAmount(e.target.value))} />
      </fieldset>

      {plan.units.length === 0 ? (
        <p className="text-sm text-text-secondary">
          Record the HVAC, water heater, plumbing, electrical or roof equipment installed at this property and Vireek will work out the best financial path for each system.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
            <Kpi label="Act now" value={String(p.replaceNowCount)} hint={`${p.planCount} to plan · ${p.monitorCount} to monitor`} />
            <Kpi label="Customer cash today" value={usd(p.upfrontCashNow)} />
            <Kpi label="Financed / month" value={usd(p.monthlyPaymentsNow)} hint={`${usd(p.financedVolumeNow)} financed`} />
            <Kpi label="Your net revenue now" value={usd(p.netRevenueNow)} hint={p.financingFeesNow > 0 ? `after ${usd(p.financingFeesNow)} lender fees` : undefined} />
            <Kpi label="24-month pipeline" value={usd(p.pipelineGross24m)} hint="replacements to pre-qualify" />
            <Kpi label={`Customer saves (${plan.horizonYears} yr)`} value={usd(p.totalSavingsVsRepair)} hint="vs repair & hold" />
          </div>

          <p className="mt-3 flex items-start gap-1 text-[11px] text-text-secondary">
            <TrendingUp size={11} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              Costs are today’s dollars over {plan.horizonYears} years, weighted across optimistic, expected and pessimistic failure scenarios.
              {p.recurringRevenue > 0 ? ` Membership recommendations add ${usd(p.recurringRevenue)}/yr of recurring revenue.` : ''}
            </span>
          </p>

          <ul className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-2">
            {plan.units.map((unit) => (
              <UnitCard key={unit.equipmentId} unit={unit} years={plan.horizonYears} />
            ))}
          </ul>
        </>
      )}

      <details className="group mt-4 rounded-xl border border-border bg-bg-primary p-3">
        <summary className="focus-ring flex cursor-pointer list-none items-center justify-between gap-2 rounded text-xs font-medium text-text-primary">
          <span className="flex items-center gap-1.5">
            <PiggyBank size={13} className="text-cta" aria-hidden="true" /> Assumptions &amp; limits
          </span>
          <ChevronDown size={14} className="text-text-secondary transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        <ul className="mt-2 list-disc space-y-1 pl-4 text-[11px] text-text-secondary">
          {plan.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
