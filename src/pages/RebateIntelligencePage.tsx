import { useCallback, useEffect, useId, useState } from 'react';
import { BadgeDollarSign, Plus, Trash2 } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCard } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  APPLICATION_STATUSES,
  EMPTY_PROGRAM_FORM,
  LEVEL_LABELS,
  MEASURE_LABELS,
  MEASURE_OPTIONS,
  STAGE_META,
  STATUS_META,
  addPrivateProgram,
  deleteApplication,
  deletePrivateProgram,
  dollarsToCents,
  fetchApplications,
  fetchCustomerEquipment,
  fetchPickerCustomers,
  fetchPrograms,
  formatUsd,
  runRebateAnalysis,
  trackIncentive,
  updateApplication,
} from '@/lib/rebateIntelligence';
import type {
  ApplicationRow,
  ApplicationStatus,
  MeasureType,
  OptionResult,
  PickerCustomer,
  PickerEquipment,
  ProgramForm,
  ProgramRow,
  RebateAnalysisResult,
  ReplacementOption,
} from '@/lib/rebateIntelligence';

interface OptionForm {
  label: string;
  measure: MeasureType;
  cost: string;
  seer2: string;
  hspf2: string;
  afue: string;
  energyStar: '' | 'yes' | 'no';
  tons: string;
  savings: string;
  mfr: string;
}

const EMPTY_OPTION: OptionForm = { label: '', measure: 'heat_pump_hvac', cost: '', seer2: '', hspf2: '', afue: '', energyStar: '', tons: '', savings: '', mfr: '' };
const MAX_OPTIONS = 3;

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent';
const sectionClass = 'mb-8 rounded-2xl border border-border bg-bg-secondary p-5';
const chip = 'rounded-full px-2.5 py-0.5 text-xs font-medium';

const optNum = (v: string): number | null => (v.trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v));

function buildOption(f: OptionForm, i: number): ReplacementOption | null {
  const cost = dollarsToCents(f.cost);
  if (cost === null || cost <= 0) return null;
  const efficiency: ReplacementOption['efficiency'] = {};
  const seer2 = optNum(f.seer2);
  const hspf2 = optNum(f.hspf2);
  const afue = optNum(f.afue);
  if (seer2 !== null) efficiency.seer2 = seer2;
  if (hspf2 !== null) efficiency.hspf2 = hspf2;
  if (afue !== null) efficiency.afue = afue;
  return {
    key: `option-${i + 1}`,
    label: f.label.trim() || `Option ${i + 1}`,
    measure: f.measure,
    installed_cost_cents: cost,
    efficiency,
    energy_star: f.energyStar === '' ? undefined : f.energyStar === 'yes',
    tons: optNum(f.tons),
    manufacturer_rebate_cents: dollarsToCents(f.mfr),
    annual_energy_savings_cents: dollarsToCents(f.savings),
  };
}

