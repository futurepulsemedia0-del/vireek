import { useCallback, useEffect, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonStatGrid } from '@/components/Skeleton';
import { ESTIMATE_DISCLAIMER, STEP_LABELS, fetchMonthlySummary, formatCents, type MonthlySummary } from '@/lib/installCloseout';

export function CloseoutSummaryPanel({ today }: { today: string }) {
  const [month, setMonth] = useState(today.slice(0, 7));
  const [data, setData] = useState<MonthlySummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null); setData(null);
    try { setData(await fetchMonthlySummary(`${month}-01`)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load the summary.'); }
  }, [month]);
  useEffect(() => { void load(); }, [load]);

  const t = data?.totals;
  return (
    <div className="space-y-4">
      <div className="max-w-xs"><Input label="Month" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {!data && !error && <SkeletonStatGrid count={4} />}
      {data && t && t.steps_due === 0 && (
        <EmptyState icon={BarChart3} title="Nothing was due this month" description="Steps appear here when a deadline falls inside the month." />
      )}
      {data && t && t.steps_due > 0 && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Steps due" value={String(t.steps_due)} />
            <Stat label="Completed on time" value={String(t.completed_on_time)} tone="ok" />
            <Stat label="Completed late" value={String(t.completed_late)} tone={t.completed_late ? 'warn' : undefined} />
            <Stat label="Missed (still open)" value={String(t.missed_open)} tone={t.missed_open ? 'bad' : undefined} />
            <Stat label="Still open" value={String(t.still_open)} />
            <Stat label="Closeouts opened" value={String(data.cases_opened)} />
            <Stat label="Est. value filed on time" value={formatCents(t.estimated_cents_completed_on_time)} tone="ok" estimate />
            <Stat label="Est. value missed" value={formatCents(t.estimated_cents_missed)} tone={t.estimated_cents_missed ? 'bad' : undefined} estimate />
          </div>
          <Card className="!p-4 overflow-x-auto">
            <table className="w-full min-w-[28rem] text-left text-sm">
              <caption className="sr-only">Closeout results by step</caption>
              <thead><tr className="text-xs text-text-secondary"><th className="py-1 pr-3">Step</th><th>Due</th><th>On time</th><th>Late</th><th>Missed</th></tr></thead>
              <tbody>
                {data.by_step.map((r) => (
                  <tr key={r.step_key} className="border-t border-border"><td className="py-1.5 pr-3 text-text-primary">{STEP_LABELS[r.step_key]}</td><td>{r.due}</td><td>{r.on_time}</td><td>{r.late}</td><td>{r.missed}</td></tr>
                ))}
              </tbody>
            </table>
          </Card>
          <p className="text-xs text-text-secondary">{ESTIMATE_DISCLAIMER}</p>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone, estimate }: { label: string; value: string; tone?: 'ok' | 'warn' | 'bad'; estimate?: boolean }) {
  const color = tone === 'ok' ? 'text-success' : tone === 'bad' ? 'text-danger' : tone === 'warn' ? 'text-warning-500' : 'text-text-primary';
  return (
    <Card className="!p-4">
      <p className="text-xs text-text-secondary">{label}{estimate ? ' (estimate)' : ''}</p>
      <p className={`mt-1 text-2xl font-semibold ${color}`}>{value}</p>
    </Card>
  );
}
