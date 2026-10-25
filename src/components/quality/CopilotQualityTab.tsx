import { Link } from 'react-router-dom';
import { KpiStatCard } from '@/components/KpiStatCard';
import type { CopilotStats } from '@/lib/callQuality';
import { fmtDate } from './qualityUi';

export function CopilotQualityTab({ stats }: { stats: CopilotStats | null }) {
  if (!stats || stats.sessions === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-14 text-center">
        <p className="text-base font-semibold text-text-primary">No Live Copilot sessions in this period</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-text-secondary">When technicians use the Live Copilot in the field, its confidence, escalations and the information it keeps asking for show up here.</p>
      </div>
    );
  }
  const lowShare = stats.turns ? Math.round((stats.low_confidence_turns / stats.turns) * 100) : 0;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiStatCard label="Sessions" value={stats.sessions} hint={`${stats.turns} answers given`} />
        <KpiStatCard label="Average confidence" value={stats.avg_confidence === null ? '—' : `${Math.round(stats.avg_confidence * 100)}%`} hint="Higher is better" />
        <KpiStatCard label="Low-confidence answers" value={`${lowShare}%`} hint={`${stats.low_confidence_turns} below 50% confidence`} />
        <KpiStatCard label="Escalated to an expert" value={stats.escalated} hint={`${stats.emergency} emergency-level sessions`} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-border bg-bg-secondary p-5">
          <h2 className="text-base font-semibold text-text-primary">What the Copilot keeps asking for</h2>
          <p className="text-xs text-text-secondary">Missing information it reported most. Adding these to your Knowledge Base or equipment records raises confidence.</p>
          {stats.top_missing_info.length === 0 ? <p className="mt-3 text-sm text-text-secondary">Nothing reported as missing.</p> : (
            <ul className="mt-3 space-y-2">
              {stats.top_missing_info.map((m) => (
                <li key={m.text} className="flex items-center justify-between gap-3 rounded-lg bg-bg-primary px-3 py-2 text-sm">
                  <span className="min-w-0 truncate text-text-primary">{m.text}</span><span className="font-semibold tabular-nums text-text-primary">{m.count}×</span>
                </li>
              ))}
            </ul>
          )}
          <Link to="/dashboard/knowledge" className="focus-ring mt-4 inline-block text-sm font-medium text-accent hover:underline">Open Knowledge Base</Link>
        </section>

        <section className="rounded-xl border border-border bg-bg-secondary p-5">
          <h2 className="text-base font-semibold text-text-primary">Sessions worth a look</h2>
          <p className="text-xs text-text-secondary">Escalated, high-severity, or any answer under 40% confidence.</p>
          {stats.flagged_sessions.length === 0 ? <p className="mt-3 text-sm text-text-secondary">No flagged sessions.</p> : (
            <ul className="mt-3 space-y-2">
              {stats.flagged_sessions.map((s) => (
                <li key={s.id} className="rounded-lg bg-bg-primary px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-text-primary">{fmtDate(s.created_at)}</span>
                    <span className="text-xs capitalize text-text-secondary">{s.status} · {s.max_severity} severity</span>
                  </div>
                  <p className="text-xs text-text-secondary">{s.turn_count} turn{s.turn_count === 1 ? '' : 's'}{s.min_confidence !== null ? ` · lowest confidence ${Math.round(s.min_confidence * 100)}%` : ''}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