export function RebateIntelligencePage() {
  const { user, isOwner, teamMember } = useAuth();
  const { toast } = useToast();
  const uid = useId();
  const ownerId = teamMember?.account_owner_id ?? user?.id ?? '';

  const [customers, setCustomers] = useState<PickerCustomer[]>([]);
  const [customersLoading, setCustomersLoading] = useState(true);
  const [customerId, setCustomerId] = useState('');
  const [equipment, setEquipment] = useState<PickerEquipment[]>([]);
  const [equipmentId, setEquipmentId] = useState('');

  const [state, setState] = useState('');
  const [zip, setZip] = useState('');
  const [utility, setUtility] = useState('');
  const [ami, setAmi] = useState('');
  const [occupied, setOccupied] = useState<'' | 'yes' | 'no'>('');
  const [targetDate, setTargetDate] = useState('');
  const [apr, setApr] = useState('');
  const [term, setTerm] = useState('');
  const [options, setOptions] = useState<OptionForm[]>([{ ...EMPTY_OPTION }]);

  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RebateAnalysisResult | null>(null);

  const [applications, setApplications] = useState<ApplicationRow[]>([]);
  const [programs, setPrograms] = useState<ProgramRow[]>([]);
  const [progForm, setProgForm] = useState<ProgramForm>(EMPTY_PROGRAM_FORM);
  const [savingProgram, setSavingProgram] = useState(false);

  const reloadApplications = useCallback(async () => {
    try {
      setApplications(await fetchApplications());
    } catch {
      toast('Could not load your rebate pipeline.', 'error');
    }
  }, [toast]);

  const reloadPrograms = useCallback(async () => {
    try {
      setPrograms(await fetchPrograms());
    } catch {
      toast('Could not load the incentive catalog.', 'error');
    }
  }, [toast]);

  useEffect(() => {
    let cancelled = false;
    fetchPickerCustomers()
      .then((c) => !cancelled && setCustomers(c))
      .catch(() => !cancelled && toast('Could not load customers.', 'error'))
      .finally(() => !cancelled && setCustomersLoading(false));
    void reloadApplications();
    void reloadPrograms();
    return () => {
      cancelled = true;
    };
  }, [reloadApplications, reloadPrograms, toast]);

  useEffect(() => {
    setEquipmentId('');
    setEquipment([]);
    if (!customerId) return;
    let cancelled = false;
    fetchCustomerEquipment(customerId)
      .then((e) => !cancelled && setEquipment(e))
      .catch(() => !cancelled && toast('Could not load this customer’s equipment.', 'error'));
    return () => {
      cancelled = true;
    };
  }, [customerId, toast]);

  const setOpt = (i: number, patch: Partial<OptionForm>) => setOptions((prev) => prev.map((o, idx) => (idx === i ? { ...o, ...patch } : o)));

  const handleRun = async () => {
    if (!customerId) return toast('Pick a customer first.', 'error');
    const built = options.map(buildOption);
    const valid = built.filter((o): o is ReplacementOption => o !== null);
    if (valid.length === 0) return toast('Add at least one option with an installed cost.', 'error');
    const aprPct = optNum(apr);
    const termMonths = optNum(term);
    setRunning(true);
    try {
      const res = await runRebateAnalysis({
        customerId,
        equipmentId: equipmentId || null,
        property: {
          state: state.trim(),
          postal_code: zip.trim(),
          utility_name: utility.trim(),
          household_ami_pct: optNum(ami),
          owner_occupied: occupied === '' ? null : occupied === 'yes',
          install_target_date: targetDate || null,
        },
        options: valid,
        financing: aprPct !== null && termMonths !== null ? { apr_bps: Math.round(aprPct * 100), term_months: Math.round(termMonths) } : null,
      });
      setResult(res);
      if (!res.persisted) toast('Analysis ran but could not be saved to history.', 'error');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not analyze incentives.', 'error');
    } finally {
      setRunning(false);
    }
  };

  const handleTrack = async (opt: OptionResult, evIndex: number) => {
    if (!result) return;
    try {
      await trackIncentive(ownerId, { customerId, analysisId: result.analysisId, optionKey: opt.key, ev: opt.incentives[evIndex] });
      toast('Added to your rebate pipeline.', 'success');
      void reloadApplications();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not track this incentive.', 'error');
    }
  };

  const handleAppUpdate = async (id: string, patch: Parameters<typeof updateApplication>[1]) => {
    try {
      await updateApplication(id, patch);
      void reloadApplications();
    } catch {
      toast('Could not update the application.', 'error');
    }
  };

  const handleAddProgram = async () => {
    if (!user) return;
    setSavingProgram(true);
    try {
      await addPrivateProgram(user.id, progForm);
      setProgForm(EMPTY_PROGRAM_FORM);
      toast('Program added to your catalog.', 'success');
      void reloadPrograms();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not add the program.', 'error');
    } finally {
      setSavingProgram(false);
    }
  };

  const report = result?.report ?? null;
  const ranked = report ? [...report.options].sort((a, b) => a.rank - b.rank) : [];
  const platformCount = programs.filter((p) => p.owner_user_id === null).length;
  const privatePrograms = programs.filter((p) => p.owner_user_id !== null);

  return (
    <DashboardLayout activeLabel="Rebate Intelligence">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <BadgeDollarSign size={24} aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-xl font-bold text-text-primary">Energy + Rebate Intelligence</h1>
            <p className="text-sm text-text-secondary">
              Property, equipment age, utility territory, federal / state / utility / manufacturer incentives and financing in one replacement proposal. Every estimate shows its confidence and its source.
            </p>
          </div>
        </div>

        {/* ---------------- Analyze ---------------- */}
        <section className={sectionClass} aria-labelledby={`${uid}-a`}>
          <h2 id={`${uid}-a`} className="mb-3 text-sm font-semibold text-text-primary">Analyze a replacement</h2>
          {customersLoading ? (
            <SkeletonCard rows={3} withIcon={false} />
          ) : customers.length === 0 ? (
            <EmptyState icon={BadgeDollarSign} title="No customers yet" description="Add a customer first, then come back to find the best incentives for their replacement." />
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor={`${uid}-c`} className="mb-1.5 block text-sm font-medium text-text-primary">Customer</label>
                  <select id={`${uid}-c`} value={customerId} onChange={(e) => setCustomerId(e.target.value)} className={selectClass}>
                    <option value="">Select a customer…</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor={`${uid}-e`} className="mb-1.5 block text-sm font-medium text-text-primary">Equipment being replaced (optional)</label>
                  <select id={`${uid}-e`} value={equipmentId} onChange={(e) => setEquipmentId(e.target.value)} disabled={!customerId} className={selectClass}>
                    <option value="">None / not on file</option>
                    {equipment.map((e) => (
                      <option key={e.id} value={e.id}>
                        {[e.make, e.model].filter(Boolean).join(' ') || e.equipment_type}
                        {e.install_date ? ` · installed ${e.install_date.slice(0, 4)}` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <h3 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-text-secondary">Property</h3>
              <div className="grid gap-3 sm:grid-cols-3">
                <Input label="State" value={state} onChange={(e) => setState(e.target.value)} placeholder="TX" maxLength={2} />
                <Input label="ZIP code" value={zip} onChange={(e) => setZip(e.target.value)} placeholder="78701" inputMode="numeric" maxLength={5} />
                <Input label="Electric / gas utility" value={utility} onChange={(e) => setUtility(e.target.value)} placeholder="Auto from ZIP if known" />
                <Input label="Household income (% of area median)" type="number" inputMode="decimal" min={0} value={ami} onChange={(e) => setAmi(e.target.value)} helperText="Unlocks income-qualified rebates. Leave blank if unknown." />
                <div>
                  <label htmlFor={`${uid}-o`} className="mb-1.5 block text-sm font-medium text-text-primary">Owner-occupied?</label>
                  <select id={`${uid}-o`} value={occupied} onChange={(e) => setOccupied(e.target.value as '' | 'yes' | 'no')} className={selectClass}>
                    <option value="">Unknown</option>
                    <option value="yes">Yes</option>
                    <option value="no">No (rental / investor)</option>
                  </select>
                </div>
                <Input label="Planned install date" type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} helperText="Programs are checked against this date." />
              </div>

              <h3 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-text-secondary">Replacement options (up to {MAX_OPTIONS})</h3>
              <div className="space-y-3">
                {options.map((o, i) => (
                  <div key={i} className="rounded-xl border border-border bg-bg-primary p-3">
                    <div className="grid gap-3 sm:grid-cols-3">
                      <Input label="Name" value={o.label} onChange={(e) => setOpt(i, { label: e.target.value })} placeholder="e.g. 18 SEER2 heat pump" />
                      <div>
                        <label htmlFor={`${uid}-m${i}`} className="mb-1.5 block text-sm font-medium text-text-primary">Equipment type</label>
                        <select id={`${uid}-m${i}`} value={o.measure} onChange={(e) => setOpt(i, { measure: e.target.value as MeasureType })} className={selectClass}>
                          {MEASURE_OPTIONS.map((m) => (
                            <option key={m.value} value={m.value}>{m.label}</option>
                          ))}
                        </select>
                      </div>
                      <Input label="Installed cost ($)" type="number" inputMode="decimal" min={0} value={o.cost} onChange={(e) => setOpt(i, { cost: e.target.value })} />
                      <Input label="SEER2" type="number" inputMode="decimal" value={o.seer2} onChange={(e) => setOpt(i, { seer2: e.target.value })} />
                      <Input label="HSPF2" type="number" inputMode="decimal" value={o.hspf2} onChange={(e) => setOpt(i, { hspf2: e.target.value })} />
                      <Input label="AFUE (%)" type="number" inputMode="decimal" value={o.afue} onChange={(e) => setOpt(i, { afue: e.target.value })} />
                      <div>
                        <label htmlFor={`${uid}-s${i}`} className="mb-1.5 block text-sm font-medium text-text-primary">ENERGY STAR?</label>
                        <select id={`${uid}-s${i}`} value={o.energyStar} onChange={(e) => setOpt(i, { energyStar: e.target.value as '' | 'yes' | 'no' })} className={selectClass}>
                          <option value="">Unknown</option>
                          <option value="yes">Yes</option>
                          <option value="no">No</option>
                        </select>
                      </div>
                      <Input label="Size (tons)" type="number" inputMode="decimal" value={o.tons} onChange={(e) => setOpt(i, { tons: e.target.value })} />
                      <Input label="Manufacturer rebate ($)" type="number" inputMode="decimal" min={0} value={o.mfr} onChange={(e) => setOpt(i, { mfr: e.target.value })} />
                      <Input label="Est. yearly energy savings ($)" type="number" inputMode="decimal" min={0} value={o.savings} onChange={(e) => setOpt(i, { savings: e.target.value })} helperText="Enter for every option to rank by 10-year cost." />
                    </div>
                    {options.length > 1 && (
                      <button type="button" onClick={() => setOptions((prev) => prev.filter((_, idx) => idx !== i))} className="focus-ring mt-2 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-text-secondary hover:text-danger-500">
                        <Trash2 size={14} aria-hidden="true" /> Remove option
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {options.length < MAX_OPTIONS && (
                <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => setOptions((prev) => [...prev, { ...EMPTY_OPTION }])}>
                  <Plus size={14} aria-hidden="true" /> Add option
                </Button>
              )}

              <h3 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-text-secondary">Financing (optional)</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <Input label="APR (%)" type="number" inputMode="decimal" min={0} step="0.01" value={apr} onChange={(e) => setApr(e.target.value)} helperText="Use your lender's real offer; the engine never assumes a rate." />
                <Input label="Term (months)" type="number" inputMode="numeric" min={3} value={term} onChange={(e) => setTerm(e.target.value)} />
              </div>

              <div className="mt-5">
                <Button type="button" variant="primary" onClick={handleRun} disabled={running}>
                  {running ? 'Analyzing…' : 'Find incentives'}
                </Button>
              </div>
            </>
          )}
        </section>

        {/* ---------------- Results ---------------- */}
        {report && (
          <section className={sectionClass} aria-live="polite" aria-labelledby={`${uid}-r`}>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h2 id={`${uid}-r`} className="text-sm font-semibold text-text-primary">Results</h2>
              <span className={`${chip} ${STAGE_META[report.replacement_signal.stage].tone}`}>{STAGE_META[report.replacement_signal.stage].label}</span>
              {report.utilities_resolved.length > 0 && <span className={`${chip} bg-bg-primary text-text-secondary`}>Utility: {report.utilities_resolved.join(', ')}</span>}
            </div>
            <p className="mb-3 text-sm text-text-primary">{report.replacement_signal.headline}</p>

            {report.deadline_alerts.length > 0 && (
              <div className="mb-3 rounded-xl border border-warning-500/40 bg-warning-500/10 p-3 text-sm text-text-primary">
                {report.deadline_alerts.map((d) => (
                  <p key={d.program}><strong>{d.program}</strong> ends {d.end_date} ({d.days_left} days left).</p>
                ))}
              </div>
            )}
            {report.data_quality.warnings.length > 0 && (
              <ul className="mb-4 list-disc space-y-1 pl-5 text-xs text-text-secondary">
                {report.data_quality.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}

            <div className="space-y-4">
              {ranked.map((opt) => (
                <article key={opt.key} className={`rounded-2xl border p-4 ${opt.rank === 1 ? 'border-accent bg-accent/5' : 'border-border bg-bg-primary'}`}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 className="text-base font-semibold text-text-primary">
                        {opt.label} {opt.rank === 1 && <span className={`${chip} ml-1 bg-accent/10 text-accent`}>Best option</span>}
                      </h3>
                      <p className="text-xs text-text-secondary">{MEASURE_LABELS[opt.measure]} · installed price {formatUsd(opt.gross_cost_cents)}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-2xl font-bold text-text-primary">{formatUsd(opt.net_cost_expected_cents)}</p>
                      <p className="text-xs text-text-secondary">expected net cost · range {formatUsd(opt.net_cost_best_case_cents)}–{formatUsd(opt.net_cost_conservative_cents)}</p>
                    </div>
                  </div>

                  <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-4">
                    <div><dt className="text-text-secondary">Expected incentives</dt><dd className="font-medium text-text-primary">{formatUsd(opt.total_expected_cents)}</dd></div>
                    <div><dt className="text-text-secondary">Customer pays at install</dt><dd className="font-medium text-text-primary">{formatUsd(opt.upfront_cash_cents)}</dd></div>
                    <div><dt className="text-text-secondary">Unlockable with more info</dt><dd className="font-medium text-text-primary">{formatUsd(opt.upside_cents)}</dd></div>
                    <div><dt className="text-text-secondary">Payback</dt><dd className="font-medium text-text-primary">{opt.payback_years === null ? 'n/a' : `${opt.payback_years} yrs`}</dd></div>
                  </dl>

                  {opt.financing && (
                    <p className="mt-3 rounded-lg bg-bg-secondary p-2 text-xs text-text-secondary">
                      Monthly at {(opt.financing.apr_bps / 100).toFixed(2)}% for {opt.financing.term_months} mo: {formatUsd(opt.financing.monthly_no_incentives_cents)} without incentives · {formatUsd(opt.financing.monthly_after_point_of_sale_cents)} after point-of-sale discounts · {formatUsd(opt.financing.monthly_if_rebates_paid_down_cents)} if rebates are applied to the loan.
                    </p>
                  )}

                  {opt.incentives.length === 0 ? (
                    <p className="mt-3 text-sm text-text-secondary">No qualifying incentives found for this option.</p>
                  ) : (
                    <ul className="mt-3 space-y-2">
                      {opt.incentives.map((ev, idx) => (
                        <li key={ev.program_id} className="rounded-xl border border-border bg-bg-secondary p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-text-primary">{ev.name}</p>
                              <p className="text-xs text-text-secondary">
                                {LEVEL_LABELS[ev.level]}{ev.is_private ? ' · yours' : ''} · confidence {Math.round(ev.confidence * 100)}%
                                {ev.realization.scope !== 'prior' ? ` · ${Math.round(ev.realization.rate * 100)}% approval rate (${ev.realization.decided} ${ev.realization.scope === 'network' ? 'network' : 'your'} outcomes)` : ''}
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className={`${chip} ${STATUS_META[ev.status].tone}`}>{STATUS_META[ev.status].label}</span>
                              <span className="text-sm font-semibold text-text-primary">{formatUsd(ev.amount_cents)}</span>
                            </div>
                          </div>
                          {ev.missing.length > 0 && <p className="mt-1 text-xs text-accent">Needed: {ev.missing.join('; ')}</p>}
                          {ev.warnings.length > 0 && <p className="mt-1 text-xs text-text-secondary">{ev.warnings.join(' ')}</p>}
                          <div className="mt-2 flex flex-wrap items-center gap-3">
                            <Button type="button" variant="secondary" size="sm" onClick={() => handleTrack(opt, idx)}>Track in pipeline</Button>
                            {ev.source_url && (
                              <a href={ev.source_url} target="_blank" rel="noopener noreferrer" className="focus-ring text-xs text-accent underline">Source</a>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}

                  {opt.excluded.length > 0 && (
                    <details className="mt-3">
                      <summary className="cursor-pointer text-xs font-medium text-text-secondary">Why {opt.excluded.length} program{opt.excluded.length === 1 ? ' was' : 's were'} excluded</summary>
                      <ul className="mt-2 space-y-1 text-xs text-text-secondary">
                        {opt.excluded.map((x) => (
                          <li key={x.slug}><strong className="text-text-primary">{x.name}:</strong> {x.reason}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </article>
              ))}
            </div>

            {report.actions.length > 0 && (
              <div className="mt-5">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Do this next</h3>
                <ol className="list-decimal space-y-1 pl-5 text-sm text-text-primary">
                  {report.actions.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ol>
              </div>
            )}
            <p className="mt-4 text-xs text-text-secondary">{report.disclaimer}</p>
          </section>
        )}

        {/* ---------------- Pipeline ---------------- */}
        <section className={sectionClass} aria-labelledby={`${uid}-p`}>
          <h2 id={`${uid}-p`} className="mb-1 text-sm font-semibold text-text-primary">Rebate pipeline</h2>
          <p className="mb-4 text-xs text-text-secondary">Record what actually happens to each application. Approval and payment outcomes make every future estimate more accurate.</p>
          {applications.length === 0 ? (
            <EmptyState icon={BadgeDollarSign} title="Nothing tracked yet" description="Use “Track in pipeline” on any incentive above." />
          ) : (
            <ul className="space-y-2">
              {applications.map((a) => (
                <li key={a.id} className="rounded-xl border border-border bg-bg-primary p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-text-primary">{a.program_name}</p>
                      <p className="text-xs text-text-secondary">{a.customers?.name ?? 'Customer'} · est. {formatUsd(a.estimated_cents)}{a.approved_cents !== null ? ` · approved ${formatUsd(a.approved_cents)}` : ''}{a.paid_cents !== null ? ` · paid ${formatUsd(a.paid_cents)}` : ''}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <select aria-label={`Status for ${a.program_name}`} value={a.status} onChange={(e) => handleAppUpdate(a.id, { status: e.target.value as ApplicationStatus })} className="focus-ring rounded-lg border border-border bg-bg-secondary px-2 py-1.5 text-sm text-text-primary">
                        {APPLICATION_STATUSES.map((s) => (
                          <option key={s.value} value={s.value}>{s.label}</option>
                        ))}
                      </select>
                      <button type="button" aria-label={`Delete ${a.program_name}`} onClick={async () => { try { await deleteApplication(a.id); void reloadApplications(); } catch { toast('Could not delete.', 'error'); } }} className="focus-ring rounded-lg p-2 text-text-secondary hover:text-danger-500">
                        <Trash2 size={16} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                  {(a.status === 'approved' || a.status === 'paid') && (
                    <input
                      type="number"
                      min={0}
                      aria-label={a.status === 'paid' ? 'Amount paid in dollars' : 'Amount approved in dollars'}
                      placeholder={a.status === 'paid' ? 'Amount paid ($)' : 'Amount approved ($)'}
                      defaultValue={((a.status === 'paid' ? a.paid_cents : a.approved_cents) ?? '') === '' ? '' : String(((a.status === 'paid' ? a.paid_cents : a.approved_cents) as number) / 100)}
                      onBlur={(e) => {
                        const c = dollarsToCents(e.target.value);
                        if (c !== null) void handleAppUpdate(a.id, a.status === 'paid' ? { paid_cents: c } : { approved_cents: c });
                      }}
                      className="focus-ring mt-2 w-48 rounded-lg border border-border bg-bg-secondary px-3 py-1.5 text-sm text-text-primary"
                    />
                  )}
                  {a.status === 'denied' && (
                    <input
                      type="text"
                      aria-label="Denial reason"
                      placeholder="Why was it denied?"
                      defaultValue={a.denial_reason ?? ''}
                      onBlur={(e) => void handleAppUpdate(a.id, { denial_reason: e.target.value.trim() || null })}
                      className="focus-ring mt-2 w-full rounded-lg border border-border bg-bg-secondary px-3 py-1.5 text-sm text-text-primary"
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ---------------- Catalog ---------------- */}
        <section className={sectionClass} aria-labelledby={`${uid}-g`}>
          <h2 id={`${uid}-g`} className="mb-1 text-sm font-semibold text-text-primary">Incentive catalog</h2>
          <p className="mb-4 text-xs text-text-secondary">
            {platformCount} platform program{platformCount === 1 ? '' : 's'} + {privatePrograms.length} of yours. The engine only uses programs in this catalog, it never invents one. Add the local utility and state programs you see in your market, with the source link.
            {!isOwner && ' Only the account owner can add programs.'}
          </p>

          {isOwner && (
            <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Input label="Program name" value={progForm.name} onChange={(e) => setProgForm({ ...progForm, name: e.target.value })} placeholder="e.g. Austin Energy heat pump rebate" />
              <div>
                <label htmlFor={`${uid}-pl`} className="mb-1.5 block text-sm font-medium text-text-primary">Level</label>
                <select id={`${uid}-pl`} value={progForm.level} onChange={(e) => setProgForm({ ...progForm, level: e.target.value as ProgramForm['level'] })} className={selectClass}>
                  {(Object.keys(LEVEL_LABELS) as (keyof typeof LEVEL_LABELS)[]).map((l) => (
                    <option key={l} value={l}>{LEVEL_LABELS[l]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={`${uid}-pm`} className="mb-1.5 block text-sm font-medium text-text-primary">Equipment covered</label>
                <select id={`${uid}-pm`} value={progForm.measure} onChange={(e) => setProgForm({ ...progForm, measure: e.target.value as MeasureType })} className={selectClass}>
                  {MEASURE_OPTIONS.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>
              <Input label="State" value={progForm.state} onChange={(e) => setProgForm({ ...progForm, state: e.target.value })} placeholder="TX" maxLength={2} />
              <Input label="Utility (if utility-specific)" value={progForm.utility_name} onChange={(e) => setProgForm({ ...progForm, utility_name: e.target.value })} />
              <div>
                <label htmlFor={`${uid}-pt`} className="mb-1.5 block text-sm font-medium text-text-primary">Amount type</label>
                <select id={`${uid}-pt`} value={progForm.amount_type} onChange={(e) => setProgForm({ ...progForm, amount_type: e.target.value as ProgramForm['amount_type'] })} className={selectClass}>
                  <option value="flat">Flat ($)</option>
                  <option value="percent_of_cost">Percent of cost (%)</option>
                  <option value="per_ton">Per ton ($)</option>
                  <option value="per_unit">Per unit ($)</option>
                </select>
              </div>
              <Input label={progForm.amount_type === 'percent_of_cost' ? 'Percent (%)' : 'Amount ($)'} type="number" inputMode="decimal" min={0} value={progForm.amount} onChange={(e) => setProgForm({ ...progForm, amount: e.target.value })} />
              <Input label="Maximum ($, optional)" type="number" inputMode="decimal" min={0} value={progForm.max_amount} onChange={(e) => setProgForm({ ...progForm, max_amount: e.target.value })} />
              <Input label="Minimum SEER2 (optional)" type="number" inputMode="decimal" min={0} value={progForm.min_seer2} onChange={(e) => setProgForm({ ...progForm, min_seer2: e.target.value })} />
              <Input label="Ends on (optional)" type="date" value={progForm.end_date} onChange={(e) => setProgForm({ ...progForm, end_date: e.target.value })} />
              <Input label="Source link" value={progForm.source_url} onChange={(e) => setProgForm({ ...progForm, source_url: e.target.value })} placeholder="https://…" />
              <div className="flex items-end gap-3">
                <label className="flex items-center gap-2 text-sm text-text-primary">
                  <input type="checkbox" checked={progForm.pre_approval} onChange={(e) => setProgForm({ ...progForm, pre_approval: e.target.checked })} /> Needs pre-approval
                </label>
                <Button type="button" variant="primary" size="sm" onClick={handleAddProgram} disabled={savingProgram}>
                  {savingProgram ? 'Adding…' : 'Add program'}
                </Button>
              </div>
            </div>
          )}

          {privatePrograms.length > 0 && (
            <ul className="space-y-2">
              {privatePrograms.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-primary p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-text-primary">{p.name}</p>
                    <p className="text-xs text-text-secondary">
                      {LEVEL_LABELS[p.level]}{p.jurisdiction_state ? ` · ${p.jurisdiction_state}` : ''}{p.utility_name ? ` · ${p.utility_name}` : ''} · {p.measure_types.map((m) => MEASURE_LABELS[m as MeasureType] ?? m).join(', ')} · {p.amount_type === 'percent_of_cost' ? `${p.amount_value}%` : formatUsd(p.amount_value)}
                    </p>
                  </div>
                  {isOwner && (
                    <button type="button" aria-label={`Delete ${p.name}`} onClick={async () => { try { await deletePrivateProgram(p.id); void reloadPrograms(); } catch { toast('Could not delete the program.', 'error'); } }} className="focus-ring rounded-lg p-2 text-text-secondary hover:text-danger-500">
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </DashboardLayout>
  );
}
