import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, EyeOff, Trophy, Users } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/EmptyState';
import { StatusPill } from '@/components/commissions/shared';
import {
  KPI_LABEL,
  formatKpi,
  isCurrentPeriod,
  ordinal,
  periodLabel,
  sortBoard,
  toDateOnly,
  type LeaderboardData,
  type LeaderboardPeriod,
  type LeaderboardRow,
  type RankableKpi,
  type SpiffKpi,
} from '@/lib/technicianLeaderboard';

const MEDAL: Record<number, string> = { 1: 'bg-warning-500/15 text-warning-500', 2: 'bg-bg-tertiary text-text-primary', 3: 'bg-accent/10 text-accent' };

function RankBadge({ rank }: { rank: number | null }) {
  if (rank === null) return <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-tertiary text-xs text-text-secondary" aria-label="Not ranked">–</span>;
  return (
    <span
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold tabular-nums ${MEDAL[rank] ?? 'bg-bg-tertiary text-text-secondary'}`}
      aria-label={`Rank ${ordinal(rank)}`}
    >
      {rank <= 3 ? <Trophy className="h-4 w-4" aria-hidden="true" /> : rank}
    </span>
  );
}

function kpiValue(row: LeaderboardRow, kpi: SpiffKpi): number | null {
  switch (kpi) {
    case 'first_time_fix_rate': return row.first_time_fix_rate;
    case 'upsell_rate': return row.upsell_rate;
    case 'csat_avg': return row.csat_avg;
    case 'revenue_cents': return row.revenue_cents;
    case 'jobs_completed': return row.jobs_completed;
    case 'overall': return row.overall_score;
  }
}

export function LeaderboardBoard({
  data,
  period,
  anchor,
  onPeriod,
  onAnchor,
  onShift,
}: {
  data: LeaderboardData;
  period: LeaderboardPeriod;
  anchor: string;
  onPeriod: (p: LeaderboardPeriod) => void;
  onAnchor: (a: string) => void;
  onShift: (delta: -1 | 1) => void;
}) {
  const [sortKpi, setSortKpi] = useState<SpiffKpi>('overall');
  const rows = data.rows ?? [];
  const enabled: RankableKpi[] = data.settings?.enabled_kpis ?? [];
  const minJobs = data.settings?.min_jobs_to_rank ?? 0;
  const sorted = useMemo(() => sortBoard(rows, sortKpi), [rows, sortKpi]);
  const ranked = sorted.filter((r) => r.ranks[sortKpi] !== null);
  const unranked = sorted.filter((r) => r.ranks[sortKpi] === null);
  const today = toDateOnly(new Date());
  const current = isCurrentPeriod(period, anchor, today);
  const info = data.period;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1" role="group" aria-label="Board period">
          {(['weekly', 'monthly'] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onPeriod(p)}
              aria-pressed={period === p}
              className={`focus-ring min-h-[40px] rounded-xl px-4 text-sm font-semibold transition-colors ${period === p ? 'bg-accent text-white' : 'border border-border bg-bg-secondary text-text-secondary hover:text-text-primary'}`}
            >
              {p === 'weekly' ? 'Weekly' : 'Monthly'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => onShift(-1)} aria-label="Previous period"><ChevronLeft className="h-4 w-4" /></Button>
          <span className="min-w-[10rem] text-center text-sm font-semibold text-text-primary" aria-live="polite">
            {info ? periodLabel(period, info.start, info.end) : '…'}
          </span>
          <Button variant="ghost" size="sm" onClick={() => onShift(1)} disabled={current} aria-label="Next period"><ChevronRight className="h-4 w-4" /></Button>
          {!current && <Button variant="secondary" size="sm" onClick={() => onAnchor(today)}>Today</Button>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
        {info && (info.closed ? <StatusPill tone={info.settled ? 'success' : 'warning'}>{info.settled ? 'Final' : 'Closed · settling'}</StatusPill> : <StatusPill tone="info">In progress</StatusPill>)}
        <span>Technicians need {minJobs}+ completed jobs to be ranked.</span>
      </div>

      <div className="flex items-center gap-2">
        <label htmlFor="lb-sort" className="text-sm font-medium text-text-primary">Rank by</label>
        <select
          id="lb-sort"
          value={sortKpi}
          onChange={(e) => setSortKpi(e.target.value as SpiffKpi)}
          className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
        >
          <option value="overall">{KPI_LABEL.overall}</option>
          {(['first_time_fix_rate', 'upsell_rate', 'csat_avg', 'revenue_cents', 'jobs_completed'] as const)
            .filter((k) => enabled.includes(k) || k === 'jobs_completed')
            .map((k) => <option key={k} value={k}>{KPI_LABEL[k]}</option>)}
        </select>
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={Users} title="No technicians on the board yet" description="Active technicians appear here once they complete jobs in this period." />
      ) : (
        <ol className="space-y-2" aria-label="Leaderboard">
          {[...ranked, ...unranked].map((r, i) => {
            const rank = r.ranks[sortKpi];
            return (
              <li key={r.team_member_id ?? `anon-${i}`}>
                <Card className={`!p-3 hover:!translate-y-0 sm:!p-4 ${r.is_me ? 'border-accent/50 bg-accent/5' : ''} ${rank === null ? 'opacity-80' : ''}`}>
                  <div className="flex items-center gap-3">
                    <RankBadge rank={rank} />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 truncate text-sm font-semibold text-text-primary">
                        {r.name}
                        {r.is_me && <StatusPill tone="info">You</StatusPill>}
                      </p>
                      <p className="text-xs text-text-secondary">
                        {r.jobs_completed} job{r.jobs_completed === 1 ? '' : 's'}
                        {!r.eligible && r.jobs_completed < minJobs ? ` · ${minJobs - r.jobs_completed} more to be ranked` : ''}
                        {r.csat_responses > 0 && r.csat_avg === null ? ' · rating hidden until more reviews arrive' : ''}
                      </p>
                    </div>
                    <p className="text-right text-lg font-bold tabular-nums text-text-primary">{formatKpi(sortKpi, kpiValue(r, sortKpi))}</p>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                    {enabled.map((k) => (
                      <div key={k} className="flex justify-between gap-2 sm:block">
                        <dt className="text-text-secondary">{KPI_LABEL[k]}</dt>
                        <dd className="font-semibold tabular-nums text-text-primary">{formatKpi(k, kpiValue(r, k))}</dd>
                      </div>
                    ))}
                  </dl>
                </Card>
              </li>
            );
          })}
        </ol>
      )}

      {(data.opted_out?.length ?? 0) > 0 && (
        <Card className="!p-4 hover:!translate-y-0">
          <p className="flex items-center gap-2 text-sm font-semibold text-text-primary"><EyeOff className="h-4 w-4 text-text-secondary" aria-hidden="true" /> Opted out of the leaderboard</p>
          <p className="mt-1 text-xs text-text-secondary">Not ranked, not shown to colleagues, and not eligible for new bonuses: {data.opted_out!.map((o) => o.name).join(', ')}.</p>
        </Card>
      )}
    </div>
  );
}
