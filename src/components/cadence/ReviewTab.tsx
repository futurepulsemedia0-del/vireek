import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDownRight, ArrowRight, ArrowUpRight, BarChart3 } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { FadeIn, SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { ErrorBlock, Sparkline, cardClass, errMsg, type TabProps } from '@/components/cadence/shared';
import {
  METRIC_BY_KEY,
  addDays,
  buildQuarterReview,
  formatMetric,
  mondayOf,
  pastWeeks,
  trendSeries,
  type Issue,
  type MetricReview,
  type Priority,
  type SnapshotRow,
  type Target,
} from '@/lib/cadence';
import { captureWeeks, fetchActionItems, fetchIssues, fetchPriorities, fetchRecentMeetings, fetchSnapshots, fetchTargets } from '@/lib/cadenceApi';

const WEEKS = 13;

interface Data {
  snaps: SnapshotRow[];
  targets: Target[];
  priorities: Priority[];
  issues: Issue[];
  meetingsHeld: number;
  actionItems: number;
}

function TrendCell({ r }: { r: MetricReview }) {
  if (r.trend === 'unknown') return <span className="text-xs text-text-secondary">Not enough data</span>;
  const good = r.improving;
  const Icon = r.trend === 'up' ? ArrowUpRight : r.trend === 'down' ? ArrowDownRight : ArrowRight;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold ${good ? 'text-success-500' : 'text-danger-500'}`}>
      <Icon size={13} /> {r.trend === 'flat' ? 'Steady' : good ? 'Improving' : 'Slipping'}
    </span>
  );
}

export function ReviewTab({ today, canManage }: TabProps) {
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [error, setError] = useState('');
  const [data, setData] = useState<Data | null>(null);

  const currentWeek = mondayOf(today);
  const weeks = useMemo(() => pastWeeks(currentWeek, WEEKS), [currentWeek]);
  const since = addDays(today, -90);

  const load = useCallback(async () => {
    setState('loading');
    try {
      if (canManage) await captureWeeks(WEEKS).catch(() => 0);
      const [snaps, targets, priorities, issues, meetings] = await Promise.all([
        fetchSnapshots(weeks),
        fetchTargets(),
        fetchPriorities(since),
        fetchIssues(),
        fetchRecentMeetings(40),
      ]);
      const held = meetings.filter((m) => m.started_at.slice(0, 10) >= since);
      const items = await fetchActionItems(held.map((m) => m.id));
      setData({ snaps, targets, priorities, issues, meetingsHeld: held.length, actionItems: items.length });
      setState('ready');
    } catch (e) {
      setError(errMsg(e));
      setState('error');
    }
  }, [canManage, weeks, since]);

  useEffect(() => {
    void load();
  }, [load]);

  const review = useMemo(
    () => (data ? buildQuarterReview({ weeks, snapshots: data.snaps, targets: data.targets, priorities: data.priorities, issues: data.issues, meetingsHeld: data.meetingsHeld, actionItems: data.actionItems, today, sinceIso: since }) : null),
    [data, weeks, today, since],
  );

  if (state === 'loading') {
    return (
      <>
        <SkeletonStatGrid count={4} />
        <div className="mt-6"><SkeletonCardList count={3} /></div>
      </>
    );
  }
  if (state === 'error' || !review || !data) return <ErrorBlock message={error} onRetry={() => void load()} />;

  const empty = review.metrics.length === 0 && review.priorities.total === 0 && review.issues.created === 0 && review.meetings.held === 0;
  if (empty) {
    return (
      <EmptyState
        icon={BarChart3}
        title="Not enough history yet"
        description="The review fills in as weekly numbers are captured, priorities are tracked and meetings are held."
      />
    );
  }

  const stat = (label: string, value: string, sub?: string) => (
    <div className={cardClass}>
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-text-secondary">{sub}</p>}
    </div>
  );

  return (
    <FadeIn>
      <p className="mb-4 text-sm text-text-secondary">Last 90 days · {since} to {today}</p>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {stat('Priorities done', review.priorities.completionPct === null ? '—' : `${review.priorities.completionPct}%`, `${review.priorities.done} of ${review.priorities.total} · ${review.priorities.overdue} overdue`)}
        {stat('Issues solved', `${review.issues.solved}`, `${review.issues.created} raised · ${review.issues.stillLive} still open`)}
        {stat('Avg. days to solve', review.issues.avgDaysToSolve === null ? '—' : `${review.issues.avgDaysToSolve}`, 'Raised to solved')}
        {stat('Meetings held', `${review.meetings.held}`, `${review.meetings.actionItems} action items`)}
      </div>

      <section className="mt-6" aria-label="Metric trends">
        <h2 className="mb-3 text-lg font-semibold text-text-primary">Scorecard over 13 weeks</h2>
        {review.metrics.length === 0 ? (
          <EmptyState icon={BarChart3} title="No weekly numbers captured yet" description="Weekly snapshots appear after the first full week." />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark">
            <table className="w-full min-w-[640px] text-left text-sm">
              <caption className="sr-only">Metric performance over the last 13 weeks</caption>
              <thead className="border-b border-border text-xs text-text-secondary">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Metric</th>
                  <th scope="col" className="px-4 py-3 font-medium">Trend</th>
                  <th scope="col" className="px-4 py-3 font-medium">Average</th>
                  <th scope="col" className="px-4 py-3 font-medium">Latest</th>
                  <th scope="col" className="px-4 py-3 font-medium">Weeks on target</th>
                  <th scope="col" className="px-4 py-3 font-medium">Direction</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {review.metrics.map((m) => (
                  <tr key={m.key}>
                    <th scope="row" className="px-4 py-3 font-semibold text-text-primary">{METRIC_BY_KEY[m.key].label}</th>
                    <td className="px-4 py-3">
                      <Sparkline values={trendSeries(data.snaps, m.key, weeks)} tone={m.improving === null ? 'neutral' : m.improving ? 'success' : 'danger'} label={METRIC_BY_KEY[m.key].label} />
                    </td>
                    <td className="px-4 py-3 text-text-primary">{formatMetric(m.key, m.average)}</td>
                    <td className="px-4 py-3 text-text-primary">{formatMetric(m.key, m.last)}</td>
                    <td className="px-4 py-3 text-text-primary">{m.greenPct === null ? <span className="text-text-secondary">No target</span> : `${m.weeksGreen}/${m.weeksWithData} (${m.greenPct}%)`}</td>
                    <td className="px-4 py-3"><TrendCell r={m} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </FadeIn>
  );
}
