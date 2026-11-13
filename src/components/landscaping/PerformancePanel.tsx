import { useMemo, useState } from 'react';
import { SelectField } from '@/components/tradePacks/shared';
import { addDays, summarizeCrewProductivity, totals } from '@/lib/tradePacks/landscaping/index';
import { listCrews, listVisits, useLandscapeLoader } from '@/lib/landscapingApi';
import { PanelState, Section, cents, todayISO } from './ui';

const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n * 100)}%`);

export function PerformancePanel() {
  const [days, setDays] = useState('30');
  const to = todayISO();
  const from = addDays(to, -(Number(days) - 1));
  const crews = useLandscapeLoader((o) => listCrews(o), []);
  const visits = useLandscapeLoader((o) => listVisits(o, from, to), [from, to]);
  const rows = useMemo(() => summarizeCrewProductivity(visits.data ?? [], { from, to }), [visits.data, from, to]);
  const name = (id: string | null) => (id ? crews.data?.find((c) => c.id === id)?.name ?? 'Crew' : 'Unassigned');
  const t = totals(rows);

  return (
    <Section title="Crew productivity" description="Measured from visit start/finish times. Visits without both times count toward totals but not toward time-based ratios.">
      <div className="mb-3 max-w-xs">
        <SelectField label="Period" value={days} onChange={setDays}>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
        </SelectField>
      </div>
      <PanelState loading={visits.loading} error={visits.error} empty={rows.length === 0} emptyTitle="No visits in this period" emptyDescription="Metrics appear after visits have been scheduled and completed." onRetry={visits.reload}>
        <p className="mb-2 text-sm text-text-secondary">{t.completed} of {t.scheduled} visits completed · {cents(t.revenueCents)} · {t.laborHours} labor hours</p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <caption className="sr-only">Productivity by crew</caption>
            <thead className="text-xs text-text-secondary">
              <tr><th scope="col" className="py-1 pr-3">Crew</th><th scope="col" className="pr-3">Done</th><th scope="col" className="pr-3">Skipped</th><th scope="col" className="pr-3">On time</th><th scope="col" className="pr-3">vs plan</th><th scope="col" className="pr-3">Revenue / labor hr</th><th scope="col">Tasks done</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.crewId ?? 'none'} className="border-t border-border">
                  <th scope="row" className="py-2 pr-3 font-medium">{name(r.crewId)}</th>
                  <td className="pr-3">{r.completed}/{r.scheduled} <span className="text-xs text-text-secondary">({pct(r.completionRate)})</span></td>
                  <td className="pr-3">{r.skipped}{Object.keys(r.skippedByReason).length ? <span className="text-xs text-text-secondary"> ({Object.entries(r.skippedByReason).map(([k, n]) => `${k.replace('_', ' ')} ${n}`).join(', ')})</span> : null}</td>
                  <td className="pr-3">{pct(r.onTimeRate)}</td>
                  <td className="pr-3">{r.efficiency === null ? '—' : `${r.efficiency.toFixed(2)}×`}</td>
                  <td className="pr-3">{r.revenuePerLaborHourCents === null ? '—' : cents(r.revenuePerLaborHourCents)}</td>
                  <td>{pct(r.taskCompletionRate)}{r.missingTimeData > 0 && <span className="ml-2 text-xs text-warning">{r.missingTimeData} without times</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PanelState>
    </Section>
  );
}
