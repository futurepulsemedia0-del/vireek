import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { AlertTriangle, ClipboardCheck } from 'lucide-react';
import { Skeleton } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { buildBreakdown, type DispositionSummary } from '@/lib/callDisposition';
import { fetchDispositionSummary } from '@/lib/callDispositionApi';

interface Props {
  /** The Analytics date range (same one every other card uses). */
  start: Date;
  end: Date;
}

type LoadState = 'loading' | 'ready' | 'error';

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg-primary p-3" title={hint}>
      <p className="text-lg font-bold text-text-primary">{value}</p>
      <p className="text-xs text-text-secondary">{label}</p>
    </div>
  );
}

const pctText = (n: number | null) => (n === null ? '—' : `${n}%`);

/**
 * Disposition breakdown for the Analytics page. Aggregation happens in SQL
 * (call_disposition_summary), so large accounts are never truncated by the
 * API row cap and the numbers always match the selected date range.
 */
export function CallDispositionBreakdown({ start, end }: Props) {
  const [state, setState] = useState<LoadState>('loading');
  const [summary, setSummary] = useState<DispositionSummary | null>(null);
  const [attempt, setAttempt] = useState(0);

  const from = start.getTime();
  const to = end.getTime();

  useEffect(() => {
    let live = true;
    setState('loading');
    fetchDispositionSummary(new Date(from), new Date(to))
      .then((s) => {
        if (!live) return;
        setSummary(s);
        setState('ready');
      })
      .catch(() => {
        if (live) setState('error');
      });
    return () => {
      live = false;
    };
  }, [from, to, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const data = useMemo(() => (summary ? buildBreakdown(summary) : null), [summary]);

  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark sm:p-6" aria-labelledby="disposition-breakdown-title">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <ClipboardCheck size={18} aria-hidden="true" />
        </span>
        <div>
          <h3 id="disposition-breakdown-title" className="text-sm font-semibold text-text-primary">
            Call Dispositions
          </h3>
          <p className="text-xs text-text-secondary">How each call ended, this period</p>
        </div>
      </div>

      {state === 'loading' && (
        <div className="mt-5 space-y-3" aria-busy="true" aria-label="Loading call dispositions">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-5/6" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      )}

      {state === 'error' && (
        <div role="alert" className="mt-5 flex flex-wrap items-center gap-3 rounded-xl border border-warning-500/40 bg-warning-500/10 px-4 py-3 text-sm text-text-primary">
          <AlertTriangle size={16} className="shrink-0 text-warning-500" aria-hidden="true" />
          <span className="flex-1">Could not load call dispositions.</span>
          <Button size="sm" variant="secondary" onClick={retry}>
            Try again
          </Button>
        </div>
      )}

      {state === 'ready' && data && (
        <>
          {summary && summary.total_calls === 0 ? (
            <p className="mt-6 text-sm text-text-secondary">There are no calls in this period.</p>
          ) : data.tagged === 0 ? (
            <p className="mt-6 text-sm text-text-secondary">
              Tag calls with an outcome to see the breakdown here.{' '}
              <Link to="/dashboard/calls" className="focus-ring font-medium text-accent hover:underline">
                Open call history
              </Link>
            </p>
          ) : (
            <>
              <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat label="Calls tagged" value={`${data.taggedPct}%`} hint="Share of calls in this period that have an outcome." />
                <Stat label="Close rate" value={pctText(data.closeRate)} hint="Booked ÷ (booked + quoted)." />
                <Stat label="Noise" value={pctText(data.noiseRate)} hint="Spam, wrong numbers and vendor calls as a share of tagged calls." />
                <Stat label="Follow-up coverage" value={pctText(data.followUpCoverage)} hint="Share of outcomes that require a follow-up which have a task." />
              </div>

              <ul className="mt-5 space-y-3" data-testid="disposition-rows">
                {data.rows.map((row, i) => (
                  <li key={row.outcome}>
                    <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                      <span className="font-medium text-text-primary">{row.label}</span>
                      <span className="text-text-secondary">
                        {row.count} · {row.pct}%
                        {row.followUp !== 'none' && row.withTask > 0 ? ` · ${row.withTask} task${row.withTask === 1 ? '' : 's'}` : ''}
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-tertiary" role="img" aria-label={`${row.label}: ${row.count} calls, ${row.pct}%`}>
                      <motion.div
                        className={`h-full rounded-full ${row.barClass}`}
                        initial={{ width: 0 }}
                        animate={{ width: `${row.pct}%` }}
                        transition={{ duration: 0.5, delay: i * 0.05 }}
                      />
                    </div>
                  </li>
                ))}
              </ul>

              {data.aiAgreement !== null && (
                <p className="mt-4 text-xs text-text-secondary">
                  Staff agreed with the AI on {data.aiAgreement}% of {data.aiReviewed} reviewed {data.aiReviewed === 1 ? 'call' : 'calls'}.
                </p>
              )}
            </>
          )}

          {data.untagged > 0 && summary && summary.total_calls > 0 && (
            <p className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-warning-500/30 bg-warning-500/5 px-3 py-2 text-xs text-text-primary" data-testid="untagged-note">
              <AlertTriangle size={14} className="shrink-0 text-warning-500" aria-hidden="true" />
              <span>
                {data.untagged} {data.untagged === 1 ? 'call still needs' : 'calls still need'} an outcome.
              </span>
              <Link to="/dashboard/calls" className="focus-ring font-medium text-accent hover:underline">
                Review calls
              </Link>
            </p>
          )}
        </>
      )}
    </section>
  );
}
