import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ArrowLeft, CalendarX, ChevronLeft, ChevronRight, Clock, MapPin,
  Navigation, RefreshCw, Route as RouteIcon, WifiOff,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { formatTime, STATUS_LABELS } from '@/lib/technicianOS';
import {
  dayKey, fetchWeekSchedule, groupByDay, readScheduleCache, routeNavUrl, stopNavUrl, summarizeDay,
  weekDays, weekStart, writeScheduleCache, type ScheduleJob,
} from '@/lib/technicianSchedule';

type LoadStatus = 'loading' | 'ready' | 'error';

const STATUS_DOT: Record<string, string> = {
  scheduled: 'bg-accent',
  en_route: 'bg-blue-500',
  in_progress: 'bg-warning-500',
  completed: 'bg-success-500',
};

const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short' });
const SHORT_DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const LONG_DATE = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

export function TechnicianSchedulePage() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const online = useOnline();

  const today = useMemo(() => new Date(), []);
  const todayKey = dayKey(today);

  const [offset, setOffset] = useState(0);
  const start = useMemo(() => weekStart(today, offset), [today, offset]);
  const days = useMemo(() => weekDays(start), [start]);

  const [jobs, setJobs] = useState<ScheduleJob[]>([]);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [fromCache, setFromCache] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const defaultDay = useCallback(
    (list: Date[]) => (list.some((d) => dayKey(d) === todayKey) ? todayKey : dayKey(list[0])),
    [todayKey],
  );
  const [selectedKey, setSelectedKey] = useState(() => defaultDay(weekDays(weekStart(new Date(), 0))));

  useEffect(() => {
    setSelectedKey(defaultDay(days));
  }, [days, defaultDay]);

  useEffect(() => {
    let cancelled = false;
    const cached = userId ? readScheduleCache(userId, start) : null;
    setJobs(cached?.jobs ?? []);
    setFetchedAt(cached?.fetchedAt ?? null);
    setFromCache(Boolean(cached));
    setErrorMsg(null);
    setStatus(cached ? 'ready' : 'loading');

    if (!online) {
      if (!cached) {
        setStatus('error');
        setErrorMsg("You're offline and this week isn't saved on this device yet.");
      }
      setRefreshing(false);
      return () => {
        cancelled = true;
      };
    }

    setRefreshing(true);
    fetchWeekSchedule(start)
      .then((rows) => {
        if (cancelled) return;
        setJobs(rows);
        setFromCache(false);
        setFetchedAt(Date.now());
        setStatus('ready');
        if (userId) writeScheduleCache(userId, start, rows);
      })
      .catch(() => {
        if (cancelled) return;
        if (cached) {
          setErrorMsg('Could not refresh. Showing the last saved schedule.');
        } else {
          setStatus('error');
          setErrorMsg("Couldn't load your schedule.");
        }
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });

    return () => {
      cancelled = true;
    };
  }, [userId, start, online, reloadTick]);

  const byDay = useMemo(() => groupByDay(jobs, days), [jobs, days]);
  const dayJobs = byDay.get(selectedKey) ?? [];
  const summary = summarizeDay(dayJobs);
  const route = routeNavUrl(dayJobs);
  const weekTotal = jobs.length;
  const nextStopId = selectedKey === todayKey ? dayJobs.find((j) => j.job_status !== 'completed')?.id : undefined;
  const selectedDate = days.find((d) => dayKey(d) === selectedKey) ?? days[0];
  const nextBusyDay = days.find((d) => dayKey(d) > selectedKey && (byDay.get(dayKey(d))?.length ?? 0) > 0);

  return (
    <div className="min-h-screen bg-bg-primary pb-10">
      <header className="sticky top-0 z-10 border-b border-border bg-bg-primary/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-lg items-center gap-3">
          <Link to="/tech/today" aria-label="Back to today" className="flex h-11 w-11 items-center justify-center rounded-lg text-text-primary">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold text-text-primary">Weekly schedule</h1>
            <p className="truncate text-sm text-text-secondary">
              {SHORT_DATE.format(days[0])} – {SHORT_DATE.format(days[6])}
              {status === 'ready' && ` · ${weekTotal} job${weekTotal === 1 ? '' : 's'}`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setReloadTick((n) => n + 1)}
            disabled={!online || refreshing}
            aria-label="Refresh schedule"
            className="flex h-11 w-11 items-center justify-center rounded-lg text-text-secondary disabled:opacity-40"
          >
            <RefreshCw className={`h-5 w-5 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <div className="mx-auto mt-2 flex max-w-lg items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setOffset((o) => o - 1)}
            aria-label="Previous week"
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-border text-text-primary"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={() => setOffset(0)}
            disabled={offset === 0}
            className="h-11 flex-1 rounded-lg border border-border text-sm font-medium text-text-primary disabled:opacity-50"
          >
            This week
          </button>
          <button
            type="button"
            onClick={() => setOffset((o) => o + 1)}
            aria-label="Next week"
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-border text-text-primary"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-lg px-4 py-4">
        {(!online || (errorMsg && status === 'ready') || fromCache) && status === 'ready' && (
          <div role="status" className="mb-3 flex items-start gap-2 rounded-lg border border-border bg-bg-secondary p-3 text-sm text-text-secondary">
            {!online ? <WifiOff className="mt-0.5 h-4 w-4 flex-shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-warning-500" />}
            <span>
              {!online ? "You're offline. " : ''}
              {errorMsg ?? (fromCache && online ? 'Updating…' : 'Showing the last saved schedule.')}
              {fetchedAt && !errorMsg?.startsWith('Could not') ? ` Saved ${formatTime(new Date(fetchedAt).toISOString())}.` : ''}
            </span>
          </div>
        )}

        {status === 'loading' && (
          <div aria-busy="true" aria-label="Loading schedule" className="space-y-3">
            <div className="flex gap-2">
              {Array.from({ length: 7 }, (_, i) => <Skeleton key={i} className="h-16 min-w-[3.25rem] flex-1" />)}
            </div>
            {Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-28 w-full rounded-xl" />)}
          </div>
        )}

        {status === 'error' && (
          <div className="py-10 text-center">
            <p className="text-text-primary">{errorMsg}</p>
            {online && (
              <button
                type="button"
                onClick={() => setReloadTick((n) => n + 1)}
                className="mt-4 h-11 rounded-lg bg-accent px-5 text-sm font-medium text-white"
              >
                Try again
              </button>
            )}
          </div>
        )}

        {status === 'ready' && weekTotal === 0 && (
          <EmptyState
            icon={CalendarX}
            title="No jobs this week"
            description="When the office assigns you work for this week, it will show up here."
            action={offset !== 0 ? { label: 'Back to this week', onClick: () => setOffset(0) } : undefined}
          />
        )}

        {status === 'ready' && weekTotal > 0 && (
          <>
            <div role="tablist" aria-label="Days of the week" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-2">
              {days.map((d) => {
                const key = dayKey(d);
                const count = byDay.get(key)?.length ?? 0;
                const active = key === selectedKey;
                return (
                  <button
                    key={key}
                    id={`tab-${key}`}
                    role="tab"
                    type="button"
                    aria-selected={active}
                    aria-controls="schedule-panel"
                    onClick={() => setSelectedKey(key)}
                    className={`flex min-h-[4rem] min-w-[3.25rem] flex-1 flex-col items-center justify-center rounded-xl border px-2 py-2 ${
                      active ? 'border-accent bg-accent text-white' : 'border-border bg-bg-secondary text-text-primary'
                    }`}
                  >
                    <span className="text-xs">{WEEKDAY.format(d)}</span>
                    <span className="text-base font-semibold">{d.getDate()}</span>
                    <span className={`text-[11px] ${active ? 'text-white/90' : 'text-text-secondary'}`}>
                      {key === todayKey ? 'Today' : count > 0 ? `${count} job${count === 1 ? '' : 's'}` : '—'}
                    </span>
                  </button>
                );
              })}
            </div>

            <section id="schedule-panel" role="tabpanel" aria-labelledby={`tab-${selectedKey}`} className="mt-3">
              <h2 className="text-base font-semibold text-text-primary">{LONG_DATE.format(selectedDate)}</h2>

              {dayJobs.length === 0 ? (
                <div className="py-8 text-center text-text-secondary">
                  <p>Nothing scheduled for this day.</p>
                  {nextBusyDay && (
                    <button
                      type="button"
                      onClick={() => setSelectedKey(dayKey(nextBusyDay))}
                      className="mt-3 h-11 rounded-lg border border-border px-4 text-sm font-medium text-accent"
                    >
                      Next job: {WEEKDAY.format(nextBusyDay)} {nextBusyDay.getDate()}
                    </button>
                  )}
                </div>
              ) : (
                <>
                  <p className="mt-1 text-sm text-text-secondary">
                    {summary.remaining} of {summary.total} stop{summary.total === 1 ? '' : 's'} left
                    {summary.plannedMinutes > 0 && ` · about ${formatDuration(summary.plannedMinutes)} of work`}
                  </p>

                  {route && (
                    <div className="mt-3">
                      <a
                        href={route.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-accent text-sm font-semibold text-white active:scale-[0.98]"
                      >
                        <RouteIcon className="h-5 w-5" /> Navigate full route ({route.stops} stop{route.stops === 1 ? '' : 's'})
                      </a>
                      {route.truncated && (
                        <p className="mt-1 text-xs text-text-secondary">
                          Maps supports up to {route.stops} stops per route. Navigate the rest from each stop below.
                        </p>
                      )}
                    </div>
                  )}

                  <ol className="mt-4 space-y-3">
                    {dayJobs.map((job, i) => {
                      const googleUrl = stopNavUrl(job, 'google');
                      const appleUrl = stopNavUrl(job, 'apple');
                      const wazeUrl = stopNavUrl(job, 'waze');
                      const done = job.job_status === 'completed';
                      const isNext = job.id === nextStopId;
                      return (
                        <li
                          key={job.id}
                          data-testid="stop-card"
                          className={`rounded-xl border bg-bg-secondary p-4 ${isNext ? 'border-accent' : 'border-border'} ${done ? 'opacity-60' : ''}`}
                        >
                          <div className="flex items-start gap-3">
                            <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-bg-tertiary text-sm font-semibold text-text-primary">
                              {i + 1}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center justify-between gap-2">
                                <span className="flex items-center gap-1 font-medium text-text-primary">
                                  <Clock className="h-4 w-4 text-text-secondary" /> {formatTime(job.scheduled_datetime)}
                                </span>
                                {job.safety_flag && <AlertTriangle aria-label="Safety flag" className="h-4 w-4 text-danger" />}
                              </div>
                              {isNext && <p className="text-xs font-semibold text-accent">Next stop</p>}
                              <p className="truncate text-sm text-text-primary">{job.customer_name}</p>
                              <p className="truncate text-xs text-text-secondary">{job.service_type || '—'}</p>
                              {job.address ? (
                                <p className="mt-1 flex items-start gap-1 text-xs text-text-secondary">
                                  <MapPin className="mt-0.5 h-3 w-3 flex-shrink-0" /> <span className="break-words">{job.address}</span>
                                </p>
                              ) : (
                                <p className="mt-1 text-xs text-text-secondary">No address on file</p>
                              )}
                              <span className="mt-1 inline-flex items-center gap-1.5 text-xs font-medium text-text-secondary">
                                <span className={`h-2 w-2 rounded-full ${STATUS_DOT[job.job_status]}`} />
                                {STATUS_LABELS[job.job_status]}
                              </span>
                            </div>
                          </div>

                          <div className="mt-3 flex flex-wrap gap-2">
                            {googleUrl && !done && (
                              <a
                                href={googleUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                aria-label={`Navigate to ${job.customer_name}`}
                                className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 text-sm font-medium text-white"
                              >
                                <Navigation className="h-4 w-4" /> Navigate
                              </a>
                            )}
                            {appleUrl && !done && (
                              <a href={appleUrl} target="_blank" rel="noopener noreferrer" className="flex h-11 items-center justify-center rounded-lg border border-border px-3 text-sm text-text-primary">
                                Apple
                              </a>
                            )}
                            {wazeUrl && !done && (
                              <a href={wazeUrl} target="_blank" rel="noopener noreferrer" className="flex h-11 items-center justify-center rounded-lg border border-border px-3 text-sm text-text-primary">
                                Waze
                              </a>
                            )}
                            <Link
                              to={`/tech/job/${job.id}`}
                              className="flex h-11 flex-1 items-center justify-center rounded-lg border border-border px-3 text-sm font-medium text-text-primary"
                            >
                              Open job
                            </Link>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                </>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
