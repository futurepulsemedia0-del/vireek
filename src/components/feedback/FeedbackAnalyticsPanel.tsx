import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Info, RefreshCw, Smile } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import {
  DIMENSION_LABELS, MIN_SAMPLE, buildGroups, buildTrend, npsDelta, splitPeriods, summarize,
  type Dimension, type FeedbackRecord, type GroupSort, type Period,
} from '@/lib/feedbackAnalytics';
import { fetchFeedbackRecords, type FeedbackFeed } from '@/lib/feedbackApi';
import { DeltaBadge, DistributionBar, Sparkline, TrendChart, npsTone } from './FeedbackCharts';
import { FeedbackCommentFeed } from './FeedbackCommentFeed';
import { FeedbackJobDrawer } from './FeedbackJobDrawer';

const RANGES = [{ days: 30, label: '30 days' }, { days: 90, label: '90 days' }, { days: 180, label: '6 months' }, { days: 365, label: '12 months' }];
const DIMENSIONS = Object.keys(DIMENSION_LABELS) as Dimension[];
const SOURCE_FILTERS: { id: 'all' | 'review' | 'call'; label: string }[] = [{ id: 'all', label: 'All feedback' }, { id: 'review', label: 'Job surveys' }, { id: 'call', label: 'Call ratings' }];

/** Day-aligned window ending tomorrow 00:00 UTC so "today's" responses are always inside it. */
function windowFor(days: number): Period {
  const end = new Date();
  const to = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() + 1);
  return { from: to - days * 86_400_000, to };
}

