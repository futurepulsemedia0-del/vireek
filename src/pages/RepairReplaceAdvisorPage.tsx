import { useEffect, useId, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Copy, Download, Scale } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCard } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { fetchCustomerEquipment, fetchPickerCustomers, MEASURE_OPTIONS, dollarsToCents } from '@/lib/rebateIntelligence';
import type { MeasureType, PickerCustomer, PickerEquipment, ReplacementOption } from '@/lib/rebateIntelligence';
import { adviseRepairOrReplace, AdvisorInputError, usd, ADVISOR_HORIZON_YEARS } from '@/lib/repairReplaceAdvisor';
import type { AdvisorInput, AdvisorResult, EfficiencyRatings, RebateSummary } from '@/lib/repairReplaceAdvisor';
import { analyzeReplacementRebates, fetchProposalBusinessName, loadAdvisorContext } from '@/lib/repairReplaceAdvisorApi';
import type { AdvisorContext } from '@/lib/repairReplaceAdvisorApi';
import { parseUsAddress, suggestMeasure } from '@/lib/repairReplaceAdvisorInputs';
import { buildProposal, proposalFileName, proposalToText } from '@/lib/repairReplaceProposal';
import type { CreditBand } from '@/lib/serviceFinance';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent';
const sectionClass = 'mb-6 rounded-2xl border border-border bg-bg-secondary p-5';
const h3Class = 'mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-text-secondary';
const TONE = { replace: 'text-accent', repair: 'text-success-500', neutral: 'text-text-secondary' } as const;

const num = (v: string): number | null => (v.trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const ratings = (a: string, b: string, c: string, d: string): EfficiencyRatings => ({ seer2: num(a), hspf2: num(b), afue: num(c), uef: num(d) });

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-text-primary">{label}</label>
      {children}
    </div>
  );
}

function CostChart({ result }: { result: AdvisorResult }) {
  const w = 520, h = 180, pad = 36;
  const series = [
    { label: 'Repair', pts: result.repair.cumulativeByYear, cls: 'stroke-success-500' },
    { label: 'Replace', pts: result.replace.cumulativeByYear, cls: 'stroke-accent' },
  ];
  const max = Math.max(1, ...series.flatMap((s) => s.pts));
  const x = (i: number) => pad + (i * (w - pad * 2)) / (ADVISOR_HORIZON_YEARS - 1);
  const y = (v: number) => h - pad - (v / max) * (h - pad * 2);
  return (
    <figure>
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Cumulative expected spending over five years, repair versus replace" className="w-full">
        {series.map((s) => (
          <g key={s.label}>
            <polyline fill="none" strokeWidth="2.5" className={s.cls} points={s.pts.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />
            {s.pts.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r="3" className={`${s.cls} fill-bg-secondary`} strokeWidth="2" />)}
          </g>
        ))}
        {series[0].pts.map((_, i) => <text key={i} x={x(i)} y={h - 10} textAnchor="middle" className="fill-text-secondary text-[10px]">Year {i + 1}</text>)}
        <text x={pad} y={14} className="fill-text-secondary text-[10px]">{usd(max)}</text>
      </svg>
      <figcaption className="mt-1 flex gap-4 text-xs text-text-secondary">
        <span className="text-success-500">● Repair</span><span className="text-accent">● Replace</span><span>Cumulative expected spending</span>
      </figcaption>
    </figure>
  );
}

