/**
 * Vireek Home Risk & Capital Underwriting — /dashboard/homes/:siteId/capital-plan
 *
 * Current risk, a dynamic 1–10 year capital plan, and one-click hand-offs of every
 * recommendation into Service (job), Quote, Financing, Warranty and the Marketplace.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  AlertTriangle, ArrowLeft, BadgeCheck, CalendarClock, ChevronDown, FileText, Landmark, Loader2, PiggyBank,
  ShieldCheck, Store, Wrench, Save, Gauge, Zap,
} from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { formatSiteLocationLine } from '@/lib/siteHierarchy';
import {
  ACTION_LABELS, DEFAULT_RISK_TOLERANCE, FUNDING_LABELS, GRADE_TIERS, URGENCY_LABELS,
  computeHomeCapitalUnderwriting,
  type CapitalItem, type HomeCapitalUnderwriting, type RiskGrade, type Urgency,
} from '@/lib/homeCapitalUnderwriting';
import {
  ACTION_STATUS_LABELS, createFinancingFromItem, createJobFromItem, createQuoteFromItem, createWarrantyClaimFromItem,
  errorMessage, fetchCapitalActions, fetchCapitalInputs, fetchPlanHistory, saveCapitalPlan, setActionStatus,
  type CapitalActionRow, type CapitalInputs, type CapitalPlanHistoryRow, type HandoffContext,
} from '@/lib/homeCapitalUnderwritingApi';
import type { CreditBand } from '@/lib/serviceFinance';

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd = (n: number) => USD.format(Math.round(n));
const pct = (n: number) => `${Math.round(n * 100)}%`;
const monthYear = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

const inputClass = 'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60';
const labelClass = 'mb-1.5 block text-xs font-medium text-text-secondary';
const primaryBtn = 'focus-ring flex items-center gap-1.5 rounded-xl bg-cta px-3.5 py-2 text-xs font-semibold text-white disabled:opacity-50';
const smallBtn = 'focus-ring flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-accent/50 hover:text-accent disabled:opacity-50';

const URGENCY_STYLE: Record<Urgency, string> = {
  critical: 'bg-danger/10 text-danger', high: 'bg-warning-500/10 text-warning-500', medium: 'bg-accent/10 text-accent', low: 'bg-bg-primary text-text-secondary',
};
const GRADE_STYLE: Record<RiskGrade, string> = {
  A: 'text-success-500', B: 'text-success-500', C: 'text-accent', D: 'text-warning-500', E: 'text-danger',
};
const CREDIT_OPTIONS: ReadonlyArray<{ value: CreditBand; label: string }> = [
  { value: 'unknown', label: 'Not known yet' }, { value: 'excellent', label: 'Excellent (740+)' }, { value: 'good', label: 'Good (680–739)' },
  { value: 'fair', label: 'Fair (620–679)' }, { value: 'poor', label: 'Below 620' },
];
const TOLERANCE_OPTIONS = [0.15, 0.2, 0.3, 0.4, 0.5];

const parseAmount = (raw: string): number | null => {
  const cleaned = raw.replace(/[^\d.]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

function Card({ title, children, action }: { title?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5">
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {title && <p className="text-sm font-semibold text-text-primary">{title}</p>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

function Stat({ icon, label, value, note }: { icon: React.ReactNode; label: string; value: string; note?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5">
      <div className="mb-2 flex items-center gap-2 text-text-secondary">{icon}<span className="text-xs font-medium">{label}</span></div>
      <p className="text-2xl font-semibold tabular-nums text-text-primary">{value}</p>
      {note && <p className="mt-1.5 text-[11px] text-text-secondary">{note}</p>}
    </div>
  );
}

function Bar({ value, tone }: { value: number; tone: 'ok' | 'warn' | 'bad' }) {
  const color = tone === 'ok' ? 'bg-success-500' : tone === 'warn' ? 'bg-warning-500' : 'bg-danger';
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-primary" role="img" aria-label={`${Math.round(value)} of 100`}>
      <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
    </div>
  );
}

// ------------------------------------------------------------------- item row

interface ItemRowProps {
  item: CapitalItem;
  row: CapitalActionRow | undefined;
  busy: string | null;
  onRun: (key: string, label: string, fn: () => Promise<unknown>, success: string) => void;
  ctx: () => Promise<HandoffContext>;
  inputs: CapitalInputs;
  schemaReady: boolean;
}

function ItemRow({ item, row, busy, onRun, ctx, inputs, schemaReady }: ItemRowProps) {
  const [open, setOpen] = useState(false);
  const unit = item.equipmentId ? inputs.graph.twin.equipment.find((e) => e.id === item.equipmentId) : undefined;
  const financed = item.funding.method === 'loan' || item.funding.method === 'lease';
  const done = row?.status === 'completed' || row?.status === 'dismissed';
  const b = (suffix: string) => busy === `${item.key}:${suffix}`;
  const anyBusy = busy !== null;

  return (
    <div className={`rounded-xl border border-border bg-bg-primary ${done ? 'opacity-60' : ''}`}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="focus-ring flex w-full items-start justify-between gap-3 rounded-xl p-4 text-left">
        <div className="min-w-0">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${URGENCY_STYLE[item.urgency]}`}>{URGENCY_LABELS[item.urgency]}</span>
            <span className="rounded-full bg-bg-secondary px-2 py-0.5 text-[11px] font-medium text-text-secondary">{ACTION_LABELS[item.action]}</span>
            {!item.actionable && <span className="rounded-full bg-warning-500/10 px-2 py-0.5 text-[11px] font-medium text-warning-500">Estimate — verify first</span>}
            {row && row.status !== 'open' && <span className="rounded-full bg-success-500/10 px-2 py-0.5 text-[11px] font-medium text-success-500">{ACTION_STATUS_LABELS[row.status]}</span>}
          </div>
          <p className="text-sm font-semibold text-text-primary">{item.title}</p>
          <p className="mt-1 text-xs text-text-secondary">
            {item.timing.targetMonths === 0 ? 'Now' : monthYear(item.timing.target)} · {usd(item.costLow)}–{usd(item.costHigh)}
            {item.riskReduction > 0 ? ` · cuts failure risk by ${Math.round(item.riskReduction * 100)} pts` : ''}
          </p>
        </div>
        <ChevronDown size={16} className={`mt-1 shrink-0 text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="space-y-4 border-t border-border p-4">
          <p className="text-sm text-text-secondary">{item.rationale}</p>
          <div className="grid gap-3 text-xs sm:grid-cols-3">
            <div><p className="text-text-secondary">Best window</p><p className="font-medium text-text-primary">{monthYear(item.timing.windowStart)} – {monthYear(item.timing.windowEnd)}</p><p className="mt-0.5 text-[11px] text-text-secondary">{item.timing.note}</p></div>
            <div><p className="text-text-secondary">Risk (12 months)</p><p className="font-medium text-text-primary">{pct(item.risk12mBefore)} → {pct(item.risk12mAfter)}</p><p className="mt-0.5 text-[11px] text-text-secondary">Expected loss avoided {usd(item.expectedLossAvoided)}</p></div>
            <div><p className="text-text-secondary">Funding</p><p className="font-medium text-text-primary">{FUNDING_LABELS[item.funding.method]}{item.funding.monthlyPayment > 0 ? ` · ${usd(item.funding.monthlyPayment)}/mo × ${item.funding.termMonths}` : ''}</p><p className="mt-0.5 text-[11px] text-text-secondary">{item.funding.note}</p></div>
          </div>
          <p className="text-[11px] text-text-secondary">
            Net benefit {usd(item.netBenefit)}. {item.netBenefitNote}
            {item.funding.energySavingPerYear > 0 ? ` Expected energy saving ≈ ${usd(item.funding.energySavingPerYear)}/yr.` : ''}
          </p>
          {item.drivers.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-text-secondary">{item.drivers.map((d) => <li key={d}>{d}</li>)}</ul>
          )}

          <div className="flex flex-wrap gap-2">
            {item.actionable && (
              <>
                <button type="button" className={smallBtn} disabled={anyBusy || !!row?.quote_id}
                  onClick={() => onRun(`${item.key}:quote`, 'quote', async () => createQuoteFromItem(await ctx(), item), 'Draft quote created')}>
                  {b('quote') ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />}{row?.quote_id ? 'Quote created' : 'Create quote'}
                </button>
                <button type="button" className={smallBtn} disabled={anyBusy || !!row?.job_id}
                  onClick={() => onRun(`${item.key}:job`, 'job', async () => createJobFromItem(await ctx(), item), 'Job scheduled')}>
                  {b('job') ? <Loader2 size={12} className="animate-spin" /> : <CalendarClock size={12} />}{row?.job_id ? 'Job scheduled' : 'Schedule job'}
                </button>
              </>
            )}
            {item.actionable && item.connect.financeEligible && (financed || item.action === 'replace') && (
              <button type="button" className={smallBtn} disabled={anyBusy || !!row?.financing_offer_id}
                onClick={() => onRun(`${item.key}:finance`, 'financing', async () => {
                  const url = await createFinancingFromItem(await ctx(), item, row);
                  window.open(url, '_blank', 'noopener,noreferrer');
                }, 'Financing offer created')}>
                {b('finance') ? <Loader2 size={12} className="animate-spin" /> : <Landmark size={12} />}{row?.financing_offer_id ? 'Financing offered' : 'Offer financing'}
              </button>
            )}
            {item.warranty.claimEligible && unit && (
              <button type="button" className={smallBtn} disabled={anyBusy || !!row?.warranty_claim_id}
                onClick={() => onRun(`${item.key}:warranty`, 'warranty claim', async () => createWarrantyClaimFromItem(await ctx(), item, unit), 'Warranty claim opened')}>
                {b('warranty') ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}{row?.warranty_claim_id ? 'Claim opened' : 'Open warranty claim'}
              </button>
            )}
            {item.connect.marketplace === 'parts' && <Link to="/dashboard/parts-market" className={smallBtn}><Store size={12} /> Source parts</Link>}
            {item.action === 'replace' && item.actionable && <Link to="/dashboard/labor-marketplace" className={smallBtn}><Wrench size={12} /> Find installer</Link>}
            {item.connect.rebateEligible && <Link to="/dashboard/rebate-intelligence" className={smallBtn}><PiggyBank size={12} /> Check rebates</Link>}
            {row?.quote_id && <Link to="/dashboard/quotes" className={smallBtn}>View quotes</Link>}
            {row?.job_id && <Link to="/dashboard/jobs" className={smallBtn}>View jobs</Link>}
            {row?.warranty_claim_id && <Link to="/dashboard/warranty-claims" className={smallBtn}>View claim</Link>}
            {schemaReady && !done && (
              <>
                <button type="button" className={smallBtn} disabled={anyBusy}
                  onClick={() => onRun(`${item.key}:done`, 'status', async () => { const c = await ctx(); await setActionStatus(c.siteId, c.planId, item, 'completed'); }, 'Marked completed')}>
                  <BadgeCheck size={12} /> Mark completed
                </button>
                <button type="button" className={smallBtn} disabled={anyBusy}
                  onClick={() => onRun(`${item.key}:dismiss`, 'status', async () => { const c = await ctx(); await setActionStatus(c.siteId, c.planId, item, 'dismissed'); }, 'Dismissed')}>
                  Dismiss
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------ page

export function HomeCapitalPlanPage() {
  const { siteId } = useParams<{ siteId: string }>();
  const { toast } = useToast();
  const [inputs, setInputs] = useState<CapitalInputs | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [actions, setActions] = useState<CapitalActionRow[]>([]);
  const [schemaReady, setSchemaReady] = useState(true);
  const [history, setHistory] = useState<CapitalPlanHistoryRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [planId, setPlanId] = useState<string | null>(null);

  const [tolerance, setTolerance] = useState(DEFAULT_RISK_TOLERANCE);
  const [credit, setCredit] = useState<CreditBand>('unknown');
  const [segment, setSegment] = useState<'residential' | 'commercial'>('residential');
  const [cash, setCash] = useState('');
  const [reserve, setReserve] = useState('');

  const load = useCallback(async () => {
    if (!siteId) return;
    try {
      setError(null);
      const [data, acts, hist] = await Promise.all([fetchCapitalInputs(siteId), fetchCapitalActions(siteId), fetchPlanHistory(siteId).catch(() => [])]);
      setInputs(data);
      setActions(acts.rows);
      setSchemaReady(acts.schemaReady);
      setHistory(hist);
    } catch (e) {
      setError(errorMessage(e));
      setInputs(null);
    }
  }, [siteId]);

  useEffect(() => { void load(); }, [load]);

  const plan: HomeCapitalUnderwriting | null = useMemo(() => {
    if (!inputs) return null;
    return computeHomeCapitalUnderwriting(
      {
        twin: inputs.graph.twin, yearBuilt: inputs.graph.yearBuilt, energyReadings: inputs.energyReadings, warrantyClaims: inputs.graph.warrantyClaims,
        economics: { segment, creditBand: credit, cashAvailable: parseAmount(cash) },
      },
      { riskTolerance: tolerance, annualReserve: parseAmount(reserve) },
    );
  }, [inputs, tolerance, credit, segment, cash, reserve]);

  const rowByKey = useMemo(() => new Map(actions.map((a) => [a.item_key, a])), [actions]);
  const visibleItems = useMemo(() => (plan ? plan.items.filter((i) => rowByKey.get(i.key)?.status !== 'dismissed') : []), [plan, rowByKey]);

  /** Saves a snapshot once per session/plan so every hand-off points at the exact plan that produced it. */
  const ensurePlanId = useCallback(async (): Promise<string | null> => {
    if (planId) return planId;
    if (!plan || !siteId || !schemaReady) return null;
    const id = await saveCapitalPlan(siteId, plan, { tolerance, credit, segment, cash: parseAmount(cash), reserve: parseAmount(reserve), yearBuilt: inputs?.graph.yearBuilt ?? null });
    setPlanId(id);
    return id;
  }, [planId, plan, siteId, schemaReady, tolerance, credit, segment, cash, reserve, inputs]);

  // A different set of assumptions is a different plan: the next hand-off saves a fresh snapshot.
  useEffect(() => { setPlanId(null); }, [tolerance, credit, segment, cash, reserve]);

  const ctx = useCallback(async (): Promise<HandoffContext> => {
    if (!inputs || !siteId) throw new Error('The home is not loaded.');
    return { siteId, planId: await ensurePlanId(), customerId: inputs.graph.currentCustomerId, siteAddress: inputs.graph.twin.site?.address ?? null };
  }, [inputs, siteId, ensurePlanId]);

  const run = useCallback((key: string, label: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(key);
    void fn()
      .then(async () => {
        toast(success, 'success');
        if (siteId) {
          const acts = await fetchCapitalActions(siteId);
          setActions(acts.rows);
        }
      })
      .catch((e) => toast(`Could not complete ${label}: ${errorMessage(e)}`, 'error'))
      .finally(() => setBusy(null));
  }, [siteId, toast]);

  const saveSnapshot = () => {
    setBusy('snapshot');
    void ensurePlanId()
      .then(async () => {
        toast('Snapshot saved', 'success');
        if (siteId) setHistory(await fetchPlanHistory(siteId));
      })
      .catch((e) => toast(`Could not save the snapshot: ${errorMessage(e)}`, 'error'))
      .finally(() => setBusy(null));
  };

  const shell = (body: React.ReactNode) => <DashboardLayout activeLabel="Sites">{body}</DashboardLayout>;
  if (inputs === undefined) return shell(<div className="flex h-64 items-center justify-center"><Loader2 className="animate-spin" /></div>);
  if (!inputs) return shell(<div className="p-6"><p className="text-sm text-text-secondary">{error ?? 'This home could not be found.'}</p></div>);

  const site = inputs.graph.twin.site;
  const backHref = `/dashboard/homes/${inputs.graph.siteId}`;

  return shell(
    <div className="space-y-6 p-6">
      <Link to={backHref} className="focus-ring flex w-fit items-center gap-1.5 text-xs font-medium text-text-secondary hover:text-text-primary">
        <ArrowLeft size={12} /> Back to Home Lifetime Graph
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Gauge className="text-cta" size={20} />
          <div>
            <p className="text-sm font-semibold text-text-primary">{site?.name ?? 'Home'} — Risk & Capital Underwriting</p>
            <p className="text-xs text-text-secondary">
              {site && formatSiteLocationLine(site) ? formatSiteLocationLine(site) : ''}{site?.address ? ` · ${site.address}` : ''}{inputs.graph.yearBuilt ? ` · built ${inputs.graph.yearBuilt}` : ''}
            </p>
          </div>
        </div>
        {plan && schemaReady && (
          <button type="button" className={primaryBtn} disabled={busy !== null} onClick={saveSnapshot}>
            {busy === 'snapshot' ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save snapshot
          </button>
        )}
      </div>

      {!schemaReady && (
        <div className="rounded-xl border border-warning-500/40 bg-warning-500/10 p-4 text-sm text-warning-500">
          Run the 20270410000000_home_capital_underwriting migration to save snapshots and track quotes, jobs, financing and warranty claims per recommendation. The plan itself works without it.
        </div>
      )}

      <Card title="Assumptions you control">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <label className={labelClass} htmlFor="hcp-tol">Replace before failure risk reaches</label>
            <select id="hcp-tol" className={inputClass} value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))}>
              {TOLERANCE_OPTIONS.map((t) => <option key={t} value={t}>{pct(t)}{t === DEFAULT_RISK_TOLERANCE ? ' (default)' : ''}</option>)}
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="hcp-seg">Customer type</label>
            <select id="hcp-seg" className={inputClass} value={segment} onChange={(e) => setSegment(e.target.value as 'residential' | 'commercial')}>
              <option value="residential">Residential</option><option value="commercial">Commercial</option>
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="hcp-credit">Credit band</label>
            <select id="hcp-credit" className={inputClass} value={credit} onChange={(e) => setCredit(e.target.value as CreditBand)}>
              {CREDIT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="hcp-cash">Cash available ($)</label>
            <input id="hcp-cash" className={inputClass} inputMode="decimal" placeholder="Unknown" value={cash} onChange={(e) => setCash(e.target.value)} />
          </div>
          <div>
            <label className={labelClass} htmlFor="hcp-res">Set aside per year ($)</label>
            <input id="hcp-res" className={inputClass} inputMode="decimal" placeholder="Optional" value={reserve} onChange={(e) => setReserve(e.target.value)} />
          </div>
        </div>
      </Card>

      {!plan ? (
        <Card>
          <p className="text-sm text-text-secondary">
            There is nothing to underwrite yet. Add equipment to this home or set its year built, and the plan will appear.
          </p>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Underwriting risk index">
              <div className="mb-3 flex items-end gap-3">
                <p className="text-5xl font-semibold tabular-nums text-text-primary">{plan.summary.riskIndex}<span className="text-lg text-text-secondary">/100</span></p>
                <div className="pb-1">
                  <p className={`text-2xl font-semibold ${GRADE_STYLE[plan.summary.grade]}`}>Grade {plan.summary.grade}</p>
                  <p className="text-xs text-text-secondary">{GRADE_TIERS[plan.summary.grade]} · likely {plan.summary.riskIndexLow}–{plan.summary.riskIndexHigh}</p>
                </div>
              </div>
              <p className="mb-3 text-[11px] text-text-secondary">Higher means riskier. The range is wider when the records are thin ({plan.confidence} confidence, {plan.completenessPct}% of inputs connected).</p>
              <div className="space-y-2.5">
                {plan.summary.components.map((c) => (
                  <div key={c.key} title={c.detail}>
                    <div className="mb-1 flex justify-between text-xs text-text-secondary"><span>{c.label} · {Math.round(c.weight * 100)}%</span><span>{c.value}</span></div>
                    <Bar value={c.value} tone={c.value < 35 ? 'ok' : c.value < 65 ? 'warn' : 'bad'} />
                  </div>
                ))}
              </div>
            </Card>

            <div className="grid content-start gap-4 sm:grid-cols-2 lg:col-span-2">
              <Stat icon={<AlertTriangle size={14} />} label="Failure risk, next 12 months" value={pct(plan.summary.risk12m)} note={`${pct(plan.summary.riskAfter12m)} if the plan is followed · expected loss ${usd(plan.summary.expectedLoss12m)}`} />
              <Stat icon={<Zap size={14} />} label="Needed in the next 12 months" value={usd(plan.summary.capital.next12m)} note={`${usd(plan.summary.capital.years1to5)} over 5 years`} />
              <Stat icon={<Landmark size={14} />} label="10-year capital need" value={usd(plan.summary.capital.tenYear)} note={`${usd(plan.summary.capital.tenYearReplacements)} is replacements`} />
              <Stat icon={<PiggyBank size={14} />} label="Monthly reserve that never runs short" value={usd(plan.summary.reserve.suggestedMonthly)}
                note={plan.summary.reserve.fundingGap === null ? 'Enter what is set aside per year to see the gap.' : plan.summary.reserve.fundingGap > 0 ? `Gap vs. your reserve: ${usd(plan.summary.reserve.fundingGap)}` : 'Your reserve covers the plan.'} />
            </div>
          </div>

          <Card title={`Recommended actions (${visibleItems.length})`}>
            <div className="space-y-3">
              {visibleItems.length === 0 && <p className="text-sm text-text-secondary">No action is recommended right now.</p>}
              {visibleItems.map((item) => (
                <ItemRow key={item.key} item={item} row={rowByKey.get(item.key)} busy={busy} onRun={run} ctx={ctx} inputs={inputs} schemaReady={schemaReady} />
              ))}
            </div>
          </Card>

          <Card title="10-year Home Capital Plan">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-xs">
                <thead className="text-text-secondary">
                  <tr><th className="pb-2 pr-3 font-medium">Year</th><th className="pb-2 pr-3 font-medium">Replacements</th><th className="pb-2 pr-3 font-medium">Maintenance + inspections</th><th className="pb-2 pr-3 font-medium">Expected repairs</th><th className="pb-2 pr-3 font-medium">Total</th><th className="pb-2 pr-3 font-medium">Loan payments</th><th className="pb-2 font-medium">Cash out</th></tr>
                </thead>
                <tbody className="text-text-primary">
                  {plan.years.map((y) => (
                    <tr key={y.year} className="border-t border-border tabular-nums">
                      <td className="py-2 pr-3 font-medium">{y.calendarYear}</td>
                      <td className="py-2 pr-3">{y.replacements > 0 ? usd(y.replacements) : '—'}</td>
                      <td className="py-2 pr-3">{usd(y.maintenance + y.inspections)}</td>
                      <td className="py-2 pr-3">{usd(y.contingency)}</td>
                      <td className="py-2 pr-3 font-medium">{usd(y.total)}</td>
                      <td className="py-2 pr-3">{y.debtService > 0 ? usd(y.debtService) : '—'}</td>
                      <td className="py-2 font-medium">{usd(y.cashOut)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-[11px] text-text-secondary">Cash out = total − financed principal + loan payments. Reserve guidance is the smallest monthly amount that is never behind on cumulative cash out.</p>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Protection check">
              <p className="mb-2 text-sm font-medium text-text-primary">{plan.summary.protection.recommended ? 'Protection is worth considering' : 'Self-insuring looks reasonable'}</p>
              <p className="text-xs text-text-secondary">{plan.summary.protection.reason}</p>
              <p className="mt-2 text-[11px] text-text-secondary">Indicative cost {usd(plan.summary.protection.indicativeAnnualPremium)}/yr. Not an insurance quote.</p>
            </Card>
            <Card title="Make the plan more accurate">
              {plan.dataGaps.length === 0 ? <p className="text-xs text-text-secondary">All underwriting inputs are connected.</p> : (
                <ul className="space-y-2 text-xs text-text-secondary">
                  {plan.dataGaps.slice(0, 5).map((g) => <li key={g.key}><span className="font-medium text-text-primary">{g.label}:</span> {g.improve ?? g.detail}</li>)}
                </ul>
              )}
            </Card>
          </div>

          {history.length > 0 && (
            <Card title="Snapshot history">
              <div className="space-y-1.5 text-xs">
                {history.map((h) => (
                  <div key={h.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-bg-primary px-3 py-2 tabular-nums">
                    <span className="text-text-secondary">{new Date(h.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}</span>
                    <span className="text-text-primary">Index {h.risk_index} · Grade {h.grade}</span>
                    <span className="text-text-secondary">10-year {usd(h.ten_year_total_cents / 100)}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <Card title="How this was calculated">
            <ul className="list-disc space-y-1 pl-4 text-[11px] text-text-secondary">
              {plan.assumptions.map((a) => <li key={a}>{a}</li>)}
              <li>Decision support only — not a quote, a credit decision, an insurance offer or tax advice.</li>
            </ul>
          </Card>
        </>
      )}
    </div>,
  );
}
