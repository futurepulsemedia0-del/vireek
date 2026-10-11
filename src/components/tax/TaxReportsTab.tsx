import { useCallback, useEffect, useState } from 'react';
import { Download, Loader2, Printer } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { buildTaxReportCsv, formatRate } from '@/lib/salesTax';
import { fetchTaxReport, type TaxReport, type TaxReportBasis } from '@/lib/salesTaxApi';

const inputClass = 'focus-ring rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';
const money = (c: number) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const iso = (d: Date) => d.toISOString().slice(0, 10);

function presetRange(kind: 'month' | 'lastMonth' | 'quarter' | 'year'): [string, string] {
  const n = new Date();
  const y = n.getUTCFullYear();
  const m = n.getUTCMonth();
  if (kind === 'month') return [iso(new Date(Date.UTC(y, m, 1))), iso(new Date(Date.UTC(y, m + 1, 0)))];
  if (kind === 'lastMonth') return [iso(new Date(Date.UTC(y, m - 1, 1))), iso(new Date(Date.UTC(y, m, 0)))];
  if (kind === 'quarter') { const q = Math.floor(m / 3) * 3; return [iso(new Date(Date.UTC(y, q, 1))), iso(new Date(Date.UTC(y, q + 3, 0)))]; }
  return [`${y}-01-01`, `${y}-12-31`];
}

