import { useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Briefcase, Clock, DollarSign, Gauge, Lock, Minus, Save } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { formatCents as formatPayCents } from '@/lib/payroll';
import type { Job } from '@/lib/supabase';
import type { TechnicianMetrics, TechnicianScorecard } from '@/lib/technicianPerformance';
import {
  filterJobHistory,
  metricDelta,
  scoreTone,
  type EarningsSummary,
  type HoursSummary,
  type JobFilter,
  type PayslipView,
} from '@/lib/technicianDetail';
import { SectionCard, fmtDate, sectionCard } from '@/components/team/TechnicianProfileSections';

const TONE = { good: 'text-success-500', warn: 'text-warning-500', bad: 'text-danger-500', none: 'text-text-primary' } as const;

function Delta({ value, unit = '', goodWhen = 'up' }: { value: number | null; unit?: string; goodWhen?: 'up' | 'down' }) {
  if (value === null) return <span className="text-[11px] text-text-secondary">no prior data</span>;
  if (value === 0) return <span className="flex items-center gap-0.5 text-[11px] text-text-secondary"><Minus size={11} /> no change</span>;
  const up = value > 0;
  const good = goodWhen === 'up' ? up : !up;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`flex items-center gap-0.5 text-[11px] font-medium ${good ? 'text-success-500' : 'text-danger-500'}`}>
      <Icon size={11} /> {Math.abs(value)}{unit} vs prev
    </span>
  );
}

function Tile({ label, value, tone = 'none', delta }: { label: string; value: string; tone?: keyof typeof TONE; delta?: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-bg-tertiary p-3">
      <p className="text-[11px] text-text-secondary">{label}</p>
      <p className={`mt-0.5 text-lg font-semibold tabular-nums ${TONE[tone]}`}>{value}</p>
      {delta}
    </div>
  );
}

const pct = (n: number | null) => (n === null ? '—' : `${n}%`);