export function RepairReplaceAdvisorPage() {
  const { user, teamMember } = useAuth();
  const { toast } = useToast();
  const uid = useId();
  const [params] = useSearchParams();
  const ownerId = teamMember?.account_owner_id ?? user?.id ?? '';

  const [customers, setCustomers] = useState<PickerCustomer[]>([]);
  const [loadingCustomers, setLoadingCustomers] = useState(true);
  const [customerId, setCustomerId] = useState('');
  const [equipment, setEquipment] = useState<PickerEquipment[]>([]);
  const [equipmentId, setEquipmentId] = useState(params.get('equipment') ?? '');
  const [ctx, setCtx] = useState<AdvisorContext | null>(null);
  const [loadingCtx, setLoadingCtx] = useState(false);

  const [quote, setQuote] = useState('');
  const [unitDown, setUnitDown] = useState(false);
  const [oldEff, setOldEff] = useState({ seer2: '', hspf2: '', afue: '', uef: '' });
  const [label, setLabel] = useState('');
  const [measure, setMeasure] = useState<MeasureType>('central_ac');
  const [cost, setCost] = useState('');
  const [newEff, setNewEff] = useState({ seer2: '', hspf2: '', afue: '', uef: '' });
  const [mfr, setMfr] = useState('');
  const [savings, setSavings] = useState('');
  const [systemEnergy, setSystemEnergy] = useState('');
  const [state, setState] = useState('');
  const [zip, setZip] = useState('');
  const [utility, setUtility] = useState('');
  const [ami, setAmi] = useState('');
  const [occupied, setOccupied] = useState<'' | 'yes' | 'no'>('');
  const [credit, setCredit] = useState<CreditBand>('unknown');
  const [cash, setCash] = useState('');
  const [budget, setBudget] = useState('');
  const [lenderApr, setLenderApr] = useState('');
  const [lenderTerm, setLenderTerm] = useState('');
  const [business, setBusiness] = useState('');

  const [running, setRunning] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [result, setResult] = useState<AdvisorResult | null>(null);
  const [rebateNote, setRebateNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPickerCustomers()
      .then((c) => !cancelled && setCustomers(c))
      .catch(() => !cancelled && toast('Could not load customers.', 'error'))
      .finally(() => !cancelled && setLoadingCustomers(false));
    if (ownerId) void fetchProposalBusinessName(ownerId).then((n) => !cancelled && n && setBusiness((b) => b || n));
    return () => { cancelled = true; };
  }, [ownerId, toast]);

  useEffect(() => {
    setEquipment([]);
    if (!customerId) return;
    let cancelled = false;
    fetchCustomerEquipment(customerId)
      .then((e) => !cancelled && setEquipment(e))
      .catch(() => !cancelled && toast('Could not load this customer’s equipment.', 'error'));
    return () => { cancelled = true; };
  }, [customerId, toast]);

  // Load everything known about the machine whenever it changes (also handles ?equipment= deep links).
  useEffect(() => {
    setCtx(null);
    setResult(null);
    if (!equipmentId) return;
    let cancelled = false;
    setLoadingCtx(true);
    loadAdvisorContext(equipmentId)
      .then((c) => {
        if (cancelled) return;
        setCtx(c);
        setCustomerId((cur) => cur || c.equipment.customer_id);
        setMeasure(suggestMeasure(c.equipment.equipment_type, c.equipment.make, c.equipment.model));
        const addr = parseUsAddress(c.customer?.address);
        setState((s) => s || addr.state);
        setZip((z) => z || addr.zip);
        setLabel((l) => l || `New ${[c.equipment.make, c.equipment.equipment_type].filter(Boolean).join(' ')}`.trim());
        if (c.unavailable.length > 0) toast(`Some history could not be loaded (${c.unavailable.join(', ')}). The advice will note what is missing.`, 'info');
      })
      .catch((e) => !cancelled && toast(e instanceof Error ? e.message : 'Could not load this equipment.', 'error'))
      .finally(() => !cancelled && setLoadingCtx(false));
    return () => { cancelled = true; };
  }, [equipmentId, toast]);

  const proposal = useMemo(
    () =>
      result && ctx
        ? buildProposal(result, {
            now: Date.parse(result.generatedAt),
            businessName: business.trim() || null,
            customerName: ctx.customer?.name ?? 'Customer',
            customerAddress: ctx.customer?.address ?? null,
            passportUrl: ctx.passport?.url ?? null,
          })
        : null,
    [result, ctx, business],
  );

  const handleRun = async () => {
    if (!ctx) return toast('Pick the equipment first.', 'error');
    const installed = dollarsToCents(cost);
    if (installed === null || installed <= 0) return toast('Enter the installed price of the replacement unit.', 'error');
    setRunning(true);
    setRebateNote(null);
    try {
      const newRatings = ratings(newEff.seer2, newEff.hspf2, newEff.afue, newEff.uef);
      const mfrCents = dollarsToCents(mfr);
      const savingsCents = dollarsToCents(savings);
      const option: ReplacementOption = {
        key: 'advisor-replacement',
        label: label.trim() || 'Replacement unit',
        measure,
        installed_cost_cents: installed,
        efficiency: Object.fromEntries(Object.entries(newRatings).filter(([, v]) => v !== null && v !== undefined)) as ReplacementOption['efficiency'],
        manufacturer_rebate_cents: mfrCents,
        annual_energy_savings_cents: savingsCents,
      };
      let rebates: RebateSummary | null = null;
      try {
        const aprPct = num(lenderApr);
        const term = num(lenderTerm);
        rebates = (
          await analyzeReplacementRebates({
            customerId: ctx.equipment.customer_id,
            equipmentId: ctx.equipment.id,
            property: { state: state.trim(), postal_code: zip.trim(), utility_name: utility.trim(), household_ami_pct: num(ami), owner_occupied: occupied === '' ? null : occupied === 'yes' },
            option,
            financing: aprPct !== null && term !== null ? { apr_bps: Math.round(aprPct * 100), term_months: Math.round(term) } : null,
          })
        ).summary;
      } catch (e) {
        setRebateNote(e instanceof Error ? e.message : 'Rebates could not be analyzed.');
      }
      const aprPct = num(lenderApr);
      const term = num(lenderTerm);
      const eq = ctx.equipment;
      const input: AdvisorInput = {
        now: Date.now(),
        unit: {
          id: eq.id,
          label: [eq.make, eq.model].filter(Boolean).join(' ') || eq.equipment_type,
          equipmentType: eq.equipment_type,
          make: eq.make,
          model: eq.model,
          installDate: eq.install_date,
          expectedLifespanYears: eq.expected_lifespan_years,
          warrantyExpiresAt: eq.warranty_expires_at,
          lastServiceDate: eq.last_service_date,
          serviceIntervalMonths: eq.service_interval_months,
          efficiency: ratings(oldEff.seer2, oldEff.hspf2, oldEff.afue, oldEff.uef),
          isDown: unitDown,
        },
        history: ctx.history,
        forecast: ctx.forecast,
        repair: { quoteCents: dollarsToCents(quote) },
        replacement: { label: option.label, installedCostCents: installed, efficiency: newRatings, annualEnergySavingsCents: savingsCents },
        rebates,
        energy: { annualSystemCostCents: dollarsToCents(systemEnergy) },
        customer: {
          segment: ctx.customer?.customer_type === 'commercial' ? 'commercial' : 'residential',
          creditBand: credit,
          cashAvailableCents: dollarsToCents(cash),
          monthlyBudgetCents: dollarsToCents(budget),
        },
        lender: aprPct !== null && term !== null && term > 0 ? { aprBps: Math.round(aprPct * 100), termMonths: Math.round(term), label: 'Lender offer' } : null,
      };
      setResult(adviseRepairOrReplace(input));
    } catch (e) {
      toast(e instanceof AdvisorInputError ? e.problems[0] : 'Could not run the advisor. Please try again.', 'error');
    } finally {
      setRunning(false);
    }
  };

  const handlePdf = async () => {
    if (!proposal) return;
    setPdfBusy(true);
    try {
      const { buildProposalPdf } = await import('@/lib/repairReplaceProposalPdf');
      const blob = await buildProposalPdf(proposal);
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = proposalFileName(proposal.preparedFor, proposal.equipment.name, Date.parse(result?.generatedAt ?? '') || Date.now());
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
    } catch {
      toast('Could not generate the PDF. Please try again.', 'error');
    } finally {
      setPdfBusy(false);
    }
  };

  const handleCopy = async () => {
    if (!proposal) return;
    try {
      await navigator.clipboard.writeText(proposalToText(proposal));
      toast('Summary copied. Paste it into an email or text.', 'success');
    } catch {
      toast('Could not copy. Select the text manually.', 'error');
    }
  };

  const effGrid = (v: typeof oldEff, set: (n: typeof oldEff) => void) => (
    <div className="grid gap-3 sm:grid-cols-4">
      <Input label="SEER2" type="number" inputMode="decimal" value={v.seer2} onChange={(e) => set({ ...v, seer2: e.target.value })} />
      <Input label="HSPF2" type="number" inputMode="decimal" value={v.hspf2} onChange={(e) => set({ ...v, hspf2: e.target.value })} />
      <Input label="AFUE (%)" type="number" inputMode="decimal" value={v.afue} onChange={(e) => set({ ...v, afue: e.target.value })} />
      <Input label="UEF" type="number" inputMode="decimal" value={v.uef} onChange={(e) => set({ ...v, uef: e.target.value })} />
    </div>
  );

  return (
    <DashboardLayout activeLabel="Repair vs Replace">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Scale size={24} aria-hidden="true" /></span>
          <div>
            <h1 className="text-xl font-bold text-text-primary">Repair vs Replace Advisor</h1>
            <p className="text-sm text-text-secondary">Equipment passport, repair history, predicted failure risk, efficiency and rebates in one five-year comparison, with a customer-ready proposal.</p>
          </div>
        </div>

        <section className={sectionClass} aria-labelledby={`${uid}-s1`}>
          <h2 id={`${uid}-s1`} className="mb-3 text-sm font-semibold text-text-primary">1. Equipment</h2>
          {loadingCustomers ? (
            <SkeletonCard rows={2} withIcon={false} />
          ) : customers.length === 0 && !equipmentId ? (
            <EmptyState icon={Scale} title="No customers yet" description="Add a customer and their equipment first." />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Customer" id={`${uid}-c`}>
                <select id={`${uid}-c`} value={customerId} onChange={(e) => { setCustomerId(e.target.value); setEquipmentId(''); }} className={selectClass}>
                  <option value="">Select a customer…</option>
                  {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
              <Field label="Equipment" id={`${uid}-e`}>
                <select id={`${uid}-e`} value={equipmentId} onChange={(e) => setEquipmentId(e.target.value)} disabled={!customerId} className={selectClass}>
                  <option value="">Select equipment…</option>
                  {equipment.map((e) => (
                    <option key={e.id} value={e.id}>{[e.make, e.model].filter(Boolean).join(' ') || e.equipment_type}{e.install_date ? ` · installed ${e.install_date.slice(0, 4)}` : ''}</option>
                  ))}
                </select>
              </Field>
            </div>
          )}
          {loadingCtx && <div className="mt-3"><SkeletonCard rows={2} withIcon={false} /></div>}
          {ctx && (
            <p className="mt-3 text-xs text-text-secondary">
              Found {ctx.history.length} past repair{ctx.history.length === 1 ? '' : 's'}
              {ctx.forecast ? `, a ${ctx.forecast.band}-risk forecast (${Math.round(ctx.forecast.probability * 100)}% in ${ctx.forecast.horizonDays} days)` : ', no predictive forecast yet'}
              {ctx.passport ? ', and an Equipment Passport.' : ', and no verified Equipment Passport.'}
            </p>
          )}
        </section>

        {ctx && (
          <section className={sectionClass} aria-labelledby={`${uid}-s2`}>
            <h2 id={`${uid}-s2`} className="mb-3 text-sm font-semibold text-text-primary">2. The decision</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              <Input label="Repair quote ($)" type="number" inputMode="decimal" min={0} value={quote} onChange={(e) => setQuote(e.target.value)} helperText="Blank = a typical repair is assumed." />
              <label className="flex items-center gap-2 self-end pb-3 text-sm text-text-primary"><input type="checkbox" checked={unitDown} onChange={(e) => setUnitDown(e.target.checked)} /> Unit is down right now</label>
            </div>
            <h3 className={h3Class}>Replacement option</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <Input label="Name" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. 16 SEER2 heat pump" />
              <Field label="Equipment type (for rebates)" id={`${uid}-m`}>
                <select id={`${uid}-m`} value={measure} onChange={(e) => setMeasure(e.target.value as MeasureType)} className={selectClass}>
                  {MEASURE_OPTIONS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </Field>
              <Input label="Installed price ($)" type="number" inputMode="decimal" min={0} value={cost} onChange={(e) => setCost(e.target.value)} />
            </div>
            <h3 className={h3Class}>New unit ratings</h3>
            {effGrid(newEff, setNewEff)}
            <h3 className={h3Class}>Existing unit ratings (nameplate, optional)</h3>
            {effGrid(oldEff, setOldEff)}
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <Input label="Manufacturer rebate ($)" type="number" inputMode="decimal" min={0} value={mfr} onChange={(e) => setMfr(e.target.value)} />
              <Input label="Yearly energy savings ($)" type="number" inputMode="decimal" min={0} value={savings} onChange={(e) => setSavings(e.target.value)} helperText="Overrides the ratings-based estimate." />
              <Input label="Yearly energy cost of this system ($)" type="number" inputMode="decimal" min={0} value={systemEnergy} onChange={(e) => setSystemEnergy(e.target.value)} />
            </div>
            <h3 className={h3Class}>Property (for rebates)</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <Input label="State" value={state} onChange={(e) => setState(e.target.value)} maxLength={2} placeholder="TX" />
              <Input label="ZIP code" value={zip} onChange={(e) => setZip(e.target.value)} maxLength={5} inputMode="numeric" />
              <Input label="Utility" value={utility} onChange={(e) => setUtility(e.target.value)} placeholder="Auto from ZIP if known" />
              <Input label="Household income (% of area median)" type="number" inputMode="decimal" min={0} value={ami} onChange={(e) => setAmi(e.target.value)} />
              <Field label="Owner-occupied?" id={`${uid}-oc`}>
                <select id={`${uid}-oc`} value={occupied} onChange={(e) => setOccupied(e.target.value as '' | 'yes' | 'no')} className={selectClass}>
                  <option value="">Unknown</option><option value="yes">Yes</option><option value="no">No (rental / investor)</option>
                </select>
              </Field>
            </div>
            <h3 className={h3Class}>Customer and financing</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Credit (self-reported)" id={`${uid}-cr`}>
                <select id={`${uid}-cr`} value={credit} onChange={(e) => setCredit(e.target.value as CreditBand)} className={selectClass}>
                  <option value="unknown">Unknown</option><option value="excellent">Excellent</option><option value="good">Good</option><option value="fair">Fair</option><option value="poor">Poor</option>
                </select>
              </Field>
              <Input label="Cash available ($)" type="number" inputMode="decimal" min={0} value={cash} onChange={(e) => setCash(e.target.value)} />
              <Input label="Comfortable monthly payment ($)" type="number" inputMode="decimal" min={0} value={budget} onChange={(e) => setBudget(e.target.value)} />
              <Input label="Lender offer APR (%)" type="number" inputMode="decimal" min={0} value={lenderApr} onChange={(e) => setLenderApr(e.target.value)} helperText="Only if you have a real offer." />
              <Input label="Lender offer term (months)" type="number" inputMode="numeric" min={1} value={lenderTerm} onChange={(e) => setLenderTerm(e.target.value)} />
              <Input label="Business name on proposal" value={business} onChange={(e) => setBusiness(e.target.value)} />
            </div>
            <div className="mt-5"><Button onClick={handleRun} disabled={running}>{running ? 'Analyzing…' : 'Get recommendation'}</Button></div>
          </section>
        )}

        {result && proposal && (
          <>
            <section className={`${sectionClass} border-accent/40`} aria-live="polite">
              <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                {result.strength === 'toss_up' ? 'Close call' : result.strength === 'lean' ? 'Leaning' : 'Clear recommendation'} · {result.confidence} confidence
              </p>
              <h2 className="mt-1 text-2xl font-bold text-text-primary">{proposal.headline}</h2>
              <p className="mt-2 text-sm text-text-secondary">{proposal.summary}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button size="sm" onClick={handlePdf} disabled={pdfBusy}><Download size={16} aria-hidden="true" />{pdfBusy ? 'Building…' : 'Download proposal PDF'}</Button>
                <Button size="sm" variant="secondary" onClick={handleCopy}><Copy size={16} aria-hidden="true" />Copy summary</Button>
              </div>
              {rebateNote && <p className="mt-3 text-xs text-warning-500" role="status">Rebates were left out: {rebateNote}</p>}
            </section>

            <section className={sectionClass}>
              <h2 className="mb-3 text-sm font-semibold text-text-primary">Five-year comparison</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-text-secondary"><th className="py-1 pr-3 font-medium"> </th><th className="py-1 pr-3 text-right font-medium">Repair</th><th className="py-1 text-right font-medium">Replace</th></tr></thead>
                  <tbody>
                    {proposal.comparison.map((c) => (
                      <tr key={c.label} className="border-t border-border"><td className="py-2 pr-3 text-text-primary">{c.label}</td><td className="py-2 pr-3 text-right tabular-nums">{c.repair}</td><td className="py-2 text-right tabular-nums">{c.replace}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-4"><CostChart result={result} /></div>
              <p className="mt-3 text-xs text-text-secondary">
                Risk of another breakdown: {Math.round(result.risk.risk12m * 100)}% within a year, {Math.round(result.risk.risk5y * 100)}% within five. Scenarios: {result.scenarios.map((s) => `${s.label} → ${s.winner}`).join(' · ')}.
              </p>
            </section>

            <section className={sectionClass}>
              <h2 className="mb-3 text-sm font-semibold text-text-primary">Why</h2>
              <ul className="space-y-2 text-sm">
                {result.reasons.map((r) => <li key={r.id} className={`${TONE[r.tone]} flex gap-2`}><span aria-hidden="true">●</span><span className="text-text-primary">{r.text}</span></li>)}
              </ul>
              <h3 className={h3Class}>Rules of thumb</h3>
              <ul className="space-y-1 text-xs text-text-secondary">
                {result.rules.map((r) => <li key={r.id}>{r.triggered ? '⚠︎' : '✓'} {r.label}: {r.detail}</li>)}
              </ul>
            </section>

            {result.financing.length > 0 && (
              <section className={sectionClass}>
                <h2 className="mb-3 text-sm font-semibold text-text-primary">Financing a replacement</h2>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-text-secondary"><th className="py-1 pr-3 font-medium">Option</th><th className="py-1 pr-3 text-right font-medium">Monthly</th><th className="py-1 pr-3 text-right font-medium">Interest</th><th className="py-1 text-right font-medium">Net of energy savings</th></tr></thead>
                    <tbody>
                      {result.financing.map((f) => (
                        <tr key={f.id} className={`border-t border-border ${f.feasible ? '' : 'opacity-50'}`}>
                          <td className="py-2 pr-3">{f.label}{f.recommended ? ' ★' : ''}{f.aprBps !== null ? ` · ${(f.aprBps / 100).toFixed(2)}%${f.aprSource === 'planning_estimate' ? ' est.' : ''}` : ''}{!f.feasible && f.reason ? ` — ${f.reason}` : ''}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{f.monthlyCents !== null ? usd(f.monthlyCents) : f.kind === 'cash' ? usd(f.totalPaidCents) : '—'}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{f.kind === 'cash' ? '—' : usd(f.interestCents)}</td>
                          <td className="py-2 text-right tabular-nums">{f.monthlyNetOfEnergySavingsCents !== null ? usd(f.monthlyNetOfEnergySavingsCents) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-xs text-text-secondary">Rates marked “est.” are planning estimates by credit band, not an offer.</p>
              </section>
            )}

            <section className={sectionClass}>
              <h2 className="mb-3 text-sm font-semibold text-text-primary">Behind the numbers (not shown to the customer)</h2>
              {result.dataGaps.length > 0 && (<><h3 className={h3Class}>Missing data</h3><ul className="list-disc space-y-1 pl-5 text-sm text-text-primary">{result.dataGaps.map((g) => <li key={g}>{g}</li>)}</ul></>)}
              <h3 className={h3Class}>Assumptions</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm text-text-secondary">{result.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
              {result.rebates && result.rebates.warnings.length > 0 && (<><h3 className={h3Class}>Rebate warnings</h3><ul className="list-disc space-y-1 pl-5 text-sm text-text-secondary">{result.rebates.warnings.map((w) => <li key={w}>{w}</li>)}</ul></>)}
            </section>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
