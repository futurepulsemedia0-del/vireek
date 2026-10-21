import { useEffect, useMemo, useState } from 'react';
import { Timer } from 'lucide-react';
import { fetchOnTimeReport } from '@/lib/arrivalWindowsApi';
import {
  MIN_RELIABLE_SAMPLE,
  percent,
  rateTone,
  summarizeOnTime,
  type OnTimeRow,
  type RateTone,
} from '@/lib/arrivalWindows';

const RANGES = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '12 months' },
] as const;

const TONE_TEXT: Record<RateTone, string> = {
  good: 'text-emerald-500', warn: 'text-amber-500', bad: 'text-red-500', none: 'text-text-secondary',
};
const TONE_BAR: Record<RateTone, string> = {
  good: 'bg-emerald-500', warn: 'bg-amber-500', bad: 'bg-red-500', none: 'bg-border',
};

const fmtRate = (r: number | null) => (r === null ? '—' : `${r}%`);

export function OnTimeRateCard() {
  const [days, setDays] = useState<number>(30);
  const [rows, setRows] = useState<OnTimeRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setFailed(false);
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    fetchOnTimeReport(from, to)
      .then((r) => { if (cancelled) return; if (r === null) setFailed(true); else setRows(r); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [days]);

  const summary = useMemo(() => summarizeOnTime(rows ?? []), [rows]);
  const sorted = useMemo(
    () => [...(rows ?? [])].sort((a, b) => (percent(b.on_time_jobs, b.measured_jobs) ?? -1) - (percent(a.on_time_jobs, a.measured_jobs) ?? -1)),
    [rows],
  );

  return (
    <section className="mb-8 rounded-2xl border border-border bg-bg-secondary p-5" aria-label="On-time arrival rate">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold text-text-primary">
            <Timer size={16} className="text-accent" aria-hidden /> On-time arrival rate
          </h2>
          <p className="mt-1 text-xs text-text-secondary">Share of visits where the technician arrived inside the window the customer was given.</p>
        </div>
        <div role="group" aria-label="Date range" className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r.days}
              type="button"
              aria-pressed={days === r.days}
              onClick={() => setDays(r.days)}
              className={`focus-ring rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                days === r.days ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg-primary text-text-secondary hover:border-accent/40'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {failed ? (
        <p className="mt-4 text-sm text-red-500" role="alert">Could not load the on-time report. Try again shortly.</p>
      ) : rows === null ? (
        <div className="mt-4 h-24 animate-pulse rounded-xl bg-bg-primary" aria-busy="true" />
      ) : rows.length === 0 ? (
        <p className="mt-4 text-sm text-text-secondary">
          No windowed visits in this period yet. Turn on arrival windows in Booking Settings and the rate appears as visits are completed.
        </p>
      ) : (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="On-time rate" value={fmtRate(summary.onTimeRate)} tone={rateTone(summary.onTimeRate)} />
            <Stat label="Kept original window" value={fmtRate(summary.keptOriginalRate)} />
            <Stat label="Late visits" value={`${summary.late}${summary.missed ? ` (${summary.missed} missed)` : ''}`} />
            <Stat label="Avg. minutes late" value={summary.avgMinutesLate === null ? '—' : String(summary.avgMinutesLate)} />
          </dl>

          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead>
                <tr className="text-xs text-text-secondary">
                  <th className="pb-2 font-medium">Technician</th>
                  <th className="pb-2 font-medium">On-time</th>
                  <th className="pb-2 text-right font-medium">Visits</th>
                  <th className="pb-2 text-right font-medium">Late</th>
                  <th className="pb-2 text-right font-medium">Worst (min)</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => {
                  const rate = percent(r.on_time_jobs, r.measured_jobs);
                  const tone = rateTone(rate);
                  return (
                    <tr key={r.technician_id} className="border-t border-border">
                      <td className="py-2.5 pr-3 text-text-primary">{r.technician_name ?? 'Unknown'}</td>
                      <td className="py-2.5 pr-3">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-bg-primary" aria-hidden>
                            <div className={`h-full ${TONE_BAR[tone]}`} style={{ width: `${rate ?? 0}%` }} />
                          </div>
                          <span className={`text-xs font-semibold ${TONE_TEXT[tone]}`}>{fmtRate(rate)}</span>
                          {r.measured_jobs > 0 && r.measured_jobs < MIN_RELIABLE_SAMPLE && (
                            <span className="text-[10px] text-text-secondary">low sample</span>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 text-right text-text-secondary">{r.measured_jobs}</td>
                      <td className="py-2.5 text-right text-text-secondary">{r.late_jobs}</td>
                      <td className="py-2.5 text-right text-text-secondary">{r.max_minutes_late ? Math.round(r.max_minutes_late) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[11px] text-text-secondary">
            Measured against the last window the customer was told. Visits with no recorded arrival are excluded, not guessed.
          </p>
        </>
      )}
    </section>
  );
}

function Stat({ label, value, tone = 'none' }: { label: string; value: string; tone?: RateTone }) {
  return (
    <div className="rounded-xl border border-border bg-bg-primary p-3">
      <dt className="text-[11px] text-text-secondary">{label}</dt>
      <dd className={`mt-1 text-xl font-bold ${tone === 'none' ? 'text-text-primary' : TONE_TEXT[tone]}`}>{value}</dd>
    </div>
  );
}