// ─── Scorecard ─────────────────────────────────────────────────────────────
export function ScorecardSection({
  current,
  previous,
  snapshots,
  snapshotsError,
  canSave,
  saving,
  onSave,
}: {
  current: TechnicianMetrics;
  previous: TechnicianMetrics;
  snapshots: TechnicianScorecard[];
  snapshotsError?: string;
  canSave: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  const empty = current.jobsCompleted === 0;
  return (
    <SectionCard
      title="Scorecard"
      icon={Gauge}
      aside={canSave ? <Button size="sm" variant="secondary" onClick={onSave} disabled={saving || empty}><Save size={14} /> {saving ? 'Saving…' : 'Save snapshot'}</Button> : undefined}
    >
      {empty ? (
        <p className="text-sm text-text-secondary">No completed jobs in this period, so there’s nothing to score yet. Try a longer period.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
            <Tile label="Jobs completed" value={String(current.jobsCompleted)} delta={<Delta value={metricDelta(current.jobsCompleted, previous.jobsCompleted)} />} />
            <Tile label="First-time fix" value={pct(current.firstTimeFixRate)} tone={scoreTone('ftf', current.firstTimeFixRate)} delta={<Delta value={metricDelta(current.firstTimeFixRate, previous.firstTimeFixRate)} unit=" pts" />} />
            <Tile label="Callback rate" value={pct(current.callbackRate)} tone={scoreTone('callback', current.callbackRate)} delta={<Delta value={metricDelta(current.callbackRate, previous.callbackRate)} unit=" pts" goodWhen="down" />} />
            <Tile label={`CSAT (${current.csatResponses})`} value={current.csatAvg === null ? '—' : `${current.csatAvg.toFixed(2)} / 5`} tone={scoreTone('csat', current.csatAvg)} delta={<Delta value={metricDelta(current.csatAvg, previous.csatAvg)} />} />
            <Tile label="Avg job time" value={current.avgJobDurationMinutes === null ? '—' : `${Math.round(current.avgJobDurationMinutes)} min`} delta={<Delta value={metricDelta(current.avgJobDurationMinutes, previous.avgJobDurationMinutes)} unit=" min" goodWhen="down" />} />
            <Tile label="Revenue" value={formatPayCents(current.revenueCents)} delta={<Delta value={metricDelta(current.revenueCents / 100, previous.revenueCents / 100)} unit="" />} />
            <Tile label="Utilization" value={pct(current.utilizationRate)} tone={scoreTone('utilization', current.utilizationRate)} />
          </div>

          {current.aiCoachingNotes.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-medium text-text-secondary">Coaching notes</p>
              <ul className="mt-1.5 space-y-1.5">
                {current.aiCoachingNotes.map((n, i) => (
                  <li key={i} className="rounded-lg bg-bg-tertiary px-3 py-2 text-sm text-text-primary">{n.tip}<span className="block text-xs text-text-secondary">{n.basis}</span></li>
                ))}
              </ul>
            </div>
          )}
          {current.trainingGaps.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-medium text-text-secondary">Training gaps</p>
              <ul className="mt-1.5 space-y-1.5">
                {current.trainingGaps.map((g, i) => (
                  <li key={i} className="flex items-start justify-between gap-3 text-sm">
                    <span className="min-w-0 break-words text-text-primary">{g.serviceType} <span className="text-xs text-text-secondary">— {g.reason}</span></span>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${g.severity === 'high' ? 'bg-danger-500/15 text-danger-500' : g.severity === 'medium' ? 'bg-warning-500/15 text-warning-500' : 'bg-bg-tertiary text-text-secondary'}`}>{g.severity}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      <div className="mt-5 border-t border-border pt-3">
        <p className="text-xs font-medium text-text-secondary">Saved snapshots</p>
        {snapshotsError ? (
          <p role="alert" className="mt-1.5 text-xs text-danger-500">Couldn’t load saved snapshots.</p>
        ) : snapshots.length === 0 ? (
          <p className="mt-1.5 text-xs text-text-secondary">None saved. Save one to keep this period’s numbers for later comparison.</p>
        ) : (
          <ul className="mt-1.5 divide-y divide-border">
            {snapshots.slice(0, 6).map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
                <span className="text-text-primary">{fmtDate(s.period_start)} – {fmtDate(s.period_end)}</span>
                <span className="tabular-nums text-text-secondary">{s.jobs_completed} jobs · FTF {pct(s.first_time_fix_rate)} · CSAT {s.csat_avg ?? '—'}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SectionCard>
  );
}

// ─── Hours & earnings (payroll-gated) ──────────────────────────────────────
function Locked({ title, icon, message }: { title: string; icon: typeof Clock; message: string }) {
  return (
    <SectionCard title={title} icon={icon}>
      <p className="flex items-start gap-2 text-sm text-text-secondary"><Lock size={15} className="mt-0.5 shrink-0" /> {message}</p>
    </SectionCard>
  );
}

const LOCK_MESSAGE = 'Pay and hours are visible to people with billing access. Ask the account owner to enable “View billing”.';
const NO_EMPLOYEE = 'This team member isn’t set up in Payroll yet, so there are no hours or earnings to show. Add them as an employee in Payroll to start tracking.';

export function HoursSection({
  allowed, linked, error, onRetry, summary, periodLabel,
}: { allowed: boolean; linked: boolean; error?: string; onRetry?: () => void; summary: HoursSummary; periodLabel: string }) {
  if (!allowed) return <Locked title="Hours" icon={Clock} message={LOCK_MESSAGE} />;
  const max = Math.max(1, ...summary.weeks.map((w) => w.hours));
  return (
    <SectionCard title="Hours" icon={Clock} error={error} onRetry={onRetry}>
      {!linked ? (
        <p className="text-sm text-text-secondary">{NO_EMPLOYEE}</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2.5">
            <Tile label={`Total · ${periodLabel}`} value={`${summary.total}h`} />
            <Tile label="Overtime" value={`${summary.overtime}h`} tone={summary.overtime > 0 ? 'warn' : 'none'} />
            <Tile label="Awaiting approval" value={`${summary.pendingHours}h`} />
          </div>
          <p className="mt-4 text-xs font-medium text-text-secondary">Last 8 weeks</p>
          <ul className="mt-2 flex h-24 items-end gap-1.5" aria-label="Weekly hours">
            {summary.weeks.map((w) => (
              <li key={w.weekStart} className="flex h-full flex-1 flex-col items-center justify-end gap-1" title={`Week of ${w.weekStart}: ${w.hours}h`}>
                <span className="text-[10px] tabular-nums text-text-secondary">{w.hours || ''}</span>
                <span className="w-full rounded-t bg-accent/70" style={{ height: `${Math.max(w.hours > 0 ? 4 : 1, (w.hours / max) * 100)}%` }} />
                <span className="text-[9px] text-text-secondary">{new Date(`${w.weekStart}T00:00:00`).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}</span>
              </li>
            ))}
          </ul>
          {summary.entries === 0 && <p className="mt-3 text-xs text-text-secondary">No timesheet entries in this period.</p>}
        </>
      )}
    </SectionCard>
  );
}

export function EarningsSection({
  allowed, linked, error, onRetry, summary, payslips, hourlyCostCents, periodLabel,
}: { allowed: boolean; linked: boolean; error?: string; onRetry?: () => void; summary: EarningsSummary; payslips: PayslipView[]; hourlyCostCents: number | null; periodLabel: string }) {
  if (!allowed) return <Locked title="Earnings" icon={DollarSign} message={LOCK_MESSAGE} />;
  const shown = payslips.filter((p) => p.run.status === 'approved' || p.run.status === 'paid').slice(0, 6);
  return (
    <SectionCard title="Earnings" icon={DollarSign} error={error} onRetry={onRetry}>
      {!linked ? (
        <p className="text-sm text-text-secondary">{NO_EMPLOYEE}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
            <Tile label={`Gross · ${periodLabel}`} value={formatPayCents(summary.periodGrossCents)} />
            <Tile label={`Net · ${periodLabel}`} value={formatPayCents(summary.periodNetCents)} />
            <Tile label="Gross year-to-date" value={formatPayCents(summary.ytdGrossCents)} />
            <Tile label="Commission not yet paid" value={formatPayCents(summary.commissionUnpaidCents)} tone={summary.commissionUnpaidCents > 0 ? 'warn' : 'none'} />
          </div>
          {hourlyCostCents !== null && <p className="mt-3 text-xs text-text-secondary">Internal cost rate: {formatPayCents(hourlyCostCents)}/hr (never shown to customers).</p>}
          <p className="mt-4 text-xs font-medium text-text-secondary">Recent pay runs</p>
          {shown.length === 0 ? (
            <p className="mt-1.5 text-sm text-text-secondary">This person isn’t on any approved pay run so far.</p>
          ) : (
            <ul className="mt-1.5 divide-y divide-border">
              {shown.map(({ item, run }) => (
                <li key={item.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm text-text-primary">{fmtDate(run.pay_date)}</p>
                    <p className="text-xs text-text-secondary">{fmtDate(run.pay_period_start)} – {fmtDate(run.pay_period_end)} · {run.status}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold tabular-nums text-text-primary">{formatPayCents(item.net_pay_cents)}</p>
                    <p className="text-xs tabular-nums text-text-secondary">gross {formatPayCents(item.gross_pay_cents)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </SectionCard>
  );
}

// ─── Job history ───────────────────────────────────────────────────────────
const FILTERS: { key: JobFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'completed', label: 'Completed' },
  { key: 'cancelled', label: 'Cancelled' },
];
const STATUS_STYLE: Record<Job['job_status'], string> = {
  scheduled: 'bg-cta/15 text-cta',
  en_route: 'bg-warning-500/15 text-warning-500',
  in_progress: 'bg-warning-500/15 text-warning-500',
  completed: 'bg-success-500/15 text-success-500',
  cancelled: 'bg-bg-tertiary text-text-secondary',
  no_show: 'bg-danger-500/15 text-danger-500',
};
const PAGE = 15;

export function JobHistorySection({ jobs, technicianId, error, onRetry }: { jobs: Job[]; technicianId: string; error?: string; onRetry?: () => void }) {
  const [filter, setFilter] = useState<JobFilter>('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const rows = useMemo(() => filterJobHistory(jobs, technicianId, filter, query), [jobs, technicianId, filter, query]);
  const total = jobs.filter((j) => j.assigned_technician_id === technicianId).length;

  return (
    <SectionCard title="Job history" icon={Briefcase} error={error} onRetry={onRetry} aside={<span className="text-xs text-text-secondary">{total} total</span>}>
      {total === 0 ? (
        <p className="text-sm text-text-secondary">No jobs have been assigned to this technician.</p>
      ) : (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div role="group" aria-label="Filter jobs" className="flex flex-wrap gap-1.5">
              {FILTERS.map((f) => (
                <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => { setFilter(f.key); setLimit(PAGE); }}
                  className={`focus-ring rounded-full px-3 py-1 text-xs font-medium ${filter === f.key ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}>{f.label}</button>
              ))}
            </div>
            <div className="sm:w-56">
              <Input aria-label="Search jobs" placeholder="Search customer, service, address" value={query} onChange={(e) => { setQuery(e.target.value); setLimit(PAGE); }} className="!py-2 !text-sm" />
            </div>
          </div>
          {rows.length === 0 ? (
            <p className="mt-4 text-sm text-text-secondary">Nothing matches this filter.</p>
          ) : (
            <ul className="mt-3 divide-y divide-border">
              {rows.slice(0, limit).map((j) => (
                <li key={j.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 py-2.5">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium text-text-primary">{j.customer_name}{j.is_rework && <span className="ml-1.5 rounded bg-warning-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-warning-500">REWORK</span>}</p>
                    <p className="break-words text-xs text-text-secondary">{[j.service_type, j.address].filter(Boolean).join(' · ') || '—'}</p>
                    <p className="text-xs text-text-secondary">{j.scheduled_datetime ? new Date(j.scheduled_datetime).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Unscheduled'}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {j.invoice_amount ? <span className="text-sm tabular-nums text-text-primary">${j.invoice_amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span> : null}
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${STATUS_STYLE[j.job_status]}`}>{j.job_status.replace('_', ' ')}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {rows.length > limit && (
            <div className="mt-3 text-center"><Button size="sm" variant="ghost" onClick={() => setLimit((l) => l + PAGE)}>Show more ({rows.length - limit} left)</Button></div>
          )}
        </>
      )}
    </SectionCard>
  );
}

export { sectionCard };
