// Staff-only "Ledger" tab of /staff/margins: measured unit costs from the append-only cost ledger, correlation coverage,
// provider reconciliation (with CSV invoice import and offsetting corrections), marketplace economics, open alerts and the
// outcome-fee WHAT-IF. Everything here is read-only analysis except (a) importing invoices and (b) posting offsetting events.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { Kpi, Section, TableWrap, TH, THR, TD, TDR, INPUT, Field, ErrorList } from '@/components/staff/margins/shared';
import {
  fetchCoverage, fetchMarketplaceEconomics, fetchOpenAlerts, fetchOutcomeFeeInputs, fetchReconciliation, fetchUnitCosts, fmtMicroUsd, fmtPct,
  postCostCorrection, resolveAlert, type CoverageRow, type EconomicsAlert, type MarketplaceRow, type OutcomeFeeInput, type ReconRow, type UnitCosts,
} from '@/lib/economicsApi';
import { upsertInvoice } from '@/lib/unitEconomicsApi';
import { PRICING_PLANS } from '@/lib/pricing';
import { parseStatementCsv } from '../../../../supabase/functions/_shared/economics/reconcile';
import { simulateOutcomeFee } from '../../../../supabase/functions/_shared/economics/outcomeFeeSim';

const prevMonthFirstDay = (): string => {
  const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
};
const errText = (e: unknown) => (e instanceof Error ? e.message : 'Unknown error');

