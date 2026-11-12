import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { PRICING_PLANS } from '@/lib/pricing';
import { formatPct, formatUsd } from '@/lib/staffUsage';
import { reconcile } from '@/lib/marginModel';
import { RATE_COMPONENTS, RATE_UNITS, validateInvoiceInput, validateLimitInput, validateRateInput } from '@/lib/unitEconomicsInputs';
import { deleteLimit, endRate, fetchUnitEconomics, insertRate, listAudit, listLimits, listRates, upsertInvoice, upsertLimit, type AuditRow, type LimitRow, type RateRow } from '@/lib/unitEconomicsApi';
import { ErrorList, Field, INPUT, Section, TableWrap, TD, TDR, TH, THR } from './shared';
import { RateStatusBadge } from './RateStatusBadge';

const today = () => new Date().toISOString().slice(0, 10);
const prevMonth = () => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };
const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Unknown error');

export function InputsPanel({ onChanged }: { onChanged: () => void }) {
  const { toast } = useToast();
  const [rates, setRates] = useState<RateRow[]>([]);
  const [limits, setLimits] = useState<LimitRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const reload = useCallback(async () => {
    try {
      const [r, l, a] = await Promise.all([listRates(), listLimits(), listAudit()]);
      setRates(r); setLimits(l); setAudit(a); setLoadError('');
    } catch (e) { setLoadError(errMsg(e)); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  // --- rate form
  const [rf, setRf] = useState({ component: 'asr', provider: '', unit: 'per_minute', rateUsd: '', source: '', sourceUrl: '', effectiveFrom: today(), effectiveTo: '' });
  const [rateErrors, setRateErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const submitRate = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = validateRateInput(rf);
    if (!v.ok) { setRateErrors(v.errors); return; }
    setRateErrors([]); setSaving(true);
    try { await insertRate(v.value); toast('Rate saved.', 'success'); setRf({ ...rf, rateUsd: '', source: '', sourceUrl: '' }); await reload(); onChanged(); }
    catch (err) { setRateErrors([errMsg(err)]); } finally { setSaving(false); }
  };
  const stopRate = async (id: string) => {
    try { await endRate(id, today()); toast('Rate ended today.', 'success'); await reload(); onChanged(); } catch (err) { toast(errMsg(err), 'error'); }
  };

  // --- limit form
  const [lf, setLf] = useState({ plan: PRICING_PLANS[0]?.id ?? '', softCostUsd: '', hardCostUsd: '', maxCallSeconds: '' });
  const [limitErrors, setLimitErrors] = useState<string[]>([]);
  const submitLimit = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = validateLimitInput(lf);
    if (!v.ok) { setLimitErrors(v.errors); return; }
    setLimitErrors([]); setSaving(true);
    try { await upsertLimit(v.value); toast('Limits saved.', 'success'); await reload(); } catch (err) { setLimitErrors([errMsg(err)]); } finally { setSaving(false); }
  };
  const removeLimit = async (plan: string) => { try { await deleteLimit(plan); await reload(); } catch (err) { toast(errMsg(err), 'error'); } };

  // --- invoice + reconciliation
  const [inv, setInv] = useState({ provider: 'vapi', month: prevMonth(), invoicedUsd: '', invoiceRef: '' });
  const [invErrors, setInvErrors] = useState<string[]>([]);
  const [recon, setRecon] = useState<{ reported: number; invoiced: number | null; status: string; driftPct: number | null } | null>(null);
  const submitInvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = validateInvoiceInput(inv);
    if (!v.ok) { setInvErrors(v.errors); return; }
    setInvErrors([]); setSaving(true);
    try {
      await upsertInvoice(v.value);
      const [y, m] = inv.month.split('-').map(Number);
      const ue = await fetchUnitEconomics(new Date(Date.UTC(y, m - 1, 1)), new Date(Date.UTC(y, m, 1)));
      const r = reconcile(ue.reported_voice_total_usd, v.value.invoicedUsd, 5);
      setRecon({ reported: ue.reported_voice_total_usd, invoiced: v.value.invoicedUsd, status: r.status, driftPct: r.driftPct });
      toast('Invoice saved.', 'success'); await reload();
    } catch (err) { setInvErrors([errMsg(err)]); } finally { setSaving(false); }
  };

  if (loading) return <Skeleton className="h-64 rounded-2xl" />;
  if (loadError) return <p role="alert" className="rounded-xl border border-danger bg-danger/10 p-4 text-sm text-text-primary">Could not load inputs: {loadError}</p>;

  return (
    <div className="space-y-6">
      <Section title="Provider rates (seeded and staff-entered; check each badge)">
        <TableWrap caption="Provider cost rates">
          <thead><tr><th scope="col" className={TH}>Component</th><th scope="col" className={TH}>Provider</th><th scope="col" className={TH}>Unit</th><th scope="col" className={THR}>Rate (USD)</th><th scope="col" className={TH}>Source</th><th scope="col" className={TH}>Effective</th><th scope="col" className={TH}><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{rates.length === 0 ? <tr><td colSpan={7} className={`${TD} text-text-secondary`}>No rates yet. Estimates that need a rate stay “unpriced”.</td></tr> : rates.map((r) => (
            <tr key={r.id} className="border-t border-border"><td className={TD}>{r.component}</td><td className={TD}>{r.provider}</td><td className={TD}>{r.unit}</td><td className={TDR}>{r.rateUsd}</td>
              <td className={TD}>{r.sourceUrl ? <a href={r.sourceUrl} target="_blank" rel="noopener noreferrer" className="focus-ring text-accent underline">{r.source}</a> : r.source}<RateStatusBadge status={r.status} /></td>
              <td className={TD}>{r.effectiveFrom} → {r.effectiveTo ?? 'open'}</td>
              <td className={TD}>{r.effectiveTo === null && <Button variant="ghost" size="xs" onClick={() => void stopRate(r.id)}>End today</Button>}</td></tr>))}</tbody>
        </TableWrap>
        <form onSubmit={(e) => void submitRate(e)} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" noValidate>
          <Field label="Component"><select className={INPUT} value={rf.component} onChange={(e) => setRf({ ...rf, component: e.target.value })}>{RATE_COMPONENTS.map((c) => <option key={c}>{c}</option>)}</select></Field>
          <Field label="Provider"><input className={INPUT} value={rf.provider} onChange={(e) => setRf({ ...rf, provider: e.target.value })} /></Field>
          <Field label="Unit"><select className={INPUT} value={rf.unit} onChange={(e) => setRf({ ...rf, unit: e.target.value })}>{RATE_UNITS.map((c) => <option key={c}>{c}</option>)}</select></Field>
          <Field label="Rate (USD per unit)"><input className={INPUT} inputMode="decimal" value={rf.rateUsd} onChange={(e) => setRf({ ...rf, rateUsd: e.target.value })} /></Field>
          <Field label="Source (required)" hint="Where this price comes from, e.g. “Oct 2026 invoice”."><input className={INPUT} value={rf.source} onChange={(e) => setRf({ ...rf, source: e.target.value })} /></Field>
          <Field label="Source URL (optional)"><input className={INPUT} value={rf.sourceUrl} onChange={(e) => setRf({ ...rf, sourceUrl: e.target.value })} /></Field>
          <Field label="Effective from"><input className={INPUT} type="date" value={rf.effectiveFrom} onChange={(e) => setRf({ ...rf, effectiveFrom: e.target.value })} /></Field>
          <Field label="Effective to (optional)"><input className={INPUT} type="date" value={rf.effectiveTo} onChange={(e) => setRf({ ...rf, effectiveTo: e.target.value })} /></Field>
          <div className="sm:col-span-2 lg:col-span-4 space-y-2"><ErrorList errors={rateErrors} /><Button type="submit" size="sm" loading={saving}>Add rate</Button></div>
        </form>
      </Section>

      <Section title="Plan cost limits (empty = no limit)">
        <TableWrap caption="Plan cost limits">
          <thead><tr><th scope="col" className={TH}>Plan</th><th scope="col" className={THR}>Soft cost / month</th><th scope="col" className={THR}>Hard cost / month</th><th scope="col" className={THR}>Max call seconds</th><th scope="col" className={TH}><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{limits.length === 0 ? <tr><td colSpan={5} className={`${TD} text-text-secondary`}>No limits set.</td></tr> : limits.map((l) => (
            <tr key={l.plan} className="border-t border-border"><td className={TD}>{l.plan}</td><td className={TDR}>{formatUsd(l.softCostUsd)}</td><td className={TDR}>{formatUsd(l.hardCostUsd)}</td><td className={TDR}>{l.maxCallSeconds ?? '—'}</td><td className={TD}><Button variant="ghost" size="xs" onClick={() => void removeLimit(l.plan)}>Remove</Button></td></tr>))}</tbody>
        </TableWrap>
        <p className="mt-2 text-xs text-text-secondary">Soft/hard limits raise staff flags in the hourly sweep. They never restrict emergency handling, and a hard limit is not enforced on live calls.</p>
        <form onSubmit={(e) => void submitLimit(e)} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" noValidate>
          <Field label="Plan"><select className={INPUT} value={lf.plan} onChange={(e) => setLf({ ...lf, plan: e.target.value })}>{PRICING_PLANS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          <Field label="Soft cost (USD)"><input className={INPUT} inputMode="decimal" value={lf.softCostUsd} onChange={(e) => setLf({ ...lf, softCostUsd: e.target.value })} /></Field>
          <Field label="Hard cost (USD)"><input className={INPUT} inputMode="decimal" value={lf.hardCostUsd} onChange={(e) => setLf({ ...lf, hardCostUsd: e.target.value })} /></Field>
          <Field label="Max call seconds"><input className={INPUT} inputMode="numeric" value={lf.maxCallSeconds} onChange={(e) => setLf({ ...lf, maxCallSeconds: e.target.value })} /></Field>
          <div className="sm:col-span-2 lg:col-span-4 space-y-2"><ErrorList errors={limitErrors} /><Button type="submit" size="sm" loading={saving}>Save limits</Button></div>
        </form>
      </Section>

      <Section title="Provider invoice and reconciliation">
        <form onSubmit={(e) => void submitInvoice(e)} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" noValidate>
          <Field label="Provider"><input className={INPUT} value={inv.provider} onChange={(e) => setInv({ ...inv, provider: e.target.value })} /></Field>
          <Field label="Month" hint="2026-10"><input className={INPUT} value={inv.month} onChange={(e) => setInv({ ...inv, month: e.target.value })} /></Field>
          <Field label="Invoiced total (USD)"><input className={INPUT} inputMode="decimal" value={inv.invoicedUsd} onChange={(e) => setInv({ ...inv, invoicedUsd: e.target.value })} /></Field>
          <Field label="Invoice reference"><input className={INPUT} value={inv.invoiceRef} onChange={(e) => setInv({ ...inv, invoiceRef: e.target.value })} /></Field>
          <div className="sm:col-span-2 lg:col-span-4 space-y-2"><ErrorList errors={invErrors} /><Button type="submit" size="sm" loading={saving}>Save invoice and reconcile</Button></div>
        </form>
        <div role="status" aria-live="polite" className="mt-4 text-sm text-text-primary">
          {recon && <p>Provider-reported {formatUsd(recon.reported)} vs invoiced {formatUsd(recon.invoiced)}: drift {formatPct(recon.driftPct)} — {recon.status === 'drift' ? <strong className="text-danger">over the 5% threshold, investigate.</strong> : 'within the 5% threshold.'} The reported total covers all components Vapi reports; compare with the matching invoice lines.</p>}
        </div>
      </Section>

      <Section title="Recent changes (audit trail)">
        {audit.length === 0 ? <p className="text-sm text-text-secondary">No changes recorded.</p> : (
          <TableWrap caption="Audit trail">
            <thead><tr><th scope="col" className={TH}>When (UTC)</th><th scope="col" className={TH}>Table</th><th scope="col" className={TH}>Action</th><th scope="col" className={TH}>Row</th><th scope="col" className={TH}>Actor</th></tr></thead>
            <tbody>{audit.map((a) => <tr key={a.id} className="border-t border-border"><td className={TD}>{a.changed_at.slice(0, 19).replace('T', ' ')}</td><td className={TD}>{a.table_name}</td><td className={TD}>{a.action}</td><td className={TD}>{a.row_key ?? '—'}</td><td className={TD}>{a.actor ? a.actor.slice(0, 8) : 'system'}</td></tr>)}</tbody>
          </TableWrap>)}
      </Section>
    </div>
  );
}
