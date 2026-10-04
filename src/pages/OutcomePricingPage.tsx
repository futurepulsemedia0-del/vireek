/**
 * Outcome Pricing — /dashboard/outcome-pricing
 *
 * Sell an outcome (uptime) instead of hours or jobs. Price a guarantee for a customer's
 * equipment, save it as a quote, activate it as a contract, then record monthly delivery
 * (downtime -> measured uptime -> SLA credit). Pricing math: src/lib/outcomePricing.ts.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, Gauge, Loader2, Save, XCircle } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { formatDollars } from '@/lib/decisionDebt';
import {
  allowedDowntimeHours,
  type AssetInput,
  type CostComponents,
  DECISION_LABELS,
  DEFAULT_ASSUMPTIONS,
  DEFAULT_CREDIT_SCHEDULE,
  type CreditTier,
  type Decision,
  type PricingAssumptions,
  type PricingResult,
  priceOutcomeGuarantee,
} from '@/lib/outcomePricing';
import {
  activateQuote,
  type CandidateAsset,
  closeQuote,
  countRepairVisits,
  type CustomerOption,
  dayAfter,
  deleteDraftQuote,
  fetchCandidateAssets,
  fetchCustomerOptions,
  fetchPricingSettings,
  fetchQuoteDetail,
  fetchQuotes,
  finalizeQuote,
  nextPeriodStart,
  type PeriodRow,
  periodEndFor,
  type PricingSettings,
  QUOTE_STATUS_COLORS,
  QUOTE_STATUS_LABELS,
  type QuoteAssetRow,
  type QuoteRow,
  recordPeriod,
  saveQuoteDraft,
  savePricingSettings,
  summarizeDelivery,
} from '@/lib/outcomePricingApi';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60';
const cardClass = 'rounded-2xl border border-border bg-bg-secondary p-4';
const btnPrimary = 'focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-60';
const btnGhost = 'focus-ring flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-60';

const DECISION_COLORS: Record<Decision, string> = {
  offerable: 'bg-success-500/10 text-success-500',
  needs_review: 'bg-warning-500/10 text-warning-500',
  not_offerable: 'bg-danger/10 text-danger',
};

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function errMsg(e: unknown, fallback: string): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e) return String((e as { message: unknown }).message);
  return fallback;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs text-text-secondary">{label}</label>
      {children}
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-3">
      <p className="text-[11px] text-text-secondary">{label}</p>
      <p className={`text-lg font-semibold ${tone ?? 'text-text-primary'}`}>{value}</p>
      {sub && <p className="text-[11px] text-text-secondary">{sub}</p>}
    </div>
  );
}

// ============================================================
// PRICING WORKSPACE
// ============================================================

interface AssetEdit {
  included: boolean;
  hours: number;
  downtimeCost: number;
}

const HOUR_PRESETS: Array<{ label: string; value: number }> = [
  { label: '24/7', value: 8760 },
  { label: '16/7', value: 5840 },
  { label: 'Business', value: 2600 },
];

const COMPONENT_META: Array<{ key: keyof CostComponents; label: string; color: string }> = [
  { key: 'maintenance', label: 'Preventive maintenance', color: 'bg-accent' },
  { key: 'intervention', label: 'Expected repairs', color: 'bg-accent/60' },
  { key: 'riskMargin', label: 'Risk premium', color: 'bg-warning-500' },
  { key: 'creditReserve', label: 'SLA credit reserve', color: 'bg-danger/70' },
  { key: 'overhead', label: 'Overhead', color: 'bg-text-secondary/40' },
  { key: 'margin', label: 'Margin', color: 'bg-success-500' },
];

function PricingWorkspace({ settings, onSaved }: { settings: PricingSettings; onSaved: () => void }) {
  const { toast } = useToast();
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [candidates, setCandidates] = useState<CandidateAsset[]>([]);
  const [edits, setEdits] = useState<Record<string, AssetEdit>>({});
  const [loadingAssets, setLoadingAssets] = useState(false);
  const [target, setTarget] = useState('98');
  const [term, setTerm] = useState(36);
  const [name, setName] = useState('');
  const [result, setResult] = useState<PricingResult | null>(null);
  const [resultSig, setResultSig] = useState('');
  const [resultAssets, setResultAssets] = useState<AssetInput[]>([]);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchCustomerOptions().then(setCustomers).catch(() => toast('Could not load customers', 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!customerId) {
      setCandidates([]);
      return;
    }
    let cancelled = false;
    setLoadingAssets(true);
    setResult(null);
    fetchCandidateAssets(customerId)
      .then((rows) => {
        if (cancelled) return;
        setCandidates(rows);
        setEdits(Object.fromEntries(rows.map((r) => [r.input.id, { included: true, hours: 8760, downtimeCost: 0 }])));
      })
      .catch((e) => {
        if (!cancelled) toast(errMsg(e, 'Could not load equipment'), 'error');
      })
      .finally(() => {
        if (!cancelled) setLoadingAssets(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  const inputs = useMemo<AssetInput[]>(
    () =>
      candidates
        .filter((c) => edits[c.input.id]?.included)
        .map((c) => ({
          ...c.input,
          operatingHoursPerYear: edits[c.input.id].hours,
          downtimeCostPerHour: edits[c.input.id].downtimeCost,
        })),
    [candidates, edits]
  );
  const signature = useMemo(() => JSON.stringify([customerId, target, term, inputs, settings]), [customerId, target, term, inputs, settings]);
  const stale = result !== null && resultSig !== signature;
  const customerName = customers.find((c) => c.id === customerId)?.name ?? '';

  const patchEdit = (id: string, patch: Partial<AssetEdit>) => setEdits((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  const run = (targetPct: number) => {
    if (!Number.isFinite(targetPct)) return setError('Enter a target uptime between 80 and 99.99.');
    setError(null);
    setRunning(true);
    const sig = JSON.stringify([customerId, String(targetPct), term, inputs, settings]);
    // Let the spinner paint before the (CPU-bound) simulation starts.
    window.setTimeout(() => {
      try {
        const r = priceOutcomeGuarantee({
          assets: inputs,
          targetUptimePct: targetPct,
          termMonths: term,
          assumptions: settings.assumptions,
          creditSchedule: settings.creditSchedule,
          annualCreditCapPct: settings.annualCreditCapPct,
        });
        setResult(r);
        setResultSig(sig);
        setResultAssets(inputs);
        setTarget(String(targetPct));
      } catch (e) {
        setResult(null);
        setError(errMsg(e, 'Could not price this guarantee.'));
      }
      setRunning(false);
    }, 30);
  };

  const handleSave = async () => {
    if (!result || !customerId) return;
    setSaving(true);
    try {
      await saveQuoteDraft({
        customerId,
        name: name.trim() || `${customerName} — ${result.targetUptimePct}% uptime guarantee`,
        result,
        assets: resultAssets,
        assumptions: settings.assumptions,
        creditSchedule: settings.creditSchedule,
        annualCreditCapPct: settings.annualCreditCapPct,
      });
      toast('Guarantee saved as a draft', 'success');
      onSaved();
    } catch (e) {
      toast(errMsg(e, 'Could not save this guarantee'), 'error');
    }
    setSaving(false);
  };

  const sumComponents = result ? Object.values(result.components).reduce((s, n) => s + n, 0) : 0;
  const allowedHours = inputs.length ? allowedDowntimeHours(Number(target) || 98, Math.max(...inputs.map((a) => a.operatingHoursPerYear))) : 0;

  return (
    <div className="space-y-4">
      <div className={`${cardClass} space-y-3`}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div className="sm:col-span-2">
            <Field label="Customer">
              <select className={inputClass} value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                <option value="">Select a customer…</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Uptime target %">
            <input className={inputClass} type="number" min="80" max="99.99" step="0.1" value={target} onChange={(e) => setTarget(e.target.value)} />
          </Field>
          <Field label="Term">
            <select className={inputClass} value={term} onChange={(e) => setTerm(Number(e.target.value))}>
              {[12, 24, 36, 48, 60].map((m) => (
                <option key={m} value={m}>{m} months</option>
              ))}
            </select>
          </Field>
        </div>

        {customerId && loadingAssets && <div className="h-16 animate-pulse rounded-xl bg-bg-tertiary" />}
        {customerId && !loadingAssets && candidates.length === 0 && (
          <p className="rounded-xl border border-dashed border-border p-4 text-center text-sm text-text-secondary">
            This customer has no active equipment. Add equipment on the customer page first — the guarantee is priced per asset.
          </p>
        )}

        {candidates.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead className="text-text-secondary">
                <tr>
                  <th className="py-1.5 pr-2 font-medium">Include</th>
                  <th className="py-1.5 pr-2 font-medium">Asset</th>
                  <th className="py-1.5 pr-2 font-medium">Age</th>
                  <th className="py-1.5 pr-2 font-medium">Repairs (history)</th>
                  <th className="py-1.5 pr-2 font-medium">Needs it running (h/yr)</th>
                  <th className="py-1.5 font-medium">Downtime cost $/h</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c) => {
                  const ed = edits[c.input.id];
                  if (!ed) return null;
                  return (
                    <tr key={c.input.id} className="border-t border-border align-top">
                      <td className="py-2 pr-2">
                        <input type="checkbox" checked={ed.included} onChange={(e) => patchEdit(c.input.id, { included: e.target.checked })} aria-label={`Include ${c.input.label}`} />
                      </td>
                      <td className="py-2 pr-2 text-text-primary">{c.input.label}</td>
                      <td className="py-2 pr-2 text-text-secondary">{c.input.ageYears} / {c.input.expectedLifespanYears} yr</td>
                      <td className="py-2 pr-2 text-text-secondary">
                        {c.repairEvents} in {c.input.observedYears.toFixed(1)} yr
                      </td>
                      <td className="py-2 pr-2">
                        <div className="flex items-center gap-1">
                          <input
                            className={`${inputClass} !w-24 !py-1`}
                            type="number"
                            min="100"
                            max="8760"
                            value={ed.hours}
                            onChange={(e) => patchEdit(c.input.id, { hours: Math.min(8760, Math.max(100, Number(e.target.value) || 100)) })}
                          />
                          {HOUR_PRESETS.map((p) => (
                            <button key={p.label} type="button" onClick={() => patchEdit(c.input.id, { hours: p.value })} className="focus-ring rounded-lg bg-bg-tertiary px-1.5 py-1 text-[10px] text-text-secondary hover:text-text-primary">
                              {p.label}
                            </button>
                          ))}
                        </div>
                      </td>
                      <td className="py-2">
                        <input className={`${inputClass} !w-24 !py-1`} type="number" min="0" value={ed.downtimeCost} onChange={(e) => patchEdit(c.input.id, { downtimeCost: Math.max(0, Number(e.target.value) || 0) })} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button type="button" disabled={running || inputs.length === 0} onClick={() => run(Number(target))} className={btnPrimary}>
            {running ? <Loader2 size={13} className="animate-spin" /> : <Gauge size={13} />} Price this guarantee
          </button>
          {inputs.length > 0 && (
            <span className="text-xs text-text-secondary">
              {target}% allows about {allowedHours} h of downtime per year on a 24/7 asset.
            </span>
          )}
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>

      {result && (
        <div className="space-y-4">
          {stale && (
            <p className="rounded-xl border border-warning-500/40 bg-warning-500/10 px-3 py-2 text-xs text-warning-500">
              Inputs changed since this price was calculated — price it again before saving.
            </p>
          )}

          <div className={`${cardClass} space-y-2`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${DECISION_COLORS[result.decision]}`}>
                {result.decision === 'offerable' ? <CheckCircle2 size={12} /> : result.decision === 'needs_review' ? <AlertTriangle size={12} /> : <XCircle size={12} />}
                {DECISION_LABELS[result.decision]}
              </span>
              <span className="text-xs text-text-secondary">Data confidence {Math.round(result.dataConfidence * 100)}%</span>
            </div>
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-text-secondary">
              {result.reasons.map((r) => <li key={r}>{r}</li>)}
            </ul>
          </div>

          {result.decision !== 'not_offerable' && (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Monthly fee" value={money(result.priceMonthlyCents)} />
                <Stat label="Annual price" value={money(result.priceAnnualCents)} />
                <Stat label={`${result.termMonths}-month value`} value={money(result.priceTermCents)} />
                <Stat label="Expected margin" value={`${result.risk.expectedMarginPct}%`} sub={`P10 ${result.risk.p10MarginPct}% · loss risk ${Math.round(result.risk.probabilityOfLoss * 100)}%`} />
              </div>

              <div className={cardClass}>
                <p className="mb-2 text-xs font-medium text-text-primary">Where the price comes from (per year)</p>
                <div className="flex h-3 w-full overflow-hidden rounded-full bg-bg-tertiary">
                  {COMPONENT_META.map((m) => (
                    <div key={m.key} className={m.color} style={{ width: `${sumComponents > 0 ? (result.components[m.key] / sumComponents) * 100 : 0}%` }} title={m.label} />
                  ))}
                </div>
                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
                  {COMPONENT_META.map((m) => (
                    <div key={m.key} className="flex items-center gap-1.5 text-[11px] text-text-secondary">
                      <span className={`inline-block h-2 w-2 rounded-full ${m.color}`} />
                      {m.label}: <span className="text-text-primary">{formatDollars(result.components[m.key])}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className={cardClass}>
                <p className="mb-2 text-xs font-medium text-text-primary">Customer business case</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Stat label="Same work, time & materials" value={formatDollars(result.value.tmEquivalentAnnual)} sub="expected per year" />
                  <Stat label="Downtime avoided" value={`${result.value.downtimeHoursAvoided} h`} sub="vs. no preventive plan" />
                  <Stat label="Value of that uptime" value={formatDollars(result.value.downtimeValueAvoided)} sub={result.value.downtimeValueAvoided === 0 ? 'enter $/h above' : 'per year'} />
                  <Stat
                    label="Net benefit to customer"
                    value={formatDollars(result.value.netBenefitAnnual)}
                    tone={result.value.netBenefitAnnual >= 0 ? 'text-success-500' : 'text-danger'}
                    sub={result.value.priceVsTmPct !== null ? `price ${result.value.priceVsTmPct > 0 ? '+' : ''}${result.value.priceVsTmPct}% vs T&M` : undefined}
                  />
                </div>
              </div>
            </>
          )}

          <div className={`${cardClass} overflow-x-auto`}>
            <p className="mb-2 text-xs font-medium text-text-primary">Per asset — plan Vireek would run</p>
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead className="text-text-secondary">
                <tr>
                  <th className="py-1.5 pr-2 font-medium">Asset</th>
                  <th className="py-1.5 pr-2 font-medium">PM visits/yr</th>
                  <th className="py-1.5 pr-2 font-medium">Failures/yr (as-is → plan)</th>
                  <th className="py-1.5 pr-2 font-medium">Exp. uptime</th>
                  <th className="py-1.5 pr-2 font-medium">P(meet target)</th>
                  <th className="py-1.5 font-medium">Annual price</th>
                </tr>
              </thead>
              <tbody>
                {result.assets.map((a) => (
                  <tr key={a.id} className="border-t border-border align-top">
                    <td className="py-2 pr-2 text-text-primary">
                      {a.label}
                      {a.notes.map((n) => <p key={n} className="mt-0.5 text-[11px] text-warning-500">{n}</p>)}
                    </td>
                    <td className="py-2 pr-2">{a.pmVisitsPerYear}</td>
                    <td className="py-2 pr-2">{a.baseFailuresPerYear} → {a.plannedFailuresPerYear}</td>
                    <td className="py-2 pr-2">{a.expectedUptimePct}%</td>
                    <td className={`py-2 pr-2 ${a.feasible ? 'text-text-primary' : 'text-danger'}`}>{Math.round(a.pMeetTarget * 100)}%</td>
                    <td className="py-2">{a.feasible ? money(a.priceAnnualCents) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={`${cardClass} overflow-x-auto`}>
            <p className="mb-2 text-xs font-medium text-text-primary">Price by target — pick a tier to re-price</p>
            <table className="w-full min-w-[480px] text-left text-xs">
              <thead className="text-text-secondary">
                <tr>
                  <th className="py-1.5 pr-2 font-medium">Target</th>
                  <th className="py-1.5 pr-2 font-medium">Annual price</th>
                  <th className="py-1.5 pr-2 font-medium">P(meet)</th>
                  <th className="py-1.5 pr-2 font-medium">Margin</th>
                  <th className="py-1.5 pr-2 font-medium">Status</th>
                  <th className="py-1.5" />
                </tr>
              </thead>
              <tbody>
                {result.curve.map((p) => (
                  <tr key={p.targetUptimePct} className="border-t border-border">
                    <td className="py-2 pr-2 text-text-primary">{p.targetUptimePct}%</td>
                    <td className="py-2 pr-2">{p.priceAnnual > 0 ? formatDollars(p.priceAnnual) : '—'}</td>
                    <td className="py-2 pr-2">{Math.round(p.pMeetTarget * 100)}%</td>
                    <td className="py-2 pr-2">{p.expectedMarginPct}%</td>
                    <td className="py-2 pr-2"><span className={`rounded-full px-2 py-0.5 text-[10px] ${DECISION_COLORS[p.decision]}`}>{DECISION_LABELS[p.decision]}</span></td>
                    <td className="py-2 text-right">
                      <button type="button" disabled={running} onClick={() => run(p.targetUptimePct)} className="focus-ring rounded-lg bg-bg-tertiary px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary">
                        Use
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={cardClass}>
            <p className="mb-2 text-xs font-medium text-text-primary">Delivery risk</p>
            <p className="text-xs text-text-secondary">
              Expected SLA credits {result.risk.expectedCreditPct}% of fees · 1-in-10 bad year {result.risk.p90CreditPct}% · chance of paying any credit {Math.round(result.risk.probabilityAnyCredit * 100)}%.
              Simulated with {settings.creditSchedule.length} credit tiers and a {settings.annualCreditCapPct}% annual cap.
            </p>
          </div>

          {result.decision !== 'not_offerable' && (
            <div className={`${cardClass} flex flex-wrap items-end gap-3`}>
              <div className="min-w-[220px] flex-1">
                <Field label="Guarantee name">
                  <input className={inputClass} placeholder={`${customerName} — ${result.targetUptimePct}% uptime guarantee`} value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
              </div>
              <button type="button" disabled={saving || stale} onClick={() => void handleSave()} className={btnPrimary}>
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save as draft
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// GUARANTEES (quotes + delivery)
// ============================================================

type Pending = { kind: 'delete' | 'decline' | 'cancel' | 'complete'; quote: QuoteRow } | null;

function DeliveryPanel({ quote, assets, periods, onChanged }: { quote: QuoteRow; assets: QuoteAssetRow[]; periods: PeriodRow[]; onChanged: () => void }) {
  const { toast } = useToast();
  const summary = useMemo(() => summarizeDelivery(quote, periods), [quote, periods]);
  const [assetId, setAssetId] = useState(assets[0]?.id ?? '');
  const [start, setStart] = useState(
    nextPeriodStart(quote, periods.filter((p) => p.asset_id === (assets[0]?.id ?? ''))) ?? ''
  );
  const asset = assets.find((a) => a.id === assetId);
  const defaultOperating = asset ? Math.round((asset.operating_hours_per_year / 12) * 60) : 0;
  const [operating, setOperating] = useState('');
  const [downtime, setDowntime] = useState('0');
  const [failures, setFailures] = useState('0');
  const [cost, setCost] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const periodEnd = start ? periodEndFor(start) : '';
  const opMin = operating === '' ? defaultOperating : Number(operating);
  const previewUptime = opMin > 0 ? ((1 - Number(downtime || 0) / opMin) * 100).toFixed(3) : '—';
  const assetLabel = (id: string) => assets.find((a) => a.id === id)?.label ?? 'Asset';

  const hint = async () => {
    if (!asset?.equipment_id || !start) return;
    try {
      const n = await countRepairVisits(asset.equipment_id, `${start}T00:00:00Z`, `${periodEnd}T23:59:59Z`);
      setFailures(String(n));
      toast(`${n} completed repair visit(s) linked to this asset in the period`, 'info');
    } catch {
      toast('Could not count linked repair visits', 'error');
    }
  };

  const submit = async () => {
    if (!asset || !start) return;
    setBusy(true);
    try {
      await recordPeriod({
        assetId: asset.id,
        periodStart: start,
        periodEnd,
        operatingMinutes: opMin,
        downtimeMinutes: Number(downtime || 0),
        failures: Number(failures || 0),
        actualCostCents: cost.trim() ? Math.round(Number(cost) * 100) : null,
        notes: notes.trim() || null,
      });
      toast('Period recorded', 'success');
      setStart(dayAfter(periodEnd));
      setDowntime('0');
      setFailures('0');
      setCost('');
      setNotes('');
      onChanged();
    } catch (e) {
      toast(errMsg(e, 'Could not record this period'), 'error');
    }
    setBusy(false);
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Periods recorded" value={String(summary.periods)} />
        <Stat label="Average uptime" value={summary.avgUptimePct !== null ? `${summary.avgUptimePct}%` : '—'} sub={summary.worstUptimePct !== null ? `worst month ${summary.worstUptimePct}%` : undefined} tone={summary.avgUptimePct !== null && summary.avgUptimePct < quote.target_uptime_pct ? 'text-danger' : undefined} />
        <Stat label="Credits owed" value={money(summary.creditOwedCents)} tone={summary.creditOwedCents > 0 ? 'text-danger' : undefined} sub={`of ${money(summary.billedCents)} billed`} />
        <Stat label="Actual delivery cost" value={money(summary.actualCostCents)} />
      </div>

      {quote.status === 'active' && (
        <div className="space-y-2 rounded-xl border border-border p-3">
          <p className="text-xs font-medium text-text-primary">Record a month</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Field label="Asset">
              <select
                className={inputClass}
                value={assetId}
                onChange={(e) => {
                  setAssetId(e.target.value);
                  setOperating('');
                  setStart(nextPeriodStart(quote, periods.filter((p) => p.asset_id === e.target.value)) ?? '');
                }}
              >
                {assets.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </Field>
            <Field label="Period start">
              <input className={inputClass} type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </Field>
            <Field label="Operating minutes">
              <input className={inputClass} type="number" min="1" placeholder={String(defaultOperating)} value={operating} onChange={(e) => setOperating(e.target.value)} />
            </Field>
            <Field label="Downtime minutes">
              <input className={inputClass} type="number" min="0" value={downtime} onChange={(e) => setDowntime(e.target.value)} />
            </Field>
            <Field label="Failures">
              <input className={inputClass} type="number" min="0" value={failures} onChange={(e) => setFailures(e.target.value)} />
            </Field>
            <Field label="Actual cost $ (optional)">
              <input className={inputClass} type="number" min="0" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} />
            </Field>
            <div className="col-span-2">
              <Field label="Notes (optional)">
                <input className={inputClass} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy || !asset || !start} onClick={() => void submit()} className={btnPrimary}>
              {busy && <Loader2 size={13} className="animate-spin" />} Record period
            </button>
            <button type="button" disabled={!asset?.equipment_id || !start} onClick={() => void hint()} className={btnGhost}>Count linked repair visits</button>
            <span className="text-xs text-text-secondary">
              {start && `${start} → ${periodEnd}`} · uptime {previewUptime}% vs target {quote.target_uptime_pct}%
            </span>
          </div>
        </div>
      )}

      {periods.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-xs">
            <thead className="text-text-secondary">
              <tr>
                <th className="py-1.5 pr-2 font-medium">Period</th>
                <th className="py-1.5 pr-2 font-medium">Asset</th>
                <th className="py-1.5 pr-2 font-medium">Uptime</th>
                <th className="py-1.5 pr-2 font-medium">Failures</th>
                <th className="py-1.5 pr-2 font-medium">Credit</th>
                <th className="py-1.5 font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {periods.map((p) => (
                <tr key={p.id} className="border-t border-border">
                  <td className="py-1.5 pr-2">{p.period_start}</td>
                  <td className="py-1.5 pr-2 text-text-primary">{assetLabel(p.asset_id)}</td>
                  <td className={`py-1.5 pr-2 ${Number(p.shortfall_pts) > 0 ? 'text-danger' : ''}`}>{Number(p.measured_uptime_pct).toFixed(3)}%</td>
                  <td className="py-1.5 pr-2">{p.failures}</td>
                  <td className="py-1.5 pr-2">{p.credit_cents > 0 ? `${money(p.credit_cents)} (${p.credit_pct}%)` : '—'}</td>
                  <td className="py-1.5">{p.actual_cost_cents != null ? money(p.actual_cost_cents) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function QuoteCard({ quote, onChanged, onPending }: { quote: QuoteRow; onChanged: () => void; onPending: (p: Pending) => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<{ assets: QuoteAssetRow[]; periods: PeriodRow[] } | null>(null);
  const [note, setNote] = useState('');
  const [startsOn, setStartsOn] = useState(new Date().toISOString().slice(0, 10));
  const [createContract, setCreateContract] = useState(true);
  const [busy, setBusy] = useState(false);

  const loadDetail = useCallback(async () => {
    try {
      setDetail(await fetchQuoteDetail(quote.id));
    } catch {
      toast('Could not load guarantee details', 'error');
    }
  }, [quote.id, toast]);

  useEffect(() => {
    if (open) void loadDetail();
  }, [open, loadDetail]);

  const act = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok, 'success');
      onChanged();
      if (open) await loadDetail();
    } catch (e) {
      toast(errMsg(e, 'Action failed'), 'error');
    }
    setBusy(false);
  };

  const needsNote = quote.decision === 'needs_review';

  return (
    <div className={cardClass}>
      <button type="button" onClick={() => setOpen((v) => !v)} className="focus-ring flex w-full items-start justify-between gap-3 text-left">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-text-primary">{quote.name}</p>
          <p className="mt-0.5 text-xs text-text-secondary">
            {quote.customers?.name ?? 'Customer'} · {quote.target_uptime_pct}% uptime · {quote.term_months} mo · {money(quote.monthly_fee_cents)}/mo
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-[10px] ${DECISION_COLORS[quote.decision]}`}>{DECISION_LABELS[quote.decision]}</span>
          <span className={`rounded-full px-2 py-0.5 text-[10px] ${QUOTE_STATUS_COLORS[quote.status]}`}>{QUOTE_STATUS_LABELS[quote.status]}</span>
          <ChevronDown size={14} className={`text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`} />
        </div>
      </button>

      {open && (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          {quote.review_note && <p className="text-xs text-text-secondary">Review note: {quote.review_note}</p>}
          {quote.starts_on && <p className="text-xs text-text-secondary">Term: {quote.starts_on} → {quote.ends_on}</p>}

          {quote.status === 'draft' && (
            <div className="space-y-2">
              {needsNote && (
                <Field label="Review note — why is this acceptable? (required)">
                  <textarea className={inputClass} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
                </Field>
              )}
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={busy || (needsNote && !note.trim())} onClick={() => void act(() => finalizeQuote(quote.id, needsNote ? note : null), 'Quote finalized')} className={btnPrimary}>
                  Finalize quote
                </button>
                <button type="button" disabled={busy} onClick={() => onPending({ kind: 'decline', quote })} className={btnGhost}>Decline</button>
                <button type="button" disabled={busy} onClick={() => onPending({ kind: 'delete', quote })} className={btnGhost}>Delete draft</button>
              </div>
            </div>
          )}

          {quote.status === 'quoted' && (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Contract start">
                <input className={inputClass} type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
              </Field>
              <label className="flex items-center gap-1.5 pb-2 text-xs text-text-secondary">
                <input type="checkbox" checked={createContract} onChange={(e) => setCreateContract(e.target.checked)} /> Create the commercial contract
              </label>
              <button type="button" disabled={busy || !startsOn} onClick={() => void act(() => activateQuote(quote.id, startsOn, createContract), 'Guarantee is now active')} className={btnPrimary}>
                Activate guarantee
              </button>
              <button type="button" disabled={busy} onClick={() => onPending({ kind: 'decline', quote })} className={btnGhost}>Customer declined</button>
            </div>
          )}

          {detail && (quote.status === 'active' || quote.status === 'completed' || quote.status === 'cancelled') && (
            <DeliveryPanel quote={quote} assets={detail.assets} periods={detail.periods} onChanged={() => { onChanged(); void loadDetail(); }} />
          )}

          {detail && quote.status !== 'active' && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-left text-xs">
                <thead className="text-text-secondary">
                  <tr><th className="py-1.5 pr-2 font-medium">Asset</th><th className="py-1.5 pr-2 font-medium">PM/yr</th><th className="py-1.5 pr-2 font-medium">Exp. uptime</th><th className="py-1.5 font-medium">Annual</th></tr>
                </thead>
                <tbody>
                  {detail.assets.map((a) => (
                    <tr key={a.id} className="border-t border-border">
                      <td className="py-1.5 pr-2 text-text-primary">{a.label}</td>
                      <td className="py-1.5 pr-2">{a.pm_visits_per_year}</td>
                      <td className="py-1.5 pr-2">{a.expected_uptime_pct ?? '—'}%</td>
                      <td className="py-1.5">{money(a.annual_price_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {quote.status === 'active' && (
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={busy} onClick={() => onPending({ kind: 'complete', quote })} className={btnGhost}>Mark completed</button>
              <button type="button" disabled={busy} onClick={() => onPending({ kind: 'cancel', quote })} className={btnGhost}>Cancel guarantee</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function GuaranteesTab({ refreshKey }: { refreshKey: number }) {
  const { toast } = useToast();
  const [quotes, setQuotes] = useState<QuoteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Pending>(null);

  const load = useCallback(async () => {
    try {
      setQuotes(await fetchQuotes());
    } catch {
      toast('Could not load guarantees', 'error');
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const confirmPending = async () => {
    if (!pending) return;
    try {
      if (pending.kind === 'delete') await deleteDraftQuote(pending.quote.id);
      else await closeQuote(pending.quote.id, pending.kind === 'decline' ? 'declined' : pending.kind === 'cancel' ? 'cancelled' : 'completed', null);
      toast('Done', 'success');
      await load();
    } catch (e) {
      toast(errMsg(e, 'Action failed'), 'error');
    }
    setPending(null);
  };

  const copy: Record<NonNullable<Pending>['kind'], { title: string; description: string; label: string }> = {
    delete: { title: 'Delete this draft?', description: 'The draft quote and its asset lines will be removed permanently.', label: 'Yes, delete' },
    decline: { title: 'Mark as declined?', description: 'This closes the quote. You can price a new one at any time.', label: 'Yes, decline' },
    cancel: { title: 'Cancel this guarantee?', description: 'Delivery tracking stops. Recorded periods and credits stay on file. The linked commercial contract is not changed automatically.', label: 'Yes, cancel' },
    complete: { title: 'Mark as completed?', description: 'Use this when the term has ended. No more periods can be recorded afterwards.', label: 'Yes, complete' },
  };

  if (loading) return <div className="space-y-2">{[0, 1].map((i) => <div key={i} className="h-16 animate-pulse rounded-2xl bg-bg-tertiary" />)}</div>;
  if (quotes.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border py-10 text-center">
        <Gauge className="mx-auto mb-2 h-6 w-6 text-text-secondary/50" />
        <p className="mx-auto max-w-sm text-sm text-text-secondary">No outcome guarantees yet. Price one in the first tab and save it as a draft.</p>
      </div>
    );
  }
  return (
    <>
      <div className="space-y-3">
        {quotes.map((q) => <QuoteCard key={q.id} quote={q} onChanged={() => void load()} onPending={setPending} />)}
      </div>
      <ConfirmDialog
        open={pending !== null}
        title={pending ? copy[pending.kind].title : ''}
        description={pending ? copy[pending.kind].description : ''}
        confirmLabel={pending ? copy[pending.kind].label : undefined}
        onConfirm={confirmPending}
        onCancel={() => setPending(null)}
      />
    </>
  );
}

// ============================================================
// SETTINGS
// ============================================================

const ASSUMPTION_FIELDS: Array<{ key: keyof PricingAssumptions; label: string; step: number; min: number; max: number; pct?: boolean }> = [
  { key: 'laborCostPerHour', label: 'Loaded labor cost $/h', step: 1, min: 1, max: 500 },
  { key: 'truckRollCost', label: 'Truck roll cost $', step: 1, min: 0, max: 1000 },
  { key: 'consumablesPerVisit', label: 'Consumables per PM visit $', step: 1, min: 0, max: 500 },
  { key: 'overheadPct', label: 'Overhead % of price', step: 1, min: 0, max: 50, pct: true },
  { key: 'targetMarginPct', label: 'Target margin % of price', step: 1, min: 0, max: 60, pct: true },
  { key: 'riskAversionZ', label: 'Risk premium (std-devs)', step: 0.1, min: 0, max: 3 },
  { key: 'partsOnTruckRate', label: 'Parts on truck (first-visit fix) %', step: 1, min: 0, max: 100, pct: true },
  { key: 'partsLeadHours', label: 'Delay when part is missing (h)', step: 1, min: 0, max: 500 },
  { key: 'responseHours', label: 'Response time to arrive (h)', step: 0.5, min: 0.25, max: 72 },
  { key: 'billRatePerHour', label: 'T&M bill rate $/h (comparison)', step: 1, min: 1, max: 1000 },
  { key: 'tripCharge', label: 'T&M trip charge $ (comparison)', step: 1, min: 0, max: 1000 },
  { key: 'partsMarkupPct', label: 'T&M parts markup %', step: 1, min: 0, max: 300, pct: true },
  { key: 'durationCv', label: 'Repair-time variability (CV)', step: 0.05, min: 0.1, max: 2 },
  { key: 'minPMeetProbability', label: 'Required confidence to promise %', step: 1, min: 50, max: 99, pct: true },
  { key: 'minDataConfidence', label: 'Min data confidence for auto-offer %', step: 1, min: 0, max: 100, pct: true },
  { key: 'minExpectedMarginPct', label: 'Min expected margin % (else review)', step: 1, min: 0, max: 60, pct: true },
];

function SettingsTab({ settings, onSaved }: { settings: PricingSettings; onSaved: (s: PricingSettings) => void }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<PricingSettings>(settings);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(settings), [settings]);

  const setAssumption = (key: keyof PricingAssumptions, display: number, pct?: boolean) =>
    setDraft((d) => ({ ...d, assumptions: { ...d.assumptions, [key]: pct ? display / 100 : display } }));
  const setTier = (i: number, patch: Partial<CreditTier>) =>
    setDraft((d) => ({ ...d, creditSchedule: d.creditSchedule.map((t, idx) => (idx === i ? { ...t, ...patch } : t)) }));

  const validate = (): string | null => {
    let prev = 0;
    for (const t of draft.creditSchedule) {
      if (!(t.upToPts > prev)) return 'Credit tiers must have ascending shortfall limits.';
      if (t.creditPct < 0 || t.creditPct > 100) return 'Tier credits must be between 0 and 100%.';
      prev = t.upToPts;
    }
    if (draft.annualCreditCapPct < 0 || draft.annualCreditCapPct > 100) return 'Annual credit cap must be between 0 and 100%.';
    if (draft.assumptions.overheadPct + draft.assumptions.targetMarginPct >= 0.8) return 'Overhead + margin must stay below 80% of price.';
    return null;
  };

  const save = async () => {
    const problem = validate();
    if (problem) return toast(problem, 'error');
    setSaving(true);
    try {
      await savePricingSettings(draft);
      onSaved(draft);
      toast('Pricing assumptions saved', 'success');
    } catch (e) {
      toast(errMsg(e, 'Could not save assumptions'), 'error');
    }
    setSaving(false);
  };

  return (
    <div className="space-y-4">
      <div className={`${cardClass} space-y-3`}>
        <p className="text-xs font-medium text-text-primary">Cost and margin assumptions</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {ASSUMPTION_FIELDS.map((f) => (
            <Field key={f.key} label={f.label}>
              <input
                className={inputClass}
                type="number"
                min={f.min}
                max={f.max}
                step={f.step}
                value={f.pct ? Math.round(draft.assumptions[f.key] * 10000) / 100 : draft.assumptions[f.key]}
                onChange={(e) => setAssumption(f.key, Math.min(f.max, Math.max(f.min, Number(e.target.value) || 0)), f.pct)}
              />
            </Field>
          ))}
        </div>
      </div>

      <div className={`${cardClass} space-y-3`}>
        <p className="text-xs font-medium text-text-primary">SLA credit schedule (monthly)</p>
        <p className="text-xs text-text-secondary">When a month's uptime falls short of the target, the customer gets this % of that month's fee. Tiers are by shortfall in percentage points.</p>
        {draft.creditSchedule.map((t, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <Field label="Shortfall up to (pts)">
              <input className={`${inputClass} !w-32`} type="number" min="0.1" step="0.1" value={t.upToPts} onChange={(e) => setTier(i, { upToPts: Number(e.target.value) || 0 })} />
            </Field>
            <Field label="Credit % of monthly fee">
              <input className={`${inputClass} !w-32`} type="number" min="0" max="100" step="1" value={t.creditPct} onChange={(e) => setTier(i, { creditPct: Number(e.target.value) || 0 })} />
            </Field>
            {draft.creditSchedule.length > 1 && (
              <button type="button" onClick={() => setDraft((d) => ({ ...d, creditSchedule: d.creditSchedule.filter((_, idx) => idx !== i) }))} className={btnGhost}>Remove</button>
            )}
          </div>
        ))}
        <div className="flex flex-wrap items-end gap-3">
          <button
            type="button"
            onClick={() =>
              setDraft((d) => {
                const last = d.creditSchedule[d.creditSchedule.length - 1];
                return { ...d, creditSchedule: [...d.creditSchedule, { upToPts: (last?.upToPts ?? 0) + 1, creditPct: Math.min(100, (last?.creditPct ?? 0) + 10) }] };
              })
            }
            className={btnGhost}
          >
            Add tier
          </button>
          <Field label="Annual credit cap % of fee">
            <input className={`${inputClass} !w-32`} type="number" min="0" max="100" value={draft.annualCreditCapPct} onChange={(e) => setDraft((d) => ({ ...d, annualCreditCapPct: Math.min(100, Math.max(0, Number(e.target.value) || 0)) }))} />
          </Field>
          <button type="button" onClick={() => setDraft({ assumptions: DEFAULT_ASSUMPTIONS, creditSchedule: DEFAULT_CREDIT_SCHEDULE, annualCreditCapPct: 25 })} className={btnGhost}>Reset to defaults</button>
        </div>
      </div>

      <button type="button" disabled={saving} onClick={() => void save()} className={btnPrimary}>
        {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save assumptions
      </button>
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

const TABS = [
  { id: 'price', label: 'Price a guarantee' },
  { id: 'guarantees', label: 'Guarantees' },
  { id: 'settings', label: 'Assumptions' },
] as const;
type TabId = (typeof TABS)[number]['id'];

export function OutcomePricingPage() {
  const { toast } = useToast();
  const [tab, setTab] = useState<TabId>('price');
  const [settings, setSettings] = useState<PricingSettings | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    fetchPricingSettings()
      .then(setSettings)
      .catch(() => {
        toast('Could not load saved assumptions — using defaults', 'error');
        setSettings({ assumptions: DEFAULT_ASSUMPTIONS, creditSchedule: DEFAULT_CREDIT_SCHEDULE, annualCreditCapPct: 25 });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <DashboardLayout activeLabel="Outcome Pricing">
      <div className="mx-auto max-w-4xl px-4 py-6">
        <div className="mb-5">
          <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
            <Gauge size={18} /> Outcome Pricing
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            Sell uptime instead of hours. Vireek models expected failures, the maintenance plan, repair cost and SLA-credit risk, then prices the guarantee — and refuses to promise what it cannot deliver.
          </p>
        </div>

        <div className="mb-4 flex flex-wrap gap-1.5">
          {TABS.map((t) => (
            <button key={t.id} type="button" onClick={() => setTab(t.id)} className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium ${tab === t.id ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}>
              {t.label}
            </button>
          ))}
        </div>

        {!settings ? (
          <div className="h-24 animate-pulse rounded-2xl bg-bg-tertiary" />
        ) : (
          <>
            <div className={tab === 'price' ? '' : 'hidden'}>
              <PricingWorkspace settings={settings} onSaved={() => { setRefreshKey((k) => k + 1); setTab('guarantees'); }} />
            </div>
            {tab === 'guarantees' && <GuaranteesTab refreshKey={refreshKey} />}
            {tab === 'settings' && <SettingsTab settings={settings} onSaved={setSettings} />}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
