import { useCallback, useEffect, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonStatGrid, SkeletonTable } from '@/components/Skeleton';
import { pct, type CanvassReport } from '@/lib/canvassing';
import { fetchReport } from '@/lib/canvassingApi';
import { KpiTile, ProgressBar, TerritoryDot, compactSelectCls } from './canvassUi';

const RANGES = [7, 30, 90];

interface Row { knocks: number; contacts: number; interested: number; appointments: number; sold: number }
const win = (r: Row) => pct(r.appointments + r.sold, r.contacts);

export function ResultsPanel({ isManager }: { isManager: boolean }) {
  const [days, setDays] = useState(30);
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [report, setReport] = useState<CanvassReport | null>(null);

  const load = useCallback(async (d: number, isCurrent: () => boolean) => {
    setState('loading');
    try {
      const r = await fetchReport(d);
      if (!isCurrent()) return;
      setReport(r);
      setState('ready');
    } catch {
      if (isCurrent()) setState('error');
    }
  }, []);

  useEffect(() => {
    let current = true;
    void load(days, () => current);
    return () => { current = false; };
  }, [days, load]);

  const t = report?.totals;
  const empty = state === 'ready' && t !== undefined && t.knocks === 0;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-text-secondary">{isManager ? 'Funnel for the whole team.' : 'Your own knocks.'}</p>
        <select aria-label="Time range" value={days} onChange={(e) => setDays(Number(e.target.value))} className={compactSelectCls}>
          {RANGES.map((r) => <option key={r} value={r}>Last {r} days</option>)}
        </select>
      </div>

      {state === 'loading' && <><SkeletonStatGrid count={4} /><SkeletonTable rows={4} columns={6} /></>}
      {state === 'error' && <EmptyStateError icon={BarChart3} title="Couldn't load results" onRetry={() => void load(days, () => true)} />}
      {empty && <EmptyState icon={BarChart3} title="No knocks in this period" description="Results appear as soon as a visit is logged on the Doors tab." />}

      {state === 'ready' && report && t && !empty && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiTile label="Doors knocked" value={t.doors.toLocaleString()} sub={`${t.knocks.toLocaleString()} knocks`} />
            <KpiTile label="Conversations" value={t.contacts.toLocaleString()} sub={`${pct(t.contacts, t.knocks)}% of knocks`} />
            <KpiTile label="Appointments + sold" value={(t.appointments + t.sold).toLocaleString()} sub={`${win(t)}% of conversations`} />
            <KpiTile label="Leads created" value={t.leads.toLocaleString()} sub={`${t.do_not_knock} do-not-knock`} />
          </div>

          {isManager && report.by_rep.length > 0 && (
            <section aria-label="By rep" className="overflow-x-auto rounded-2xl border border-border bg-bg-secondary">
              <table className="w-full min-w-[34rem] text-sm">
                <caption className="sr-only">Results by rep</caption>
                <thead><tr className="border-b border-border text-left text-xs text-text-secondary">
                  <th scope="col" className="px-4 py-3 font-medium">Rep</th><th scope="col" className="px-3 py-3 text-right font-medium">Knocks</th>
                  <th scope="col" className="px-3 py-3 text-right font-medium">Talks</th><th scope="col" className="px-3 py-3 text-right font-medium">Interested</th>
                  <th scope="col" className="px-3 py-3 text-right font-medium">Appts</th><th scope="col" className="px-3 py-3 text-right font-medium">Sold</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Win rate</th>
                </tr></thead>
                <tbody className="divide-y divide-border">
                  {report.by_rep.map((r) => (
                    <tr key={r.rep_user_id ?? 'former'}>
                      <th scope="row" className="px-4 py-3 text-left font-medium text-text-primary">{r.name}</th>
                      <td className="px-3 py-3 text-right tabular-nums">{r.knocks}</td><td className="px-3 py-3 text-right tabular-nums">{r.contacts}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{r.interested}</td><td className="px-3 py-3 text-right tabular-nums">{r.appointments}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{r.sold}</td><td className="px-4 py-3 text-right tabular-nums">{win(r)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {report.by_territory.length > 0 && (
            <section aria-label="By territory" className="overflow-x-auto rounded-2xl border border-border bg-bg-secondary">
              <table className="w-full min-w-[34rem] text-sm">
                <caption className="sr-only">Results by territory</caption>
                <thead><tr className="border-b border-border text-left text-xs text-text-secondary">
                  <th scope="col" className="px-4 py-3 font-medium">Territory</th><th scope="col" className="px-3 py-3 font-medium">Coverage</th>
                  <th scope="col" className="px-3 py-3 text-right font-medium">Knocks</th><th scope="col" className="px-3 py-3 text-right font-medium">Appts</th>
                  <th scope="col" className="px-3 py-3 text-right font-medium">Sold</th><th scope="col" className="px-4 py-3 text-right font-medium">Win rate</th>
                </tr></thead>
                <tbody className="divide-y divide-border">
                  {report.by_territory.map((r) => {
                    const covered = pct(r.doors_total - r.doors_unvisited, r.doors_total);
                    return (
                      <tr key={r.territory_id}>
                        <th scope="row" className="px-4 py-3 text-left font-medium text-text-primary"><span className="inline-flex items-center gap-2"><TerritoryDot color={r.color} />{r.name}</span></th>
                        <td className="px-3 py-3"><div className="flex min-w-[7rem] items-center gap-2"><ProgressBar value={covered} label={`${r.name} coverage`} color={r.color} /><span className="w-9 shrink-0 text-right text-xs tabular-nums text-text-secondary">{covered}%</span></div></td>
                        <td className="px-3 py-3 text-right tabular-nums">{r.knocks}</td><td className="px-3 py-3 text-right tabular-nums">{r.appointments}</td>
                        <td className="px-3 py-3 text-right tabular-nums">{r.sold}</td><td className="px-4 py-3 text-right tabular-nums">{win(r)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </div>
  );
}