export function FeedbackAnalyticsPanel({ accountOwnerId }: { accountOwnerId: string }) {
  const [days, setDays] = useState(90);
  const [dimension, setDimension] = useState<Dimension>('technician');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'review' | 'call'>('all');
  const [sort, setSort] = useState<GroupSort>('responses');

  const [feed, setFeed] = useState<FeedbackFeed | null>(null);
  const [period, setPeriod] = useState<Period>(() => windowFor(90));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<FeedbackRecord | null>(null);

  const load = useCallback(async (win: Period) => {
    setLoading(true);
    setError(null);
    try {
      setFeed(await fetchFeedbackRecords(win));
      setPeriod(win);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load feedback.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(windowFor(days)); }, [days, load]);

  const records = useMemo(
    () => (feed ? feed.records.filter((r) => sourceFilter === 'all' || r.source === sourceFilter) : []),
    [feed, sourceFilter],
  );
  const { current, previous } = useMemo(() => splitPeriods(records, period), [records, period]);
  const summary = useMemo(() => summarize(current), [current]);
  const prevSummary = useMemo(() => summarize(previous), [previous]);
  const delta = npsDelta(summary, prevSummary);
  const trend = useMemo(() => buildTrend(current, period), [current, period]);
  const groups = useMemo(() => buildGroups(records, dimension, period, sort), [records, dimension, period, sort]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div role="tablist" aria-label="Feedback source" className="flex flex-wrap gap-2">
          {SOURCE_FILTERS.map((s) => (
            <button key={s.id} role="tab" aria-selected={sourceFilter === s.id} onClick={() => setSourceFilter(s.id)} className={`focus-ring rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${sourceFilter === s.id ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}>{s.label}</button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <select aria-label="Time range" value={days} onChange={(e) => setDays(Number(e.target.value))} className="focus-ring rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary">
            {RANGES.map((r) => <option key={r.days} value={r.days}>Last {r.label}</option>)}
          </select>
          <Button variant="ghost" size="sm" onClick={() => void load(windowFor(days))} disabled={loading} aria-label="Refresh"><RefreshCw size={16} className={loading ? 'animate-spin' : ''} /></Button>
        </div>
      </div>

      {error ? (
        <div role="alert" className="flex flex-col items-start gap-3 rounded-2xl border border-danger/30 bg-danger/5 p-5">
          <p className="flex items-center gap-2 text-sm font-semibold text-danger"><AlertTriangle size={18} /> Couldn’t load feedback</p>
          <p className="text-sm text-text-secondary">{error}</p>
          <Button size="sm" variant="secondary" onClick={() => void load(windowFor(days))}>Try again</Button>
        </div>
      ) : loading && !feed ? (
        <div aria-busy="true" className="space-y-6"><SkeletonStatGrid count={4} /><SkeletonCardList count={2} rows={3} /></div>
      ) : summary.n === 0 ? (
        <EmptyState
          icon={Smile}
          title="No customer feedback in this period"
          description={previous.length > 0 ? 'Try a longer time range — there are responses from the period before.' : 'Send post-job review requests and ratings from calls will show up here, with NPS and CSAT calculated automatically.'}
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-busy={loading}>
            <div className="rounded-2xl border border-border bg-bg-secondary p-4">
              <p className="text-xs text-text-secondary">NPS</p>
              <p className={`text-3xl font-bold tabular-nums ${npsTone(summary.nps)}`}>{summary.nps}</p>
              <p className="mt-1 text-xs text-text-secondary"><DeltaBadge delta={delta} /> vs previous {days} days</p>
            </div>
            <div className="rounded-2xl border border-border bg-bg-secondary p-4">
              <p className="text-xs text-text-secondary">CSAT (4–5 stars)</p>
              <p className="text-3xl font-bold tabular-nums text-text-primary">{summary.csat}%</p>
              <p className="mt-1 text-xs text-text-secondary">Average {summary.avg?.toFixed(2)} / 5</p>
            </div>
            <div className="rounded-2xl border border-border bg-bg-secondary p-4">
              <p className="text-xs text-text-secondary">Responses</p>
              <p className="text-3xl font-bold tabular-nums text-text-primary">{summary.n.toLocaleString()}</p>
              <p className="mt-1 text-xs text-text-secondary">{prevSummary.n.toLocaleString()} in the previous period</p>
            </div>
            <div className="rounded-2xl border border-border bg-bg-secondary p-4">
              <p className="mb-2 text-xs text-text-secondary">Promoters · passives · detractors</p>
              <DistributionBar summary={summary} />
            </div>
          </div>

          {feed?.truncated && (
            <p className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-text-primary"><AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600" /> This account has more responses than can be loaded at once, so the oldest ones in this window are left out. Pick a shorter range for exact numbers.</p>
          )}

          <section aria-label="NPS trend" className="rounded-2xl border border-border bg-bg-secondary p-5">
            <h3 className="mb-1 text-base font-semibold text-text-primary">NPS over time</h3>
            <p className="mb-3 text-xs text-text-secondary">Shaded bars show how many responses each {trend.length > 0 && period.to - period.from > 120 * 86_400_000 ? 'month' : 'week'} is based on. Gaps mean no responses.</p>
            <TrendChart points={trend} />
          </section>

          <section aria-label="Breakdown" className="rounded-2xl border border-border bg-bg-secondary p-5">
            <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <h3 className="text-base font-semibold text-text-primary">Breakdown by {DIMENSION_LABELS[dimension].toLowerCase()}</h3>
              <div className="flex flex-wrap items-center gap-2">
                <div role="tablist" aria-label="Break down by" className="flex flex-wrap gap-1.5">
                  {DIMENSIONS.map((d) => (
                    <button key={d} role="tab" aria-selected={dimension === d} onClick={() => setDimension(d)} className={`focus-ring rounded-full border px-3 py-1 text-xs font-semibold ${dimension === d ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}>{DIMENSION_LABELS[d]}</button>
                  ))}
                </div>
                <select aria-label="Sort groups" value={sort} onChange={(e) => setSort(e.target.value as GroupSort)} className="focus-ring rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-xs text-text-primary">
                  <option value="responses">Most responses</option><option value="nps_low">Lowest NPS first</option><option value="nps_high">Highest NPS first</option>
                </select>
              </div>
            </div>

            {groups.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-text-secondary">Nothing to break down yet.</p>
            ) : (
              <ul className="divide-y divide-border">
                {groups.map((g) => (
                  <li key={g.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 py-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto_auto_auto]">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-text-primary">{g.label}</p>
                      <p className="text-xs tabular-nums text-text-secondary">
                        {g.summary.n} response{g.summary.n === 1 ? '' : 's'} · CSAT {g.summary.csat}%
                        {g.lowSample && <span className="ml-1.5 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600" title={`Fewer than ${MIN_SAMPLE} responses — treat as anecdotal`}>Low sample</span>}
                      </p>
                    </div>
                    <p className={`text-right text-xl font-bold tabular-nums md:order-3 ${npsTone(g.summary.nps)}`}>{g.summary.nps}</p>
                    <div className="col-span-2 md:order-2 md:col-span-1"><DistributionBar summary={g.summary} /></div>
                    <div className="hidden md:order-4 md:block"><Sparkline points={g.trend} label={`NPS trend for ${g.label}`} /></div>
                    <div className="md:order-5 md:min-w-[3.5rem] md:text-right"><DeltaBadge delta={g.delta} /></div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <FeedbackCommentFeed records={current} onOpen={setSelected} />

          <p className="flex items-start gap-2 text-xs text-text-secondary"><Info size={14} className="mt-0.5 shrink-0" /> Feedback is collected on a 1–5 scale, so NPS uses the 5-point adaptation: 5 stars = promoter, 4 = passive, 1–3 = detractor. Zone is the job site’s ZIP code. Scores based on fewer than {MIN_SAMPLE} responses are flagged and never ranked first.</p>
        </>
      )}

      <FeedbackJobDrawer record={selected} accountOwnerId={accountOwnerId} onClose={() => setSelected(null)} />
    </div>
  );
}
