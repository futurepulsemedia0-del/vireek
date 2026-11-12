import { useEffect, useState } from 'react';
import { Lock, Printer } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { SkeletonCard } from '@/components/Skeleton';
import { fetchWeeklyScorecard } from '@/lib/pilotScorecardApi';
import { weekStartUtc, type Metric, type Scorecard } from '@/lib/pilotScorecard';

const nf = (v: number | null, d = 0) => (v === null ? 'No data' : v.toLocaleString(undefined, { maximumFractionDigits: d }));
const pct = (v: number | null) => (v === null ? 'No data' : `${(v * 100).toFixed(1)}%`);
const dlt = (m: Metric, fmt: (v: number) => string) => (m.delta === null ? 'no prior week' : `${m.delta > 0 ? '+' : ''}${fmt(m.delta)} vs prior week`);

function Row({ label, value, sub, note }: { label: string; value: string; sub: string; note?: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-4 print:break-inside-avoid">
      <dt className="text-xs font-medium text-text-secondary">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold text-text-primary">{value}</dd>
      <p className="mt-1 text-xs text-text-secondary">{sub}</p>
      {note && <p className="mt-1 text-xs text-text-secondary">{note}</p>}
    </div>
  );
}

export function WeeklyScorecardPage() {
  const { isOwner, permissions, loading, profileLoading } = useAuth();
  const canAccess = isOwner || permissions.can_view_all_jobs;
  const [week, setWeek] = useState(() => weekStartUtc(new Date(Date.now() - 7 * 86_400_000)));
  const [data, setData] = useState<Scorecard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canAccess) return;
    let cancelled = false;
    setData(null); setError(null);
    fetchWeeklyScorecard(week).then((s) => { if (!cancelled) setData(s); }).catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load'); });
    return () => { cancelled = true; };
  }, [week, canAccess]);

  if (loading || profileLoading) return <DashboardLayout activeLabel="Weekly Scorecard"><SkeletonCard rows={4} /></DashboardLayout>;
  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Weekly Scorecard">
        <div className="flex flex-col items-center rounded-2xl border border-dashed border-border px-6 py-20 text-center">
          <Lock size={26} aria-hidden="true" />
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm text-text-secondary">Ask your account owner for the "View All Jobs" permission.</p>
        </div>
      </DashboardLayout>
    );
  }
  const prevWeek = () => setWeek(weekStartUtc(new Date(Date.parse(week) - 7 * 86_400_000)));
  const nextWeek = () => setWeek(weekStartUtc(new Date(Date.parse(week) + 7 * 86_400_000)));

  return (
    <DashboardLayout activeLabel="Weekly Scorecard">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">Weekly scorecard</h1>
          <p className="text-sm text-text-secondary">Week of {week} (Mon–Sun, UTC). Built only from your recorded calls.</p>
        </div>
        <div className="flex gap-2 print:hidden">
          <button type="button" onClick={prevWeek} className="focus-ring rounded-lg border border-border px-3 py-1.5 text-sm">Previous</button>
          <button type="button" onClick={nextWeek} className="focus-ring rounded-lg border border-border px-3 py-1.5 text-sm">Next</button>
          <button type="button" onClick={() => window.print()} className="focus-ring inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white"><Printer size={14} aria-hidden="true" />Save as PDF</button>
        </div>
      </div>
      {error && <p role="alert" className="rounded-xl border border-border p-4 text-sm text-danger">{error}</p>}
      {!error && !data && <SkeletonCard rows={4} />}
      {data && !data.hasData && <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-text-secondary">No calls were recorded this week.</p>}
      {data && data.hasData && (
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Row label="Calls answered" value={nf(data.answeredCalls.value)} sub={`${dlt(data.answeredCalls, (v) => String(v))} · of ${nf(data.totalCalls)} total`} />
          <Row label="Missed calls / voicemail" value={nf(data.missedCalls.value)} sub={dlt(data.missedCalls, (v) => String(v))} />
          <Row label="Bookings" value={nf(data.bookings.value)} sub={`${dlt(data.bookings, (v) => String(v))} · rate ${pct(data.bookingRate.value)}`} />
          <Row label="Average answer speed" value={data.answerSeconds.value === null ? 'No data' : `${nf(data.answerSeconds.value, 1)} s`} sub={`Measured on ${data.answerSpeedSample} call(s)`} note={data.answerSpeedSample === 0 ? 'Answer time is not recorded for these calls yet.' : undefined} />
          <Row label="Owner-rated satisfaction" value={data.satisfaction.value === null ? 'No data' : `${nf(data.satisfaction.value, 2)} / 5`} sub={`${data.ratingSample} rated call(s)`} note={data.satisfactionLowConfidence ? 'Small sample — treat as indicative only.' : 'Covers only calls that were rated, not every caller.'} />
          <Row label="Escalation rate" value={pct(data.escalationRate.value)} sub={dlt(data.escalationRate, (v) => `${(v * 100).toFixed(1)} pts`)} />
          <Row label="Calls reported wrong" value={nf(data.wrongReports)} sub="Flagged with “This call was wrong”" />
          <Row label="Errors" value={data.errorsMeasured ? '—' : 'Not measured'} sub="No verified error signal is recorded yet." />
        </dl>
      )}
    </DashboardLayout>
  );
}
