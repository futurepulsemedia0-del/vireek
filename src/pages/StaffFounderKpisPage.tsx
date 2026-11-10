/**
 * Staff view — /staff/founder-kpis (wrapped in <StaffRoute>). Platform staff only: gross/net dollar retention, activation,
 * module attach, payment take rate, CAC payback (manual inputs) and cohort tables. Definitions: docs/ANALYTICS_METRICS.md.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { fetchFounder, saveFounderInput, type FounderOverview } from '@/lib/analyticsApi';
import { fmtPct, fmtUsd } from '@/lib/analyticsFormat';

const lastMonth = () => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };

export function StaffFounderKpisPage() {
  const { toast } = useToast();
  const [month, setMonth] = useState(lastMonth());
  const [days, setDays] = useState(14);
  const [data, setData] = useState<FounderOverview | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ spend: '', margin: '', fee: '', note: '' });

  const load = useCallback(async () => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return;
    setState('loading');
    try {
      const d = await fetchFounder(month, days);
      setData(d);
      setForm({ spend: d.input ? String(d.input.spend_cents / 100) : '', margin: d.input ? String(d.input.gross_margin_bp / 100) : '', fee: d.input ? String(d.input.platform_fee_cents / 100) : '', note: d.input?.note ?? '' });
      setState('ready');
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Could not load.'); setState('error'); }
  }, [month, days]);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    const spend = Math.round(Number(form.spend) * 100), fee = Math.round(Number(form.fee) * 100), margin = Math.round(Number(form.margin) * 100);
    if (![spend, fee, margin].every(Number.isFinite) || spend < 0 || fee < 0 || margin < 0 || margin > 10000) { toast('Enter valid amounts; margin must be 0–100%.', 'error'); return; }
    setSaving(true);
    try { await saveFounderInput({ month, spendCents: spend, grossMarginBp: margin, platformFeeCents: fee, note: form.note.trim() || null }); toast('Inputs saved.', 'success'); await load(); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not save.', 'error'); } finally { setSaving(false); }
  };

  const r = data?.retention;
  const h = data?.dataHealth;
  return (
    <main className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6" aria-busy={state === 'loading'}>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl font-semibold">Founder KPIs</h1><p className="text-sm text-gray-600">Platform staff only. Computed from the Stripe subscription ledger; see docs/ANALYTICS_METRICS.md.</p></div>
        <div className="flex gap-3">
          <label className="text-sm">Month <input type="month" value={month} max={new Date().toISOString().slice(0, 7)} onChange={(e) => setMonth(e.target.value)} className="ml-2 rounded border px-2 py-1" /></label>
          <label className="text-sm">Activation window (days) <input type="number" min={1} max={90} value={days} onChange={(e) => setDays(Math.min(90, Math.max(1, Number(e.target.value) || 14)))} className="ml-2 w-16 rounded border px-2 py-1" /></label>
        </div>
      </header>

      {state === 'loading' && !data && <div role="status" className="flex items-center gap-2 text-gray-600"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…</div>}
      {state === 'error' && <Card padding="md" interactive={false} error role="alert"><p className="mb-3 text-sm">{msg}</p><Button variant="secondary" onClick={() => void load()}>Try again</Button></Card>}

      {state === 'ready' && data && r && h && (
        <>
          {h.ledger_rows === 0 && <p role="alert" className="rounded bg-amber-50 p-3 text-sm">The MRR ledger is empty: no subscription events were found in billing_events, so retention cannot be computed yet.</p>}
          {h.ledger_rows > 0 && h.created_events === 0 && <p role="status" className="rounded bg-amber-50 p-3 text-sm">No <code>customer.subscription.created</code> events were received (the Stripe webhook may not be subscribed to it). New-logo timing uses the first update event and may lag.</p>}
          {data.ledgerStats.rejected > 0 && <p role="status" className="rounded bg-amber-50 p-3 text-sm">{data.ledgerStats.rejected} ledger rows were rejected as invalid.</p>}

          <section aria-label="Headline" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['Gross dollar retention', fmtPct(r.grrBp)], ['Net revenue retention', fmtPct(r.nrrBp)], ['Closing MRR', fmtUsd(r.closingMrrCents)],
              ['New MRR', fmtUsd(r.newMrrCents)], ['Churned MRR', fmtUsd(r.churnedCents)], ['Contraction / expansion', `${fmtUsd(r.contractionCents)} / ${fmtUsd(r.expansionCents)}`],
              [`Activation (${data.activation.windowDays}d)`, `${fmtPct(data.activation.rateBp)} · ${data.activation.activated}/${data.activation.matured}`],
              ['Payment take rate', fmtPct(data.takeRate.takeRateBp)],
            ].map(([label, value]) => <Card key={label} padding="md" interactive={false}><h2 className="text-sm text-gray-600">{label}</h2><p className="mt-1 text-2xl font-semibold">{value}</p></Card>)}
          </section>
          <p className="text-xs text-gray-500">Starting cohort: {r.cohortAccounts} accounts, {fmtUsd(r.startMrrCents)} MRR · {r.newAccounts} new ({r.reactivationAccounts} reactivated) · {r.intraPeriodChurnAccounts} started and churned inside the month (excluded) · {data.activation.immature} signups too recent to judge.</p>

          <Card padding="md" interactive={false}>
            <h2 className="mb-3 text-lg font-medium">Cohorts (net MRR retention by months since start)</h2>
            <div className="overflow-x-auto"><table className="text-left text-xs"><caption className="sr-only">Cohort table</caption>
              <thead><tr><th scope="col" className="pr-3">Cohort</th><th scope="col" className="pr-3">Accts</th><th scope="col" className="pr-3">Start MRR</th>{data.cohorts[0]?.cells.map((c) => <th key={c.offset} scope="col" className="px-2">M{c.offset}</th>)}</tr></thead>
              <tbody>{data.cohorts.map((row) => (
                <tr key={row.cohort}><th scope="row" className="pr-3 font-normal">{row.cohort}</th><td className="pr-3">{row.accounts}</td><td className="pr-3">{fmtUsd(row.initialMrrCents)}</td>
                  {row.cells.map((c) => <td key={c.offset} className="px-2 py-1 text-center" style={{ background: c.nrrBp === null ? undefined : `rgba(34,197,94,${Math.min(0.6, (c.nrrBp / 10000) * 0.5)})` }} title={c.logoRetentionBp === null ? '' : `Logo retention ${fmtPct(c.logoRetentionBp)}`}>{fmtPct(c.nrrBp)}</td>)}</tr>
              ))}</tbody></table></div>
          </Card>

          <Card padding="md" interactive={false}>
            <h2 className="mb-3 text-lg font-medium">12-month trend</h2>
            <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Retention by month</caption>
              <thead><tr className="border-b"><th scope="col">Month</th><th scope="col">GRR</th><th scope="col">NRR</th><th scope="col">Closing MRR</th><th scope="col">New</th><th scope="col">Churned</th></tr></thead>
              <tbody>{data.trend.map((t) => <tr key={t.month} className="border-b last:border-0"><th scope="row" className="font-normal">{t.month}</th><td>{fmtPct(t.grrBp)}</td><td>{fmtPct(t.nrrBp)}</td><td>{fmtUsd(t.closingMrrCents)}</td><td>{fmtUsd(t.newMrrCents)}</td><td>{fmtUsd(t.churnedCents)}</td></tr>)}</tbody></table></div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card padding="md" interactive={false}>
              <h2 className="mb-3 text-lg font-medium">Module attach ({data.payingAccounts} paying accounts)</h2>
              <ul className="space-y-1 text-sm">{data.attach.map((a) => <li key={a.moduleKey} className="flex justify-between"><span>{a.moduleKey}</span><span>{fmtPct(a.rateBp)} ({a.attachedAccounts})</span></li>)}</ul>
            </Card>
            <Card padding="md" interactive={false}>
              <h2 className="mb-3 text-lg font-medium">Manual inputs for {month}</h2>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <label>Sales &amp; marketing spend ($)<input inputMode="decimal" value={form.spend} onChange={(e) => setForm({ ...form, spend: e.target.value })} className="mt-1 w-full rounded border px-2 py-1" /></label>
                <label>Gross margin (%)<input inputMode="decimal" value={form.margin} onChange={(e) => setForm({ ...form, margin: e.target.value })} className="mt-1 w-full rounded border px-2 py-1" /></label>
                <label>Platform fee revenue ($)<input inputMode="decimal" value={form.fee} onChange={(e) => setForm({ ...form, fee: e.target.value })} className="mt-1 w-full rounded border px-2 py-1" /></label>
                <label>Note<input maxLength={500} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} className="mt-1 w-full rounded border px-2 py-1" /></label>
              </div>
              <Button className="mt-3" onClick={save} loading={saving} loadingLabel="Saving…">Save inputs</Button>
              <p className="mt-3 text-sm">{data.cac ? <>CAC {fmtUsd(data.cac.cacCents)} · payback {data.cac.paybackMonths === null ? '—' : `${data.cac.paybackMonths} months`}</> : 'Enter this month’s inputs to see CAC and payback.'} Card volume {fmtUsd(data.takeRate.grossPaymentVolumeCents)}.</p>
            </Card>
          </div>
        </>
      )}
    </main>
  );
}
