import { useMemo } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { KpiStatCard } from '@/components/KpiStatCard';
import {
  DIMENSIONS,
  DIMENSION_LABELS,
  KIND_LABELS,
  FINDING_KINDS,
  MIN_TREND_SAMPLE,
  computeTrend,
  gradeOf,
  toScoredPoint,
  weeklySeries,
  type QualityFinding,
  type QualityOverview,
  type QualityReviewRow,
} from '@/lib/callQuality';
import { DeltaPill, ScoreBadge, Sparkline, btnPrimary } from './qualityUi';

interface Props {
  /** Last ~90 days — the trend always compares the last 14 days against the 60 days before them. */
  allReviews: QualityReviewRow[];
  windowReviews: QualityReviewRow[];
  findings: QualityFinding[];
  overview: QualityOverview | null;
  running: boolean;
  progress: string | null;
  onRunReview: () => void;
}

const avg = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
};

export function QualityOverviewTab({ allReviews, windowReviews, findings, overview, running, progress, onRunReview }: Props) {
  const now = useMemo(() => Date.now(), [allReviews]);
  const trend = useMemo(() => computeTrend(allReviews.map(toScoredPoint), now), [allReviews, now]);
  const weeks = useMemo(() => weeklySeries(allReviews.map(toScoredPoint), now), [allReviews, now]);

  const overall = avg(windowReviews.map((r) => r.overall_score));
  const rating = avg(windowReviews.map((r) => r.feedback_rating));
  const unreviewed = overview ? Math.max(0, overview.coverage.eligible - overview.coverage.reviewed) : 0;
  const byKind = FINDING_KINDS.map((k) => ({ kind: k, n: findings.filter((f) => f.kind === k).length })).filter((x) => x.n > 0);

  return (
    <div className="space-y-6">
      {(unreviewed > 0 || running) && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-accent/30 bg-accent/5 p-4">
          <div>
            <p className="text-sm font-semibold text-text-primary">
              {running ? 'Reviewing calls…' : `${unreviewed} call${unreviewed === 1 ? '' : 's'} in this period ${unreviewed === 1 ? "hasn't" : "haven't"} been reviewed yet`}
            </p>
            <p className="text-xs text-text-secondary">{progress ?? 'Each review checks accuracy, compliance phrases, booking and upsell chances.'}</p>
          </div>
          <button onClick={onRunReview} disabled={running} className={btnPrimary}>
            {running ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
            {running ? 'Reviewing…' : `Review ${unreviewed} call${unreviewed === 1 ? '' : 's'}`}
          </button>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiStatCard label="Quality score" value={overall === null ? '—' : `${Math.round(overall)} (${gradeOf(overall) ?? '—'})`} hint={`${windowReviews.length} reviewed call${windowReviews.length === 1 ? '' : 's'}`} badge={<DeltaPill stat={trend.overall} />} />
        <KpiStatCard label="Open issues" value={findings.length} hint={findings.filter((f) => f.severity === 'critical' || f.severity === 'high').length + ' high or critical'} />
        <KpiStatCard label="Compliance" value={avg(windowReviews.map((r) => r.compliance_score)) ?? '—'} hint="Required phrases said, forbidden ones avoided" badge={<DeltaPill stat={trend.compliance} />} />
        <KpiStatCard label="Customer rating" value={rating === null ? '—' : `${rating} / 5`} hint={`${windowReviews.filter((r) => r.feedback_rating !== null).length} rated calls`} />
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <section className="rounded-xl border border-border bg-bg-secondary p-5 lg:col-span-3" aria-label="Trend versus baseline">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-text-primary">Trend vs baseline</h2>
              <p className="text-xs text-text-secondary">Last 14 days compared with the 60 days before. A change is only shown with at least {MIN_TREND_SAMPLE} reviews in both periods.</p>
            </div>
            <ScoreBadge score={trend.overall.current === null ? null : Math.round(trend.overall.current)} size="lg" />
          </div>
          <Sparkline weeks={weeks} />
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <thead>
                <tr className="text-left text-xs text-text-secondary">
                  <th className="py-2 font-medium">Dimension</th><th className="py-2 font-medium">Now</th><th className="py-2 font-medium">Baseline</th><th className="py-2 font-medium">Change</th>
                </tr>
              </thead>
              <tbody>
                {DIMENSIONS.map((d) => (
                  <tr key={d} className="border-t border-border">
                    <td className="py-2 text-text-primary">{DIMENSION_LABELS[d]}</td>
                    <td className="py-2 tabular-nums">{trend[d].current ?? '—'} <span className="text-xs text-text-secondary/70">({trend[d].nCurrent})</span></td>
                    <td className="py-2 tabular-nums">{trend[d].baseline ?? '—'} <span className="text-xs text-text-secondary/70">({trend[d].nBaseline})</span></td>
                    <td className="py-2"><DeltaPill stat={trend[d]} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-xl border border-border bg-bg-secondary p-5 lg:col-span-2" aria-label="Open issues by type">
          <h2 className="text-base font-semibold text-text-primary">What needs attention</h2>
          {byKind.length === 0 ? (
            <p className="mt-3 text-sm text-text-secondary">No open issues. Reviewed calls look clean.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {byKind.map(({ kind, n }) => (
                <li key={kind} className="flex items-center justify-between rounded-lg bg-bg-primary px-3 py-2 text-sm">
                  <span className="text-text-primary">{KIND_LABELS[kind]}</span>
                  <span className="font-semibold tabular-nums text-text-primary">{n}</span>
                </li>
              ))}
            </ul>
          )}
          {overview && (
            <p className="mt-4 text-xs text-text-secondary">
              Coverage: {overview.coverage.reviewed} of {overview.coverage.eligible} reviewable calls ({overview.coverage.calls} total in this period). Short calls and voicemails are skipped.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
