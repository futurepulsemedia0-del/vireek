import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, CheckCircle2, Clock, Coffee, CloudOff, History, Loader2, LogIn, LogOut, MapPin, RefreshCw, Repeat, UserX, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { useTimeClock } from '@/hooks/useTimeClock';
import { clockErrorCopy, fixQuality, formatClock, formatHoursMinutes, GPS_ERROR_COPY, jobBreakdown, localDateIso, netMs, breakMs, weekMinutes } from '@/lib/timeClock';
import type { TechnicianJob } from '@/lib/technicianOS';

const selectClass =
  'focus-ring min-h-[52px] w-full rounded-xl border border-border bg-bg-primary px-3 text-base text-text-primary focus-visible:border-accent disabled:opacity-50';

const jobLabel = (j: TechnicianJob) => `${j.customer_name}${j.service_type ? ` · ${j.service_type}` : ''}`;
const timeOf = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const dayOf = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

export function TechnicianTimesheetPage() {
  const tc = useTimeClock();
  const [pickedJob, setPickedJob] = useState('');
  const [switchTo, setSwitchTo] = useState('');

  const jobsById = useMemo(() => new Map(tc.jobs.map((j) => [j.id, j])), [tc.jobs]);
  const nameOf = (id: string | null) => (id ? (jobsById.get(id) ? jobLabel(jobsById.get(id) as TechnicianJob) : 'Job') : 'General work');

  const net = netMs(tc.view, tc.now);
  const onBreak = tc.status === 'on_break';
  const working = tc.status === 'working';
  const today = localDateIso(tc.now);
  const weekMin = weekMinutes(tc.recent, today) + (tc.view ? Math.round(net / 60000) : 0);
  const breakdown = jobBreakdown(tc.view, tc.now);
  const otherJobs = tc.jobs.filter((j) => j.id !== tc.jobId);
  const busy = tc.busy !== null;
  const unlinked = tc.profile && !tc.profile.employeeId;

  return (
    <div className="min-h-screen bg-bg-primary pb-10">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-bg-primary/95 px-4 py-4 backdrop-blur">
        <Link to="/tech" aria-label="Back to today" className="focus-ring -ml-2 flex h-10 w-10 items-center justify-center rounded-xl text-text-secondary">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold text-text-primary">Timesheet</h1>
          <p className="truncate text-sm text-text-secondary">{tc.profile?.fullName ?? 'Clock in and out'}</p>
        </div>
      </header>

      <main className="mx-auto max-w-lg space-y-4 px-4 py-4">
        {(!tc.online || tc.pending > 0 || tc.stale) && (
          <div role="status" className="flex items-center gap-3 rounded-xl border border-warning-500/40 bg-warning-500/10 p-3 text-sm text-text-primary">
            {tc.syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudOff className="h-4 w-4 flex-shrink-0" />}
            <span className="flex-1">
              {!tc.online ? 'You are offline. ' : ''}
              {tc.pending > 0 ? `${tc.pending} entr${tc.pending === 1 ? 'y' : 'ies'} saved on this phone and waiting to sync.` : 'Showing saved data.'}
            </span>
            {tc.online && (
              <button type="button" onClick={tc.syncNow} disabled={tc.syncing} className="focus-ring rounded-lg p-2 text-accent disabled:opacity-50" aria-label="Sync now">
                <RefreshCw className="h-4 w-4" />
              </button>
            )}
          </div>
        )}

        {tc.persistFailed && (
          <div role="alert" className="rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm text-text-primary">
            This browser cannot store entries offline (private mode or full storage). Stay online until entries sync.
          </div>
        )}

        {tc.rejected.map((r) => (
          <div key={r.event.id} role="alert" className="flex items-start gap-3 rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm text-text-primary">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-danger" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {r.event.type.replace('_', ' ')} at {timeOf(Date.parse(r.event.at))} was not saved
              </p>
              <p className="text-text-secondary">{clockErrorCopy(r.code)}</p>
            </div>
            <button type="button" onClick={() => tc.dismiss(r.event.id)} className="focus-ring rounded-lg p-1 text-text-secondary" aria-label="Dismiss">
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}

        {tc.loading && !tc.profile && (
          <div className="space-y-3" aria-busy="true" aria-label="Loading timesheet">
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}

        {!tc.loading && tc.loadError && !tc.profile && (
          <EmptyState icon={CloudOff} title="Could not load your time clock" description={tc.loadError} action={{ label: 'Try again', onClick: tc.retry }} />
        )}

        {unlinked && (
          <EmptyState
            icon={UserX}
            title="Not linked to payroll yet"
            description="Ask your manager to link your account to your employee record in Payroll before you clock in."
          />
        )}

        {tc.profile && !unlinked && (
          <>
            <Card className="p-5">
              <div className="flex items-center justify-between text-sm">
                <span className={`inline-flex items-center gap-2 font-medium ${working ? 'text-success-500' : onBreak ? 'text-warning-500' : 'text-text-secondary'}`}>
                  <span className={`h-2.5 w-2.5 rounded-full ${working ? 'bg-success-500' : onBreak ? 'bg-warning-500' : 'bg-border'}`} />
                  {working ? 'Working' : onBreak ? 'On break' : 'Clocked out'}
                </span>
                {tc.view && <span className="text-text-secondary">since {timeOf(tc.view.clockInAt)}</span>}
              </div>
              <p className="mt-3 text-center font-mono text-5xl font-semibold tabular-nums text-text-primary" aria-live="off">
                {formatClock(net)}
              </p>
              <p className="mt-1 text-center text-sm text-text-secondary">
                {tc.view ? (working || onBreak ? nameOf(tc.jobId) : '') : 'Ready when you are'}
                {tc.view && breakMs(tc.view, tc.now) > 0 ? ` · ${formatHoursMinutes(breakMs(tc.view, tc.now) / 60000)} break` : ''}
              </p>

              <div className="mt-5 space-y-3">
                {!tc.view && (
                  <>
                    <label className="block text-sm text-text-secondary" htmlFor="tc-job">
                      Job (optional)
                    </label>
                    <select id="tc-job" className={selectClass} value={pickedJob} onChange={(e) => setPickedJob(e.target.value)} disabled={busy}>
                      <option value="">General work / no job</option>
                      {tc.jobs.map((j) => (
                        <option key={j.id} value={j.id}>
                          {jobLabel(j)}
                        </option>
                      ))}
                    </select>
                    <Button size="lg" className="w-full" disabled={busy} onClick={() => void tc.clockIn(pickedJob || null)}>
                      {tc.busy === 'clock_in' ? <Loader2 className="h-5 w-5 animate-spin" /> : <LogIn className="h-5 w-5" />}
                      {tc.busy === 'clock_in' ? 'Getting location…' : 'Clock in'}
                    </Button>
                  </>
                )}

                {tc.view && (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      {onBreak ? (
                        <Button size="lg" className="col-span-2" disabled={busy} onClick={() => void tc.endBreak()}>
                          <Coffee className="h-5 w-5" /> End break
                        </Button>
                      ) : (
                        <Button size="lg" variant="secondary" disabled={busy} onClick={() => void tc.startBreak()}>
                          <Coffee className="h-5 w-5" /> Start break
                        </Button>
                      )}
                      {!onBreak && (
                        <Button size="lg" variant="secondary" disabled={busy} onClick={() => void tc.clockOut()}>
                          {tc.busy === 'clock_out' ? <Loader2 className="h-5 w-5 animate-spin" /> : <LogOut className="h-5 w-5" />}
                          Clock out
                        </Button>
                      )}
                    </div>
                    {onBreak && (
                      <Button size="lg" variant="ghost" className="w-full" disabled={busy} onClick={() => void tc.clockOut()}>
                        <LogOut className="h-5 w-5" /> Clock out
                      </Button>
                    )}
                    {working && otherJobs.length > 0 && (
                      <div className="flex gap-2">
                        <select aria-label="Switch to job" className={selectClass} value={switchTo} onChange={(e) => setSwitchTo(e.target.value)} disabled={busy}>
                          <option value="">Switch to…</option>
                          {otherJobs.map((j) => (
                            <option key={j.id} value={j.id}>
                              {jobLabel(j)}
                            </option>
                          ))}
                        </select>
                        <Button
                          size="lg"
                          variant="secondary"
                          disabled={busy || !switchTo}
                          aria-label="Switch job"
                          onClick={() => {
                            void tc.switchJob(switchTo);
                            setSwitchTo('');
                          }}
                        >
                          <Repeat className="h-5 w-5" />
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </div>

              {tc.lastFix && (
                <p className="mt-4 flex items-center gap-2 text-xs text-text-secondary">
                  <MapPin className="h-3.5 w-3.5 flex-shrink-0" />
                  {tc.lastFix.ok ? `Location saved (${fixQuality(tc.lastFix.accuracy)} accuracy)` : `${GPS_ERROR_COPY[tc.lastFix.error]} Your time was still recorded.`}
                </p>
              )}
            </Card>

            <Card className="p-5">
              <div className="flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                  <Clock className="h-4 w-4" /> This week
                </h2>
                <span className="font-mono text-sm tabular-nums text-text-primary">{formatHoursMinutes(weekMin)}</span>
              </div>
              {tc.profile.standardHoursPerWeek ? (
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-bg-tertiary" role="progressbar" aria-valuemin={0} aria-valuemax={tc.profile.standardHoursPerWeek * 60} aria-valuenow={Math.min(weekMin, tc.profile.standardHoursPerWeek * 60)}>
                  <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, (weekMin / (tc.profile.standardHoursPerWeek * 60)) * 100)}%` }} />
                </div>
              ) : null}
              {breakdown.length > 0 && (
                <ul className="mt-4 space-y-2 border-t border-border pt-3 text-sm">
                  {breakdown.map((b) => (
                    <li key={b.jobId ?? 'none'} className="flex justify-between gap-3">
                      <span className="truncate text-text-secondary">{nameOf(b.jobId)}</span>
                      <span className="font-mono tabular-nums text-text-primary">{formatHoursMinutes(b.ms / 60000)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <section aria-label="Recent shifts">
              <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-text-primary">
                <History className="h-4 w-4" /> Recent shifts
              </h2>
              {tc.recent.length === 0 ? (
                <EmptyState icon={CheckCircle2} title="No shifts yet" description="Your completed shifts will show up here." />
              ) : (
                <ul className="space-y-2">
                  {tc.recent.map((s) => (
                    <li key={s.id} className="flex items-center justify-between rounded-xl border border-border bg-bg-secondary px-4 py-3 text-sm">
                      <div>
                        <p className="font-medium text-text-primary">{dayOf(s.work_date)}</p>
                        <p className="text-xs text-text-secondary">
                          {timeOf(Date.parse(s.clock_in_at))} – {timeOf(Date.parse(s.clock_out_at))}
                          {s.break_minutes > 0 ? ` · ${s.break_minutes}m break` : ''}
                        </p>
                      </div>
                      <span className="font-mono tabular-nums text-text-primary">{formatHoursMinutes(s.net_minutes ?? 0)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
