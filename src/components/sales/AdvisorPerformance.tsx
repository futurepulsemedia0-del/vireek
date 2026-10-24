import { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { Input } from '@/components/ui/Input';
import { buildAdvisorRows, defaultRange, money, moneyExact, salesErrorMessage, teamTotals, type PerformancePayload } from '@/lib/inHomeSales';
import { getSalesPerformance } from '@/lib/inHomeSalesApi';

const pct = (v: number | null) => (v === null ? '—' : `${v}%`);

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

/** Close rate, average ticket and estimated commission by advisor. Advisors see only themselves (enforced in SQL). */
export function AdvisorPerformance() {
  const initial = useMemo(() => defaultRange(), []);
  const [start, setStart] = useState(initial.start);
  const [end, setEnd] = useState(initial.end);
  const [data, setData] = useState<PerformancePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!start || !end || end < start) {
      setError('Pick a valid date range.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setData(await getSalesPerformance(start, end));
    } catch (e) {
      setError(salesErrorMessage(e, 'Could not load performance.'));
    } finally {
      setLoading(false);
    }
  }, [start, end]);
  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(() => (data ? buildAdvisorRows(data) : []), [data]);
  const totals = useMemo(() => teamTotals(rows), [rows]);

  return (
    <section aria-label="Advisor performance" className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-44"><Input label="From" type="date" value={start} max={end} onChange={(e) => setStart(e.target.value)} /></div>
        <div className="w-44"><Input label="To" type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} /></div>
      </div>

      {error && <EmptyStateError icon={BarChart3} title="Performance unavailable" description={error} onRetry={() => void load()} />}

      {!error && loading && (
        <div className="space-y-3" aria-busy="true" aria-label="Loading performance">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="h-24 animate-pulse rounded-2xl bg-bg-tertiary" />)}</div>
          <div className="h-40 animate-pulse rounded-2xl bg-bg-tertiary" />
        </div>
      )}

      {!error && !loading && data && rows.length === 0 && (
        <EmptyState icon={BarChart3} title="No presentations in this range" description="Run an in-home presentation and results show up here as soon as it is sold or lost." />
      )}

      {!error && !loading && rows.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label="Close rate" value={pct(totals.closeRatePct)} hint={`${totals.sold} sold · ${totals.lost} lost`} />
            <Tile label="Average ticket" value={totals.avgTicketCents === null ? '—' : money(totals.avgTicketCents)} hint="Tax included" />
            <Tile label="Sold" value={money(totals.soldTotalCents)} hint={`${totals.appointments} appointments`} />
            <Tile label="Est. commission" value={money(totals.commissionCents)} hint="On sold, pre-tax" />
          </div>

          <ul className="space-y-3 md:hidden">
            {rows.map((r) => (
              <li key={r.advisor_user_id} className="rounded-2xl border border-border bg-bg-secondary p-4">
                <p className="font-semibold text-text-primary">{r.name}</p>
                <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
                  <div><dt className="text-text-secondary">Close rate</dt><dd className="font-semibold">{pct(r.closeRatePct)}</dd></div>
                  <div><dt className="text-text-secondary">Avg ticket</dt><dd className="font-semibold">{r.avgTicketCents === null ? '—' : money(r.avgTicketCents)}</dd></div>
                  <div><dt className="text-text-secondary">Sold</dt><dd className="font-semibold">{r.sold} · {money(r.sold_total_cents)}</dd></div>
                  <div><dt className="text-text-secondary">Commission</dt><dd className="font-semibold">{r.commissionCents === null ? 'No plan' : moneyExact(r.commissionCents)}</dd></div>
                </dl>
              </li>
            ))}
          </ul>

          <div className="hidden overflow-x-auto rounded-2xl border border-border md:block">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Performance by comfort advisor</caption>
              <thead className="bg-bg-tertiary text-xs uppercase tracking-wide text-text-secondary">
                <tr>
                  {['Advisor', 'Appts', 'Presented', 'Sold', 'Lost', 'Close rate', 'Avg ticket', 'Sold total', 'Financed', 'Deposits', 'Est. commission'].map((h) => (
                    <th key={h} scope="col" className="px-3 py-2.5 font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {rows.map((r) => (
                  <tr key={r.advisor_user_id}>
                    <th scope="row" className="px-3 py-2.5 font-medium text-text-primary">{r.name}</th>
                    <td className="px-3 py-2.5">{r.appointments}</td>
                    <td className="px-3 py-2.5">{r.presented}</td>
                    <td className="px-3 py-2.5">{r.sold}</td>
                    <td className="px-3 py-2.5">{r.lost}</td>
                    <td className="px-3 py-2.5 font-semibold">{pct(r.closeRatePct)}</td>
                    <td className="px-3 py-2.5">{r.avgTicketCents === null ? '—' : money(r.avgTicketCents)}</td>
                    <td className="px-3 py-2.5">{money(r.sold_total_cents)}</td>
                    <td className="px-3 py-2.5">{pct(r.financedSharePct)}</td>
                    <td className="px-3 py-2.5">{money(r.deposit_collected_cents)} / {money(r.deposit_due_cents)}</td>
                    <td className="px-3 py-2.5">{r.commissionCents === null ? <span className="text-text-secondary">No plan</span> : moneyExact(r.commissionCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-text-secondary">
            Close rate = sold ÷ (sold + lost) decided in this range. Commission is estimated on the pre-tax sold amount using each advisor&apos;s
            commission plan; payroll commissions are generated separately on collected revenue. Dates are UTC.
          </p>
        </>
      )}
    </section>
  );
}
