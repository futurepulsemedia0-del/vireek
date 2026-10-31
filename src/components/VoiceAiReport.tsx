import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Download, PhoneCall } from 'lucide-react';
import { Skeleton } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { exportToCsv } from '@/lib/csvExport';
import { fetchVoiceReportInput } from '@/lib/voiceMetricsApi';
import { ESTIMATE_LABEL, computeVoiceReport, monthlySummary, type MonthlySummaryRow, type VoiceReportInput } from '@/lib/voiceMetrics';

interface Props {
  /** The Analytics date range (same one every other card uses). */
  start: Date;
  end: Date;
}

const dash = '—';
const money = (cents: number | null) => (cents === null ? dash : (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' }));
const pctText = (n: number | null) => (n === null ? dash : `${n}%`);
const mmss = (s: number | null) => (s === null ? dash : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`);

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg-primary p-3" title={hint}>
      <p className="text-lg font-bold text-text-primary">{value}</p>
      <p className="text-xs text-text-secondary">{label}</p>
    </div>
  );
}

/** Voice AI report for the Analytics page. All figures come from calls / jobs / invoices rows. */
export function VoiceAiReport({ start, end }: Props) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [input, setInput] = useState<VoiceReportInput | null>(null);
  const [attempt, setAttempt] = useState(0);
  const from = start.getTime();
  const to = end.getTime();

  useEffect(() => {
    let live = true;
    setState('loading');
    fetchVoiceReportInput(new Date(from), new Date(to))
      .then((r) => { if (live) { setInput(r); setState('ready'); } })
      .catch(() => { if (live) setState('error'); });
    return () => { live = false; };
  }, [from, to, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const report = useMemo(() => (input ? computeVoiceReport(input) : null), [input]);
  const monthly = useMemo(() => (input ? monthlySummary(input) : null), [input]);

  const exportMonthly = () => {
    if (!monthly) return;
    exportToCsv<MonthlySummaryRow>(
      monthly.rows,
      [
        { header: 'month', accessor: (r) => r.month },
        { header: 'calls_answered', accessor: (r) => r.callsAnswered },
        { header: 'jobs_booked', accessor: (r) => r.jobsBooked },
        { header: 'ESTIMATED_value_cents (estimate, see label)', accessor: (r) => r.estimatedCents },
        { header: 'estimate_label', accessor: () => ESTIMATE_LABEL },
      ],
      `voice-ai-monthly-summary-${new Date(from).toISOString().slice(0, 10)}`,
    );
  };

  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark sm:p-6" aria-labelledby="voice-ai-report-title">
      <div className="flex flex-wrap items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <PhoneCall size={18} aria-hidden="true" />
        </span>
        <div className="flex-1">
          <h3 id="voice-ai-report-title" className="text-sm font-semibold text-text-primary">Voice AI Performance</h3>
          <p className="text-xs text-text-secondary">Counted from your call, job and invoice records for this period</p>
        </div>
        <Button size="sm" variant="secondary" onClick={exportMonthly} disabled={!monthly || monthly.rows.length === 0}>
          <Download size={14} aria-hidden="true" /> Export monthly CSV
        </Button>
      </div>

      {state === 'loading' && (
        <div className="mt-5 space-y-3" aria-busy="true" aria-label="Loading voice AI report">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-3 w-full" />
        </div>
      )}

      {state === 'error' && (
        <div role="alert" className="mt-5 flex flex-wrap items-center gap-3 rounded-xl border border-warning-500/40 bg-warning-500/10 px-4 py-3 text-sm text-text-primary">
          <AlertTriangle size={16} className="shrink-0 text-warning-500" aria-hidden="true" />
          <span className="flex-1">Could not load the voice AI report.</span>
          <Button size="sm" variant="secondary" onClick={retry}>Try again</Button>
        </div>
      )}

      {state === 'ready' && report && monthly && (
        report.totalCalls === 0 ? (
          <p className="mt-6 text-sm text-text-secondary">There are no calls in this period.</p>
        ) : (
          <>
            <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Answered calls" value={String(report.answeredCalls)} hint="Calls that were not missed, voicemail or spam." />
              <Stat label="Missed calls" value={String(report.missedCalls)} hint="Calls with status 'missed' or left as voicemail." />
              <Stat label="Jobs booked" value={String(report.jobsBooked)} hint="Jobs linked to a call in this period." />
              <Stat label="Booking rate" value={pctText(report.bookingRatePct)} hint="Calls that produced a job ÷ answered calls." />
              <Stat label="After-hours share" value={pctText(report.afterHoursSharePct)} hint="Answered calls outside your business hours (needs hours and timezone set)." />
              <Stat label="Transfers to human" value={String(report.transfersToHuman)} hint="Calls transferred or escalated to a person." />
              <Stat label="Avg handle time" value={mmss(report.avgHandleSeconds)} hint={`Average of ${report.handleTimeSamples} answered calls with a recorded duration.`} />
              <Stat label="Paid value of booked jobs" value={money(report.paidCents)} hint="Pre-tax subtotal of paid invoices linked to booked jobs." />
            </div>
            <div className="mt-6 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-text-secondary">
                  <tr><th className="py-1 pr-4">Month</th><th className="py-1 pr-4">Calls answered</th><th className="py-1 pr-4">Jobs booked</th><th className="py-1">Estimated value*</th></tr>
                </thead>
                <tbody className="text-text-primary">
                  {monthly.rows.map((r) => (
                    <tr key={r.month} className="border-t border-border">
                      <td className="py-1 pr-4">{r.month}</td><td className="py-1 pr-4">{r.callsAnswered}</td>
                      <td className="py-1 pr-4">{r.jobsBooked}</td><td className="py-1">{money(r.estimatedCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-text-secondary">* {ESTIMATE_LABEL}{monthly.avgPaidJobCents === null ? ' No paid invoices yet, so no estimate is shown.' : ''}</p>
          </>
        )
      )}
    </section>
  );
}
