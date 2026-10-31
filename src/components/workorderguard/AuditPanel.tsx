import { useMemo, useState } from 'react';
import { Download, FileSearch } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { FlagBadge, RULE_LABELS, Stat } from '@/components/workorderguard/shared';
import { auditToCsv, formatUsd, previousQuarter, runAudit, type PortalRules, type WorkOrder } from '@/lib/workOrderGuard';
import { parseWorkOrderCsv, type ImportResult } from '@/lib/workOrderGuardImport';

export function AuditPanel({ saved, rules, timezone }: { saved: WorkOrder[]; rules: PortalRules; timezone: string }) {
  const q = useMemo(() => previousQuarter(new Date(), timezone), [timezone]);
  const [from, setFrom] = useState(q.from);
  const [to, setTo] = useState(q.to);
  const [source, setSource] = useState<'saved' | 'file'>('saved');
  const [file, setFile] = useState<{ name: string; result: ImportResult } | null>(null);
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  const orders = source === 'file' ? file?.result.orders ?? [] : saved;
  const audit = useMemo(() => (from && to && from <= to ? runAudit(orders, { rules, timezone, asOf: new Date(), from, to }) : null), [orders, rules, timezone, from, to]);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true); setReadError(null);
    try {
      setFile({ name: f.name, result: parseWorkOrderCsv(await f.text(), { timezone }) });
      setSource('file');
    } catch {
      setReadError('Could not read that file.');
    } finally { setBusy(false); }
  };

  const download = () => {
    if (!audit) return;
    const url = URL.createObjectURL(new Blob([auditToCsv(audit)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = `quarter-audit-${from}-to-${to}.csv`; a.click();
    URL.revokeObjectURL(url);
  };
  const t = audit?.totals;

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-border bg-bg-secondary p-4">
        <p className="text-sm text-text-secondary">Upload last quarter's work orders (portal CSV). Nothing is saved — the audit runs in your browser against the active rules. Default range: {q.label}.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <label className="block text-xs font-medium text-text-secondary">Received from
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="focus-ring mt-1 block w-full rounded-xl border border-border bg-bg-primary px-3 py-3 text-base text-text-primary" /></label>
          <label className="block text-xs font-medium text-text-secondary">Received to
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="focus-ring mt-1 block w-full rounded-xl border border-border bg-bg-primary px-3 py-3 text-base text-text-primary" /></label>
          <label className="focus-ring inline-flex min-h-[48px] cursor-pointer items-center justify-center rounded-xl bg-accent px-5 text-base font-semibold text-white">
            {busy ? 'Reading…' : 'Upload CSV'}
            <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2"><input type="radio" checked={source === 'saved'} onChange={() => setSource('saved')} /> Saved orders ({saved.length})</label>
          <label className={`flex items-center gap-2 ${file ? '' : 'opacity-50'}`}><input type="radio" disabled={!file} checked={source === 'file'} onChange={() => setSource('file')} /> Uploaded file{file ? ` (${file.name})` : ''}</label>
        </div>
        {from > to && <p role="alert" className="mt-2 text-sm text-red-500">The start date must be on or before the end date.</p>}
        {readError && <p role="alert" className="mt-2 text-sm text-red-500">{readError}</p>}
        {source === 'file' && file && file.result.missingRequired.length > 0 && <p role="alert" className="mt-2 text-sm text-red-500">Could not find the required column(s): {file.result.missingRequired.join(', ')}. Use the Import tab to map columns.</p>}
        {source === 'file' && file && file.result.errors.length > 0 && <p className="mt-2 text-sm text-amber-500">{file.result.errors.length} row(s) were skipped (first: row {file.result.errors[0].row}, {file.result.errors[0].message}).</p>}
      </section>

      {!audit || !t ? null : orders.length === 0 ? (
        <EmptyState icon={FileSearch} title="No orders to audit" description="Upload a CSV or import work orders first." />
      ) : t.atRiskCents === 0 && t.lostCount + t.lateCount === 0 ? (
        <EmptyState icon={FileSearch} title="Clean quarter" description={`${t.ordersReviewed} orders reviewed — no voided, rejected, expired or late items in this range.`} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Dollars at risk" value={formatUsd(t.atRiskCents)} hint={`${t.lostCount + t.lateCount} items of ${t.ordersReviewed} orders`} />
            <Stat label="Avoidable" value={formatUsd(t.avoidableCents)} hint={`${t.avoidableCount} items broke a rule`} />
            <Stat label="Lost (voided / rejected / expired)" value={formatUsd(t.lostCents)} hint={`${t.lostCount} items`} />
            <Stat label="Late but not lost" value={formatUsd(t.lateCents)} hint={`${t.lateCount} items`} />
          </div>
          <p className="text-xs text-text-secondary">Avoidable = at least one rule in your profile was broken on that order. It shows what the rules would have caught, not why the portal acted. Items without an amount on file count as $0{t.noAmountCount ? ` (${t.noAmountCount} here)` : ''}.</p>

          <section aria-label="Rules by cost" className="rounded-2xl border border-border bg-bg-secondary p-4">
            <h3 className="text-sm font-semibold text-text-primary">Which rules cost the most</h3>
            <ul className="mt-2 divide-y divide-border text-sm">
              {audit.byRule.map((r) => <li key={r.code} className="flex justify-between gap-3 py-2"><span>{RULE_LABELS[r.code]} <span className="text-text-secondary">× {r.count}</span></span><span className="font-medium">{formatUsd(r.cents)}</span></li>)}
              {audit.byRule.length === 0 && <li className="py-2 text-text-secondary">No rule violations — every item was outside your control.</li>}
            </ul>
          </section>

          <div className="flex justify-end"><Button variant="secondary" size="sm" onClick={download}><Download size={16} /> Download CSV</Button></div>
          <ul className="space-y-3">
            {audit.items.map((i) => (
              <li key={i.order.woNumber} className="rounded-2xl border border-border bg-bg-secondary p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-semibold text-text-primary">WO {i.order.woNumber}{i.order.location ? ` · ${i.order.location}` : ''}</p>
                  <p className="text-sm font-medium">{formatUsd(i.stakeCents)}</p>
                </div>
                <p className="text-xs text-text-secondary">{i.order.outcome}{i.order.outcomeReason ? ` — ${i.order.outcomeReason}` : ''} · {i.category === 'lost' ? 'Lost' : 'Late'} · {i.avoidable ? 'Avoidable' : 'Not avoidable under your rules'}</p>
                {i.flags.length > 0 && <ul className="mt-3 space-y-2">{i.flags.map((f) => <FlagBadge key={f.code} flag={f} />)}</ul>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