export function TaxReportsTab() {
  const { toast } = useToast();
  const [[from, to], setRange] = useState<[string, string]>(() => presetRange('lastMonth'));
  const [basis, setBasis] = useState<TaxReportBasis>('invoiced');
  const [report, setReport] = useState<TaxReport | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!from || !to || from > to) { toast('Choose a valid date range.', 'error'); return; }
    setLoading(true);
    try { setReport(await fetchTaxReport(from, to, basis)); } catch { toast('Could not load the report.', 'error'); } finally { setLoading(false); }
  }, [from, to, basis, toast]);

  useEffect(() => { void load(); }, [load]);

  const totals = (report?.summary ?? []).reduce(
    (t, r) => ({ gross: t.gross + r.gross_cents, taxable: t.taxable + r.taxable_cents, exempt: t.exempt + r.exempt_cents, tax: t.tax + r.tax_cents }),
    { gross: 0, taxable: 0, exempt: 0, tax: 0 }
  );

  const exportCsv = () => {
    if (!report) return;
    const blob = new Blob([buildTaxReportCsv(report.summary, report.jurisdictions, report.exemptSales)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sales-tax-${from}_to_${to}-${basis}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3 print:hidden">
        <label className="text-xs text-text-secondary">From<input type="date" className={`${inputClass} mt-1 block`} value={from} onChange={(e) => setRange([e.target.value, to])} /></label>
        <label className="text-xs text-text-secondary">To<input type="date" className={`${inputClass} mt-1 block`} value={to} onChange={(e) => setRange([from, e.target.value])} /></label>
        <div className="flex gap-1">
          {([['month', 'This month'], ['lastMonth', 'Last month'], ['quarter', 'This quarter'], ['year', 'This year']] as const).map(([k, label]) => (
            <button key={k} type="button" onClick={() => setRange(presetRange(k))} className="focus-ring rounded-lg border border-border px-2.5 py-2 text-xs text-text-secondary hover:text-text-primary">{label}</button>
          ))}
        </div>
        <label className="text-xs text-text-secondary">Basis
          <select className={`${inputClass} mt-1 block`} value={basis} onChange={(e) => setBasis(e.target.value as TaxReportBasis)}>
            <option value="invoiced">Accrual — by invoice sent date</option>
            <option value="paid">Cash — by payment date</option>
          </select>
        </label>
        <button type="button" onClick={exportCsv} disabled={!report} className="focus-ring inline-flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-primary disabled:opacity-50"><Download size={12} /> CSV</button>
        <button type="button" onClick={() => window.print()} className="focus-ring inline-flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-primary"><Printer size={12} /> Print</button>
      </div>

      {loading ? (
        <div className="flex h-32 items-center justify-center"><Loader2 className="animate-spin" /></div>
      ) : report && (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            {[['Gross sales', totals.gross], ['Taxable sales', totals.taxable], ['Exempt sales', totals.exempt], ['Tax collected', totals.tax]].map(([label, v]) => (
              <div key={label as string} className="rounded-2xl border border-border bg-bg-secondary p-4">
                <p className="text-xs text-text-secondary">{label}</p>
                <p className="mt-1 text-lg font-semibold text-text-primary">{money(v as number)}</p>
              </div>
            ))}
          </div>
          {report.summary.some((r) => r.state === '??') && (
            <p className="text-xs text-warning-500">Some invoices have no service address, so they are grouped under “??”. Add the address to report them to the right state.</p>
          )}

          <section className="rounded-2xl border border-border bg-bg-secondary p-5">
            <p className="mb-2 text-sm font-semibold text-text-primary">By state</p>
            <div className="overflow-x-auto"><table className="w-full text-left text-xs">
              <thead className="text-text-secondary"><tr><th className="py-1.5">State</th><th>Invoices</th><th>Gross</th><th>Taxable</th><th>Non-taxable</th><th>Exempt</th><th>Tax collected</th></tr></thead>
              <tbody className="divide-y divide-border/60 text-text-primary">
                {report.summary.map((r) => <tr key={r.state}><td className="py-1.5 font-medium">{r.state}</td><td>{r.invoice_count}</td><td>{money(r.gross_cents)}</td><td>{money(r.taxable_cents)}</td><td>{money(r.nontaxable_cents)}</td><td>{money(r.exempt_cents)}</td><td>{money(r.tax_cents)}</td></tr>)}
                {report.summary.length === 0 && <tr><td colSpan={7} className="py-6 text-center text-text-secondary">No invoices in this period.</td></tr>}
              </tbody>
            </table></div>
          </section>

          <section className="rounded-2xl border border-border bg-bg-secondary p-5">
            <p className="mb-2 text-sm font-semibold text-text-primary">By jurisdiction (what you owe each authority)</p>
            <div className="overflow-x-auto"><table className="w-full text-left text-xs">
              <thead className="text-text-secondary"><tr><th className="py-1.5">State</th><th>Level</th><th>Jurisdiction</th><th>Rate</th><th>Taxable sales</th><th>Tax collected</th><th>Invoices</th></tr></thead>
              <tbody className="divide-y divide-border/60 text-text-primary">
                {report.jurisdictions.map((r, i) => <tr key={i}><td className="py-1.5 font-medium">{r.state}</td><td>{r.jurisdiction_level}</td><td>{r.jurisdiction_name}</td><td>{formatRate(r.rate_percent)}</td><td>{money(r.taxable_cents)}</td><td>{money(r.tax_cents)}</td><td>{r.invoice_count}</td></tr>)}
                {report.jurisdictions.length === 0 && <tr><td colSpan={7} className="py-6 text-center text-text-secondary">No itemised tax in this period. Invoices using a manual rate are included in the state totals only.</td></tr>}
              </tbody>
            </table></div>
          </section>

          <section className="rounded-2xl border border-border bg-bg-secondary p-5">
            <p className="mb-2 text-sm font-semibold text-text-primary">Exempt sales (audit trail)</p>
            <div className="overflow-x-auto"><table className="w-full text-left text-xs">
              <thead className="text-text-secondary"><tr><th className="py-1.5">Invoice</th><th>Customer</th><th>Date</th><th>State</th><th>Exempt amount</th><th>Certificate</th><th>Cert. expires</th></tr></thead>
              <tbody className="divide-y divide-border/60 text-text-primary">
                {report.exemptSales.map((r) => <tr key={r.invoice_id}><td className="py-1.5 font-medium">{r.invoice_number}</td><td>{r.customer_name}</td><td>{r.invoiced_on}</td><td>{r.state}</td><td>{money(r.exempt_cents)}</td><td>{r.certificate_ref ?? '—'}</td><td>{r.expires_on ?? '—'}</td></tr>)}
                {report.exemptSales.length === 0 && <tr><td colSpan={7} className="py-6 text-center text-text-secondary">No exempt sales in this period.</td></tr>}
              </tbody>
            </table></div>
          </section>
        </>
      )}
    </div>
  );
}
