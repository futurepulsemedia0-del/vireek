// Recreated: verify against original intent
import { useCallback, useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { formatMoney } from '@/lib/partsOrdering';
import { getSpend, type SpendReport } from '@/lib/partsSourcingApi';
import { addDays, centsToDecimal, csvCell, formatBps, utcDay, viewVendorSpend } from '@/lib/partsSourcing';
import { EmptyState, ErrorNote, LoadingRow, card, field, label } from './shared';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 366;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function SpendTab() {
  const today = utcDay(new Date());
  const [from, setFrom] = useState(addDays(today, -90));
  const [to, setTo] = useState(today);
  const [report, setReport] = useState<SpendReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const seq = useRef(0);

  const rangeError = !DAY_RE.test(from) || !DAY_RE.test(to) ? 'Choose both dates.' : daysBetween(from, to) < 0 ? 'The start date must be before the end date.' : daysBetween(from, to) > MAX_RANGE_DAYS ? 'Choose a range of one year or less.' : '';

  const load = useCallback(async () => {
    if (rangeError) return;
    const mine = ++seq.current; // a slow earlier response can never overwrite a newer one
    setLoading(true);
    setError('');
    try {
      const r = await getSpend(from, to);
      if (mine === seq.current) setReport(r);
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error ? e.message : 'Could not load spend.');
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [from, to, rangeError]);

  useEffect(() => {
    void load();
  }, [load]);

  const vendors = report ? viewVendorSpend(report.by_vendor) : [];

  const exportCsv = () => {
    if (!report) return;
    const head = ['Vendor', 'Orders', 'Committed', 'Received', 'Open', 'Share', 'On-time deliveries'];
    const lines = [head.map(csvCell).join(',')];
    for (const v of vendors) {
      lines.push(
        [v.vendor_name, v.po_count, centsToDecimal(v.committed_cents), centsToDecimal(v.received_cents), centsToDecimal(v.openCents), formatBps(v.shareBps), v.onTimeBps === null ? '' : formatBps(v.onTimeBps)]
          .map(csvCell)
          .join(','),
      );
    }
    const url = URL.createObjectURL(new Blob([`\uFEFF${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `parts-spend-${from}-to-${to}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="space-y-4">
      <div className={card}>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="ps-from" className={label}>From</label>
            <input id="ps-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={field} />
          </div>
          <div>
            <label htmlFor="ps-to" className={label}>To</label>
            <input id="ps-to" type="date" value={to} min={from || undefined} max={today} onChange={(e) => setTo(e.target.value)} className={field} />
          </div>
          <Button size="sm" variant="secondary" onClick={exportCsv} disabled={!report || vendors.length === 0}>
            <Download size={14} aria-hidden="true" />
            Export CSV
          </Button>
        </div>
        {rangeError && <p role="alert" className="mt-2 text-xs text-danger">{rangeError}</p>}
      </div>

      {error && <ErrorNote message={error} onRetry={() => void load()} />}
      {loading && !report && <LoadingRow text="Loading spend…" />}

      {report && !rangeError && (
        <>
          <dl className="grid gap-3 sm:grid-cols-3">
            {[
              ['Orders', String(report.totals.po_count)],
              ['Committed', formatMoney(report.totals.committed_cents)],
              ['Received', formatMoney(report.totals.received_cents)],
            ].map(([k, v]) => (
              <div key={k} className={card}>
                <dt className="text-xs font-semibold text-text-secondary">{k}</dt>
                <dd className="mt-1 text-xl font-bold text-text-primary">{v}</dd>
              </div>
            ))}
          </dl>

          <div className={card}>
            <h2 className="text-base font-semibold text-text-primary">By vendor</h2>
            {vendors.length === 0 ? (
              <div className="mt-3"><EmptyState>No orders in this period.</EmptyState></div>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-sm">
                  <thead className="text-xs text-text-secondary">
                    <tr>
                      <th scope="col" className="py-2 pe-3 font-semibold">Vendor</th>
                      <th scope="col" className="px-3 py-2 text-right font-semibold">Orders</th>
                      <th scope="col" className="px-3 py-2 text-right font-semibold">Committed</th>
                      <th scope="col" className="px-3 py-2 text-right font-semibold">Open</th>
                      <th scope="col" className="px-3 py-2 text-right font-semibold">Share</th>
                      <th scope="col" className="ps-3 py-2 text-right font-semibold">On time</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {vendors.map((v) => (
                      <tr key={v.vendor_id ?? v.vendor_name}>
                        <th scope="row" className="py-2 pe-3 font-medium text-text-primary">{v.vendor_name}</th>
                        <td className="px-3 py-2 text-right text-text-secondary">{v.po_count}</td>
                        <td className="px-3 py-2 text-right text-text-primary">{formatMoney(v.committed_cents)}</td>
                        <td className="px-3 py-2 text-right text-text-secondary">{formatMoney(v.openCents)}</td>
                        <td className="px-3 py-2 text-right text-text-secondary">{formatBps(v.shareBps)}</td>
                        {/* No received orders yet: show a dash, never a made-up 0% */}
                        <td className="ps-3 py-2 text-right text-text-secondary">{v.onTimeBps === null ? '—' : formatBps(v.onTimeBps)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {report.by_month.length > 0 && (
            <div className={card}>
              <h2 className="text-base font-semibold text-text-primary">By month</h2>
              <ul className="mt-3 divide-y divide-border">
                {report.by_month.map((m) => (
                  <li key={m.month} className="flex items-center justify-between py-2 text-sm">
                    <span className="text-text-primary">{m.month}</span>
                    <span className="text-text-secondary">{m.po_count} orders · {formatMoney(m.committed_cents)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
