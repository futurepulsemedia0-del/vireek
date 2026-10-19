import { TrendingDown, TrendingUp } from 'lucide-react';
import { buildMetricRows, hasBaseline, liveDataState, type Pilot, type Verdict } from '@/lib/pilotManagement';

const VERDICT_CLASS: Record<Verdict, string> = {
  better: 'text-success-500',
  worse: 'text-danger',
  flat: 'text-text-secondary',
  neutral: 'text-text-secondary',
  unknown: 'text-text-secondary',
};

const VERDICT_TEXT: Partial<Record<Verdict, string>> = { better: 'Improved', worse: 'Worse' };

/** Baseline (before Vireek) vs live (last 28 days of the pilot) for one pilot. */
export function PilotMetricsGrid({ pilot }: { pilot: Pilot }) {
  const state = liveDataState(pilot);
  const rows = buildMetricRows(pilot);

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-sm">
          <caption className="sr-only">Baseline versus live metrics for {pilot.company_name ?? pilot.tenant_email ?? 'this pilot'}</caption>
          <thead>
            <tr className="text-xs text-text-secondary">
              <th scope="col" className="py-1.5 pe-3 text-start font-medium">Metric</th>
              <th scope="col" className="px-3 py-1.5 text-end font-medium">Before</th>
              <th scope="col" className="px-3 py-1.5 text-end font-medium">Now{pilot.live.days > 0 ? ` (${Math.min(pilot.live.days, 28)}d)` : ''}</th>
              <th scope="col" className="ps-3 py-1.5 text-end font-medium">Change</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.key}>
                <th scope="row" className="py-2 pe-3 text-start font-medium text-text-primary">{r.label}</th>
                <td className="px-3 py-2 text-end tabular-nums text-text-secondary">{r.baseline}</td>
                <td className="px-3 py-2 text-end tabular-nums text-text-primary">{r.live}</td>
                <td className={`ps-3 py-2 text-end tabular-nums font-medium ${VERDICT_CLASS[r.verdict]}`}>
                  <span className="inline-flex items-center justify-end gap-1">
                    {r.verdict === 'better' && <TrendingUp size={14} aria-hidden="true" />}
                    {r.verdict === 'worse' && <TrendingDown size={14} aria-hidden="true" />}
                    {r.change}
                    {VERDICT_TEXT[r.verdict] && <span className="sr-only"> ({VERDICT_TEXT[r.verdict]})</span>}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div aria-live="polite" className="mt-2 space-y-1 text-xs text-text-secondary">
        {state === 'not_started' && <p>This pilot has not started yet. Live numbers appear once it begins.</p>}
        {state === 'early' && <p>Only {pilot.live.days} live day{pilot.live.days === 1 ? '' : 's'} so far. Treat these numbers as early: they settle after a full week.</p>}
        {!hasBaseline(pilot) && <p>No baseline recorded, so there is nothing to compare against. Edit the pilot to add one.</p>}
      </div>
    </div>
  );
}
