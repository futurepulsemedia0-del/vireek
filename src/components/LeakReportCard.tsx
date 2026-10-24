import { Link } from 'react-router-dom';
import { ArrowRight, PhoneMissed, RefreshCw } from 'lucide-react';
import { useLeakReport } from '@/hooks/useLeakReport';
import { formatUsd } from '../../supabase/functions/_shared/leak-report/core';

const card = 'rounded-2xl border border-border bg-bg-secondary p-5';

export function LeakReportCard() {
  const { state, reload } = useLeakReport(60_000);

  if (state.status === 'forbidden') return null;

  if (state.status === 'loading') {
    return <div role="status" aria-label="Loading Leak Report" className="h-40 w-full animate-pulse rounded-2xl bg-bg-secondary" />;
  }

  if (state.status === 'error') {
    return (
      <div role="alert" className={`${card} flex items-center justify-between gap-3`}>
        <p className="text-sm text-text-secondary">{state.message}</p>
        <button type="button" onClick={() => void reload()} className="focus-ring inline-flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-sm text-text-secondary hover:text-text-primary">
          <RefreshCw size={14} /> Try again
        </button>
      </div>
    );
  }

  const { data } = state;
  const r = data.report;

  if (data.phase === 'off') {
    return (
      <section className={card} aria-labelledby="leak-card-title">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-danger/10 text-danger"><PhoneMissed size={20} /></span>
          <div className="min-w-0 flex-1">
            <h2 id="leak-card-title" className="text-base font-semibold text-text-primary">How much are missed calls costing you?</h2>
            <p className="mt-1 text-sm text-text-secondary">Run a 7-day Leak Report. Nothing changes on your phone setup.</p>
            <Link to="/dashboard/leak-report" className="focus-ring mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-accent">
              Start the report <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      </section>
    );
  }

  if (data.phase === 'waiting') {
    return (
      <section className={card} aria-labelledby="leak-card-title">
        <h2 id="leak-card-title" className="text-base font-semibold text-text-primary">Leak Report: waiting for your first calls</h2>
        <p className="mt-1 text-sm text-text-secondary">Connect a call source or import your call log to see results.</p>
        <Link to="/dashboard/leak-report" className="focus-ring mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-accent">
          Connect calls <ArrowRight size={14} />
        </Link>
      </section>
    );
  }

  const headline =
    r.estimatedLostCents !== null
      ? `${formatUsd(r.estimatedLostCents)} estimated lost`
      : `${r.lostCallers} caller${r.lostCallers === 1 ? '' : 's'} never reached`;
  const progress = Math.round((data.dayNumber / data.settings.window_days) * 100);

  return (
    <section className={card} aria-labelledby="leak-card-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">
            Leak Report · {data.phase === 'complete' ? 'Final' : `Day ${data.dayNumber} of ${data.settings.window_days}`}
          </p>
          <h2 id="leak-card-title" className="mt-1 text-2xl font-semibold text-text-primary">{headline}</h2>
        </div>
        <Link to="/dashboard/leak-report" className="focus-ring inline-flex items-center gap-1.5 text-sm font-semibold text-accent">
          View full report <ArrowRight size={14} />
        </Link>
      </div>
      <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
        <div><dt className="text-text-secondary">Answer rate</dt><dd className="text-lg font-semibold text-text-primary">{r.answerRate === null ? '-' : `${r.answerRate}%`}</dd></div>
        <div><dt className="text-text-secondary">Missed</dt><dd className="text-lg font-semibold text-text-primary">{r.missed}</dd></div>
        <div><dt className="text-text-secondary">After-hours missed</dt><dd className="text-lg font-semibold text-text-primary">{r.afterHoursMissed}</dd></div>
      </dl>
      {data.phase === 'collecting' && (
        <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-bg-tertiary" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Report progress">
          <div className="h-full bg-accent" style={{ width: `${progress}%` }} />
        </div>
      )}
    </section>
  );
}