export function LedgerPanel({ start, end }: { start: Date; end: Date }) {
  const { toast } = useToast();
  const [unit, setUnit] = useState<UnitCosts | null>(null);
  const [coverage, setCoverage] = useState<CoverageRow[]>([]);
  const [market, setMarket] = useState<MarketplaceRow[]>([]);
  const [alerts, setAlerts] = useState<EconomicsAlert[]>([]);
  const [feeInputs, setFeeInputs] = useState<OutcomeFeeInput[]>([]);
  const [month, setMonth] = useState(prevMonthFirstDay());
  const [recon, setRecon] = useState<ReconRow[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [csv, setCsv] = useState('');
  const [csvPreview, setCsvPreview] = useState<{ provider: string; month: string; usd: number }[] | null>(null);
  const [csvErrors, setCsvErrors] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [perJob, setPerJob] = useState('5');
  const [sharePct, setSharePct] = useState('1');

  const load = useCallback(async () => {
    const results = await Promise.allSettled([
      fetchUnitCosts(start, end), fetchCoverage(start, end), fetchMarketplaceEconomics(start, end), fetchOpenAlerts(), fetchOutcomeFeeInputs(start, end),
    ]);
    const errs: string[] = [];
    const [u, c, m, a, f] = results;
    if (u.status === 'fulfilled') setUnit(u.value); else errs.push(`Unit costs: ${errText(u.reason)}`);
    if (c.status === 'fulfilled') setCoverage(c.value); else errs.push(`Coverage: ${errText(c.reason)}`);
    if (m.status === 'fulfilled') setMarket(m.value); else errs.push(`Marketplace: ${errText(m.reason)}`);
    if (a.status === 'fulfilled') setAlerts(a.value); else errs.push(`Alerts: ${errText(a.reason)}`);
    if (f.status === 'fulfilled') setFeeInputs(f.value); else errs.push(`Outcome-fee inputs: ${errText(f.reason)}`);
    setErrors(errs);
  }, [start, end]);
  const loadRecon = useCallback(async () => {
    try { setRecon(await fetchReconciliation(month)); } catch (e) { setErrors((x) => [...x, `Reconciliation: ${errText(e)}`]); }
  }, [month]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadRecon(); }, [loadRecon]);

  const totalEvents = coverage.reduce((s, r) => s + r.events, 0);
  const totalCorr = coverage.reduce((s, r) => s + r.withCorrelation, 0);
  const corrPct = totalEvents > 0 ? (totalCorr / totalEvents) * 100 : null;

  const previewCsv = () => {
    const { lines, errors: errs } = parseStatementCsv(csv);
    setCsvErrors(errs);
    const sums = new Map<string, { provider: string; month: string; micro: number }>();
    for (const l of lines) { const k = `${l.provider}|${l.month}`; const cur = sums.get(k) ?? { provider: l.provider, month: l.month, micro: 0 }; cur.micro += l.amountMicro; sums.set(k, cur); }
    setCsvPreview([...sums.values()].map((s) => ({ provider: s.provider, month: s.month, usd: Math.round(s.micro / 10_000) / 100 })));
  };
  const importCsv = async () => {
    if (!csvPreview?.length || csvErrors.length) return;
    setBusy(true);
    try {
      for (const r of csvPreview) await upsertInvoice({ provider: r.provider, periodMonth: r.month, invoicedUsd: r.usd, invoiceRef: 'csv-import' });
      toast(`Imported ${csvPreview.length} invoice total(s).`, 'success'); setCsv(''); setCsvPreview(null); await loadRecon();
    } catch (e) { toast(`Import failed: ${errText(e)}`, 'error'); } finally { setBusy(false); }
  };
  const correct = async (r: ReconRow) => {
    if (r.invoicedMicro === null || r.ledgerMicro === null) return;
    const delta = r.invoicedMicro - r.ledgerMicro;
    if (delta === 0 || reason.trim().length < 10) { toast('Enter a reason of at least 10 characters.', 'error'); return; }
    setBusy(true);
    try {
      await postCostCorrection({ provider: r.provider, monthFirstDay: month, deltaMicro: delta, reason: reason.trim(), ref: `recon:${month}:${r.provider}:${r.ledgerMicro}` });
      toast('Offsetting correction posted.', 'success'); await loadRecon();
    } catch (e) { toast(`Correction failed: ${errText(e)}`, 'error'); } finally { setBusy(false); }
  };

  const sim = useMemo(() => {
    const jobUsd = Number(perJob), share = Number(sharePct);
    if (!Number.isFinite(jobUsd) || jobUsd < 0 || !Number.isFinite(share) || share < 0 || share > 100 || feeInputs.length === 0) return null;
    const scale = Math.max(1, (end.getTime() - start.getTime()) / (30 * 86_400_000));
    const price = (plan: string) => Math.round(((PRICING_PLANS.find((p) => p.id === plan)?.monthly ?? 0) * 100) * scale);
    return simulateOutcomeFee(
      feeInputs.map((f) => ({ tenantId: f.accountId, plan: f.plan, planPriceCents: price(f.plan), costMicro: f.costMicro, bookedJobs: f.bookedJobs, recoveredCents: f.recoveredCents })),
      { perBookedJobCents: Math.round(jobUsd * 100), recoveredShareBps: Math.round(share * 100), label: 'what-if' },
    );
  }, [feeInputs, perJob, sharePct, start, end]);

  return (
    <div className="space-y-6">
      <ErrorList errors={errors} />
      {alerts.length > 0 && (
        <Section title={`Open alerts (${alerts.length})`}>
          <ul className="space-y-2">
            {alerts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3 text-sm">
                <span><strong className="text-text-primary">{a.kind.replace(/_/g, ' ')}</strong> <span className="text-text-secondary">({a.severity}, {a.createdAt.slice(0, 10)})</span></span>
                <Button variant="secondary" size="sm" onClick={() => void resolveAlert(a.id).then(load)} aria-label={`Resolve alert ${a.kind}`}>Resolve</Button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Measured unit costs (cost ledger)">
        {unit ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Kpi label="Cost per handled call" value={fmtMicroUsd(unit.microPerCall)} sub={`n = ${unit.callsWithCost} of ${unit.callsHandled} calls have ledger cost`} />
              <Kpi label="Cost per booking (direct)" value={fmtMicroUsd(unit.microPerBookingDirect)} sub={`n = ${unit.bookedCallsWithCost} booked calls with cost`} />
              <Kpi label="Cost per booking (all calls, loaded)" value={fmtMicroUsd(unit.microPerBookingLoaded)} sub={`${unit.bookedCalls} booked calls`} />
              <Kpi label="Cost per paid job (direct)" value={fmtMicroUsd(unit.microPerPaidJobDirect)} sub={`n = ${unit.paidCallsWithCost}; ${unit.paidJobs} paid jobs`} />
              <Kpi label="Cost per completed workflow" value={fmtMicroUsd(unit.microPerCompletedWorkflow)} sub={`n = ${unit.workflowRunsCompletedWithCost} (${unit.workflowRunsWithCost} runs with cost)`} />
              <Kpi label="Cost per workflow run" value={fmtMicroUsd(unit.microPerWorkflowRun)} sub={`n = ${unit.workflowRunsWithCost}`} />
            </div>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-text-secondary">{unit.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          </>
        ) : <p className="text-sm text-text-secondary">No data.</p>}
      </Section>

      <Section title="Correlation coverage" aside={<span className="text-sm text-text-secondary">{corrPct === null ? 'no events' : `${fmtPct(corrPct)} of ${totalEvents} events carry a correlation id`}</span>}>
        <TableWrap caption="Ledger events by resource type and correlation coverage">
          <thead><tr><th className={TH}>Resource</th><th className={THR}>Events</th><th className={THR}>With correlation</th><th className={THR}>With tenant</th><th className={THR}>Cost</th></tr></thead>
          <tbody>{coverage.map((r) => (
            <tr key={r.resourceType} className="border-t border-border"><td className={TD}>{r.resourceType}</td><td className={TDR}>{r.events}</td><td className={TDR}>{r.withCorrelation}</td><td className={TDR}>{r.withTenant}</td><td className={TDR}>{fmtMicroUsd(r.costMicro, 2)}</td></tr>
          ))}</tbody>
        </TableWrap>
      </Section>

      <Section title="Reconciliation: ledger vs provider invoices" aside={
        <label className="text-sm text-text-secondary">Month <input type="month" value={month.slice(0, 7)} onChange={(e) => e.target.value && setMonth(`${e.target.value}-01`)} className={`${INPUT} ml-2 w-40`} /></label>}>
        <TableWrap caption="Per-provider variance between ledger and invoice">
          <thead><tr><th className={TH}>Provider</th><th className={THR}>Ledger</th><th className={THR}>Invoice</th><th className={THR}>Variance</th><th className={TH}>Status</th><th className={TH}>Action</th></tr></thead>
          <tbody>{recon.map((r) => (
            <tr key={r.provider} className="border-t border-border">
              <td className={TD}>{r.provider}</td><td className={TDR}>{fmtMicroUsd(r.ledgerMicro, 2)}</td><td className={TDR}>{fmtMicroUsd(r.invoicedMicro, 2)}</td>
              <td className={TDR}>{fmtMicroUsd(r.varianceMicro, 2)} ({fmtPct(r.variancePct)})</td><td className={TD}>{r.status.replace(/_/g, ' ')}</td>
              <td className={TD}>{r.status === 'over_threshold' || r.status === 'within_tolerance' ? <Button variant="secondary" size="sm" disabled={busy} onClick={() => void correct(r)}>Post offsetting event</Button> : '—'}</td>
            </tr>
          ))}</tbody>
        </TableWrap>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Field label="Reason for correction (min 10 chars, stored on the ledger)"><input value={reason} onChange={(e) => setReason(e.target.value)} className={INPUT} maxLength={300} /></Field>
          <div>
            <Field label="Import invoices from CSV (provider,period_month,amount_usd,ref)" hint="period_month must be the first day of the month, e.g. 2026-10-01. Amounts are summed per provider and month.">
              <textarea value={csv} onChange={(e) => { setCsv(e.target.value); setCsvPreview(null); }} rows={4} className={INPUT} />
            </Field>
            <div className="mt-2 flex gap-2">
              <Button variant="secondary" size="sm" onClick={previewCsv} disabled={!csv.trim()}>Preview</Button>
              <Button size="sm" onClick={() => void importCsv()} disabled={busy || !csvPreview?.length || csvErrors.length > 0}>Import {csvPreview?.length ?? 0} total(s)</Button>
            </div>
            <ErrorList errors={csvErrors} />
            {csvPreview && <ul className="mt-2 text-xs text-text-secondary">{csvPreview.map((p) => <li key={`${p.provider}${p.month}`}>{p.provider} {p.month}: ${p.usd.toFixed(2)}</li>)}</ul>}
          </div>
        </div>
      </Section>

      <Section title="Marketplace economics (Vireek-borne cost vs platform fee)">
        <TableWrap caption="Per marketplace agent: runs, measured cost and Vireek margin">
          <thead><tr><th className={TH}>Agent</th><th className={THR}>Runs</th><th className={THR}>With cost</th><th className={THR}>Cost</th><th className={THR}>Platform fee</th><th className={THR}>Vireek margin</th></tr></thead>
          <tbody>{market.map((m) => (
            <tr key={m.agentId} className="border-t border-border"><td className={TD}>{m.agentId.slice(0, 8)}</td><td className={TDR}>{m.runs}</td><td className={TDR}>{m.runsWithCost}</td>
              <td className={TDR}>{fmtMicroUsd(m.costMicro, 2)}</td><td className={TDR}>{m.platformFeeCents === null ? 'n/a' : `$${(m.platformFeeCents / 100).toFixed(2)}`}</td>
              <td className={TDR}>{m.vireekMarginCents === null ? 'n/a' : `$${(m.vireekMarginCents / 100).toFixed(2)}`}</td></tr>
          ))}</tbody>
        </TableWrap>
      </Section>

      <Section title="Outcome-fee what-if (analysis only, changes no pricing)">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Fee per booked job (USD)"><input inputMode="decimal" value={perJob} onChange={(e) => setPerJob(e.target.value)} className={INPUT} /></Field>
          <Field label="Share of confidently recovered revenue (%)"><input inputMode="decimal" value={sharePct} onChange={(e) => setSharePct(e.target.value)} className={INPUT} /></Field>
        </div>
        {sim ? (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi label="Fee revenue (window)" value={`$${(sim.feeCents / 100).toFixed(2)}`} sub={`${sim.tenants} tenants; plan prices scaled to window`} />
            <Kpi label="Margin today" value={`$${(sim.marginBeforeCents / 100).toFixed(2)}`} sub="plan price − measured ledger cost" />
            <Kpi label="Margin with fee" value={`$${(sim.marginAfterCents / 100).toFixed(2)}`} />
            <Kpi label="Tenants where fee > plan price" value={String(sim.tenantsWhereFeeExceedsPlan)} tone={sim.tenantsWhereFeeExceedsPlan > 0 ? 'bad' : undefined} sub="customer-impact exposure" />
          </div>
        ) : <p className="mt-3 text-sm text-text-secondary">Enter valid values (share 0–100) and load data to simulate.</p>}
        <p className="mt-3 text-xs text-text-secondary">Historical simulation. Any real pricing experiment needs a feature flag and explicit human approval outside this tool.</p>
      </Section>
    </div>
  );
}
