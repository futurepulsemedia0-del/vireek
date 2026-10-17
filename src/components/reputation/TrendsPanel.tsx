import { useMemo } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus, TrendingUp } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { Stars } from '@/components/reputation/Stars';
import { PLATFORMS, PLATFORM_LABEL, computeTrends, type Overview, type Trends } from '@/lib/reputation';

const fmt = (n: number | null, digits = 1) => (n === null ? '—' : n.toFixed(digits));
const monthLabel = (key: string) => new Date(`${key}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' });

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card">
      <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${tone === 'bad' ? 'text-danger' : tone === 'good' ? 'text-success' : 'text-text-primary'}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

function TrendChart({ trends }: { trends: Trends }) {
  const W = 640;
  const H = 220;
  const pad = { l: 34, r: 12, t: 12, b: 28 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const n = trends.monthly.length;
  const x = (i: number) => pad.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => pad.t + ih - ((v - 1) / 4) * ih;

  // Break the line across months with no reviews instead of inventing a value.
  const segments: string[] = [];
  let current: string[] = [];
  trends.monthly.forEach((m, i) => {
    if (m.average === null) {
      if (current.length) segments.push(current.join(' '));
      current = [];
    } else {
      current.push(`${current.length ? 'L' : 'M'}${x(i).toFixed(1)},${y(m.average).toFixed(1)}`);
    }
  });
  if (current.length) segments.push(current.join(' '));

  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full text-accent" role="img" aria-label={`Average rating by month over the last ${n} months`}>
        {[1, 2, 3, 4, 5].map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="stroke-border" strokeWidth={1} strokeDasharray={v === 1 || v === 5 ? undefined : '3 4'} />
            <text x={pad.l - 8} y={y(v) + 4} textAnchor="end" className="fill-text-secondary text-[11px]">{v}</text>
          </g>
        ))}
        {segments.map((d, i) => <path key={i} d={d} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />)}
        {trends.monthly.map((m, i) =>
          m.average === null ? null : (
            <circle key={m.month} cx={x(i)} cy={y(m.average)} r={4} fill="currentColor" className="stroke-bg-secondary" strokeWidth={2}>
              <title>{`${monthLabel(m.month)} ${m.month.slice(0, 4)}: ${m.average.toFixed(2)} average from ${m.count} review${m.count === 1 ? '' : 's'}`}</title>
            </circle>
          ),
        )}
        {trends.monthly.map((m, i) => (i % 2 === (n - 1) % 2 ? <text key={m.month} x={x(i)} y={H - 8} textAnchor="middle" className="fill-text-secondary text-[11px]">{monthLabel(m.month)}</text> : null))}
      </svg>
      <table className="sr-only">
        <caption>Average rating by month</caption>
        <thead><tr><th>Month</th><th>Reviews</th><th>Average</th></tr></thead>
        <tbody>{trends.monthly.map((m) => <tr key={m.month}><td>{m.month}</td><td>{m.count}</td><td>{m.average ?? 'no reviews'}</td></tr>)}</tbody>
      </table>
    </figure>
  );
}

export function TrendsPanel({ data }: { data: Overview }) {
  const trends = useMemo(() => computeTrends(data.reviews, new Date()), [data.reviews]);

  if (trends.total === 0) {
    return <EmptyState icon={TrendingUp} title="No data to chart yet" description="Rating trends appear once you have reviews — synced from a source or logged by hand." />;
  }

  const maxBucket = Math.max(...trends.distribution, 1);
  const deltaIcon = trends.delta === null ? Minus : trends.delta >= 0 ? ArrowUpRight : ArrowDownRight;
  const DeltaIcon = deltaIcon;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Average rating" value={fmt(trends.average, 2)} hint={`${trends.total} reviews`} />
        <Kpi
          label="Last 30 days"
          value={fmt(trends.last30.average, 2)}
          hint={trends.delta === null ? `${trends.last30.count} reviews · no prior period` : `${trends.delta >= 0 ? '+' : ''}${trends.delta.toFixed(2)} vs previous 30 days`}
          tone={trends.delta === null ? undefined : trends.delta >= 0 ? 'good' : 'bad'}
        />
        <Kpi label="Response rate" value={trends.responseRate === null ? '—' : `${trends.responseRate}%`} hint={`${trends.unanswered} awaiting a reply`} tone={trends.responseRate !== null && trends.responseRate < 50 ? 'bad' : undefined} />
        <Kpi label="Needs attention" value={String(trends.needsAttention)} hint="Unanswered, 3 stars or below" tone={trends.needsAttention > 0 ? 'bad' : 'good'} />
      </div>

      <section className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card sm:p-6" aria-labelledby="trend-title">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="trend-title" className="text-lg font-semibold text-text-primary">Average rating by month</h2>
          <span className="inline-flex items-center gap-1 text-xs text-text-secondary"><DeltaIcon size={14} aria-hidden="true" /> Months with no reviews are left blank</span>
        </div>
        <TrendChart trends={trends} />
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <section className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card sm:p-6" aria-labelledby="dist-title">
          <h2 id="dist-title" className="mb-4 text-lg font-semibold text-text-primary">Rating distribution</h2>
          <ul className="space-y-2.5">
            {[5, 4, 3, 2, 1].map((s) => {
              const count = trends.distribution[s - 1];
              return (
                <li key={s} className="flex items-center gap-3 text-sm">
                  <span className="w-12 shrink-0 text-text-secondary">{s} star{s === 1 ? '' : 's'}</span>
                  <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-bg-tertiary">
                    <span className={`block h-full rounded-full ${s >= 4 ? 'bg-success' : s === 3 ? 'bg-warning-500' : 'bg-danger'}`} style={{ width: `${(count / maxBucket) * 100}%` }} />
                  </span>
                  <span className="w-8 shrink-0 text-right tabular-nums text-text-primary">{count}</span>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="rounded-2xl border border-border bg-bg-secondary p-4 shadow-card sm:p-6" aria-labelledby="plat-title">
          <h2 id="plat-title" className="mb-4 text-lg font-semibold text-text-primary">By platform</h2>
          <ul className="divide-y divide-border/70">
            {PLATFORMS.map((p) => {
              const s = trends.byPlatform[p];
              return (
                <li key={p} className="flex items-center justify-between gap-3 py-3 text-sm">
                  <span className="font-medium text-text-primary">{PLATFORM_LABEL[p]}</span>
                  {s.count === 0 ? (
                    <span className="text-text-secondary">No reviews</span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <Stars rating={Math.round(s.average ?? 0)} />
                      <span className="tabular-nums text-text-primary">{fmt(s.average, 2)}</span>
                      <span className="text-xs text-text-secondary">({s.count})</span>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      </div>
      {data.truncated && <p className="text-xs text-text-secondary">Trends are based on your latest {data.reviews.length} of {data.total} reviews.</p>}
    </div>
  );
}
