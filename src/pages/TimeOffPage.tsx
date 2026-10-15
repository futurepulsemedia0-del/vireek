/**
 * Time Off — /dashboard/time-off
 *
 * Technician PTO, weekly availability and company blackout dates. The same data feeds Dispatch suggestions,
 * the capacity numbers here, and the database-side auto-assign (assign_technician_to_job) so an unavailable
 * technician is never picked. Rules and security live in
 * supabase/migrations/20270502000000_time_off_availability.sql; pure logic in lib/timeOff.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, Ban, CalendarOff, ChevronLeft, ChevronRight, Lock, Plus, Users } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { BlackoutForm, TimeOffForm } from '@/components/timeoff/TimeOffForms';
import { TimeOffCalendar } from '@/components/timeoff/TimeOffCalendar';
import { WeeklyAvailability } from '@/components/timeoff/WeeklyAvailability';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  EMPTY_AVAILABILITY,
  addDays,
  buildAgenda,
  capacityForDays,
  findConflicts,
  formatDay,
  formatRange,
  localIsoDate,
  monthDays,
  monthTitle,
  shiftMonth,
  summarizeTimeOff,
  technicianLabel,
  toggleWorkingDay,
  type AgendaItem,
  type AvailabilityData,
  type BlackoutDraft,
  type ScheduledJob,
  type TechnicianLite,
  type TimeOffDraft,
} from '@/lib/timeOff';
import {
  cancelBlackout,
  cancelTimeOff,
  createBlackout,
  createTimeOff,
  describeTimeOffError,
  fetchAvailabilityData,
  fetchScheduledJobs,
  fetchTechnicians,
  saveWorkingDays,
} from '@/lib/timeOffApi';

type FormInput = { type: 'time_off'; initial: Partial<TimeOffDraft> } | { type: 'blackout'; initial: Partial<BlackoutDraft> };
type FormState = FormInput & { nonce: number };

function StatTile({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'alert' }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${tone === 'alert' ? 'text-danger' : 'text-text-primary'}`}>{value}</p>
    </div>
  );
}

export function TimeOffPage() {
  const { profile, teamMember, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();

  const accountOwnerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const canAccess = isOwner || permissions.can_manage_team;

  const today = useMemo(() => localIsoDate(), []);
  const [cursor, setCursor] = useState(() => ({ year: Number(today.slice(0, 4)), month0: Number(today.slice(5, 7)) - 1 }));
  const [technicians, setTechnicians] = useState<TechnicianLite[] | null>(null);
  const [data, setData] = useState<AvailabilityData>(EMPTY_AVAILABILITY);
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [jobsFailed, setJobsFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [view, setView] = useState<'calendar' | 'list'>('calendar');
  const [form, setForm] = useState<FormState | null>(null);
  const [savingDays, setSavingDays] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<AgendaItem | null>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const loadSeq = useRef(0);

  const days = useMemo(() => monthDays(cursor.year, cursor.month0), [cursor]);
  const techs = useMemo(() => technicians ?? [], [technicians]);

  const load = useCallback(async () => {
    if (!accountOwnerId || !canAccess) return;
    const mine = ++loadSeq.current;
    setRefreshing(true);
    setLoadError(false);
    const first = days[0];
    const last = days[days.length - 1];
    const from = today < first ? today : first;
    const horizon = addDays(today, 60);
    const to = horizon > last ? horizon : last;
    const [team, availability, jobRows] = await Promise.allSettled([
      fetchTechnicians(accountOwnerId),
      fetchAvailabilityData(accountOwnerId, from),
      fetchScheduledJobs(accountOwnerId, from, to),
    ]);
    if (mine !== loadSeq.current) return;
    if (team.status === 'fulfilled' && availability.status === 'fulfilled') {
      setTechnicians(team.value);
      setData(availability.value);
    } else {
      setTechnicians((prev) => prev ?? []);
      setLoadError(true);
    }
    setJobs(jobRows.status === 'fulfilled' ? jobRows.value : []);
    setJobsFailed(jobRows.status !== 'fulfilled');
    setRefreshing(false);
  }, [accountOwnerId, canAccess, days, today]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (form) formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [form]);

  const capacity = useMemo(() => capacityForDays(days, techs, data, jobs), [days, techs, data, jobs]);
  const summary = useMemo(() => summarizeTimeOff(today, techs, data, jobs), [today, techs, data, jobs]);
  const agenda = useMemo(() => buildAgenda(data, techs, today), [data, techs, today]);
  const conflicts = useMemo(() => findConflicts(jobs, data), [jobs, data]);
  const nameById = useMemo(() => new Map(techs.map((t) => [t.id, technicianLabel(t)])), [techs]);

  const retry = () => {
    setTechnicians(null);
    void load();
  };

  const openForm = (next: FormInput) => setForm({ ...next, nonce: Date.now() });

  const submitTimeOff = async (draft: TimeOffDraft): Promise<boolean> => {
    if (!accountOwnerId) return false;
    try {
      const created = await createTimeOff(accountOwnerId, draft);
      setData((d) => ({ ...d, timeOff: [...d.timeOff, created] }));
      setForm(null);
      toast('Time off added', 'success');
      return true;
    } catch (e) {
      toast(describeTimeOffError(e), 'error');
      return false;
    }
  };

  const submitBlackout = async (draft: BlackoutDraft): Promise<boolean> => {
    if (!accountOwnerId) return false;
    try {
      const created = await createBlackout(accountOwnerId, draft);
      setData((d) => ({ ...d, blackouts: [...d.blackouts, created] }));
      setForm(null);
      toast('Blackout added', 'success');
      return true;
    } catch (e) {
      toast(describeTimeOffError(e), 'error');
      return false;
    }
  };

  const confirmCancel = async () => {
    const item = cancelTarget;
    if (!item || !accountOwnerId) return;
    setCancelTarget(null);
    try {
      if (item.type === 'time_off') {
        await cancelTimeOff(item.id, accountOwnerId);
        setData((d) => ({ ...d, timeOff: d.timeOff.filter((e) => e.id !== item.id) }));
      } else {
        await cancelBlackout(item.id, accountOwnerId);
        setData((d) => ({ ...d, blackouts: d.blackouts.filter((b) => b.id !== item.id) }));
      }
      toast('Entry cancelled', 'success');
    } catch (e) {
      toast(describeTimeOffError(e), 'error');
    }
  };

  const toggleDay = async (technicianId: string, day: number) => {
    if (!accountOwnerId || savingDays) return;
    const previous = data.weekly[technicianId];
    const next = toggleWorkingDay(previous, day);
    setData((d) => ({ ...d, weekly: { ...d.weekly, [technicianId]: next } }));
    setSavingDays(technicianId);
    try {
      await saveWorkingDays(accountOwnerId, technicianId, next);
    } catch (e) {
      setData((d) => {
        const weekly = { ...d.weekly };
        if (previous) weekly[technicianId] = previous;
        else delete weekly[technicianId];
        return { ...d, weekly };
      });
      toast(describeTimeOffError(e), 'error');
    } finally {
      setSavingDays(null);
    }
  };

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Time Off">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} aria-hidden="true" />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Time off and availability are restricted. Ask your account owner to grant you the "Manage Team" permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  const loading = technicians === null;

  return (
    <DashboardLayout activeLabel="Time Off">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
              <CalendarOff size={22} className="text-accent" aria-hidden="true" /> Time Off & Availability
            </h1>
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-text-secondary">
              Technician PTO, working days and company blackouts. Dispatch suggestions, capacity and auto-assign all respect these dates, so nobody is booked
              on a day they are away.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" disabled={loading || techs.length === 0} onClick={() => openForm({ type: 'blackout', initial: {} })}>
              <Ban size={16} aria-hidden="true" /> Add blackout
            </Button>
            <Button size="sm" disabled={loading || techs.length === 0} onClick={() => openForm({ type: 'time_off', initial: { start_date: today } })}>
              <Plus size={16} aria-hidden="true" /> Add time off
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="space-y-6">
            <SkeletonStatGrid count={4} />
            <SkeletonCardList count={3} />
          </div>
        ) : loadError ? (
          <EmptyState
            icon={AlertTriangle}
            title="We couldn't load time off"
            description="Check your connection and try again."
            action={{ label: 'Try again', onClick: retry }}
          />
        ) : techs.length === 0 ? (
          <EmptyState
            icon={Users}
            title="Add technicians first"
            description="Time off is tracked per technician. Invite your technicians from the Team page, then come back to set their availability."
            action={{ label: 'Open Team', onClick: () => navigate('/dashboard/team') }}
          />
        ) : (
          <div className="space-y-6" aria-busy={refreshing}>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile label="Off today" value={`${summary.offToday} of ${techs.length}`} />
              <StatTile label="Upcoming time off (30 days)" value={String(summary.upcoming30)} />
              <StatTile label="Jobs to reassign" value={String(summary.conflicts)} tone={summary.conflicts > 0 ? 'alert' : 'default'} />
              <StatTile label="Open job slots today" value={String(summary.openSlotsToday)} />
            </div>

            {jobsFailed && (
              <div role="status" className="rounded-xl border border-warning-500/30 bg-warning-500/10 p-3 text-sm text-text-primary">
                We couldn't load scheduled jobs, so conflicts and open slots may be incomplete.{' '}
                <button type="button" className="focus-ring rounded font-semibold text-accent underline" onClick={() => void load()}>
                  Retry
                </button>
              </div>
            )}

            {conflicts.length > 0 && (
              <section aria-label="Jobs to reassign" className="rounded-2xl border border-danger/30 bg-danger/5 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="flex items-center gap-2 text-base font-semibold text-text-primary">
                    <AlertTriangle size={16} className="text-danger" aria-hidden="true" />
                    {conflicts.length} assigned job{conflicts.length === 1 ? '' : 's'} on days off
                  </h2>
                  <Link to="/dashboard/dispatch" className="focus-ring rounded text-sm font-semibold text-accent hover:underline">
                    Open Dispatch Board
                  </Link>
                </div>
                <ul className="mt-3 space-y-1.5 text-sm text-text-primary">
                  {conflicts.slice(0, 5).map((c) => (
                    <li key={c.job.id} className="break-words">
                      <span className="font-semibold">{c.job.customer_name ?? 'Job'}</span> · {formatDay(c.day, { weekday: 'short', month: 'short', day: 'numeric' })} ·{' '}
                      {nameById.get(c.technicianId) ?? 'Technician'} ({c.unavailability.reason})
                    </li>
                  ))}
                </ul>
                {conflicts.length > 5 && <p className="mt-2 text-xs text-text-secondary">And {conflicts.length - 5} more.</p>}
              </section>
            )}

            {form && (
              <div ref={formRef}>
                {form.type === 'time_off' ? (
                  <TimeOffForm
                    key={form.nonce}
                    technicians={techs}
                    jobs={jobs}
                    existing={data.timeOff}
                    initial={form.initial}
                    onSubmit={submitTimeOff}
                    onCancel={() => setForm(null)}
                  />
                ) : (
                  <BlackoutForm key={form.nonce} jobs={jobs} existing={data.blackouts} initial={form.initial} onSubmit={submitBlackout} onCancel={() => setForm(null)} />
                )}
              </div>
            )}

            <section aria-label="Calendar and agenda">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div role="group" aria-label="View" className="flex gap-1.5">
                  {(['calendar', 'list'] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      aria-pressed={view === v}
                      onClick={() => setView(v)}
                      className={`focus-ring min-h-[40px] rounded-xl border px-3.5 text-sm font-semibold transition-colors ${
                        view === v ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg-primary text-text-secondary hover:text-text-primary'
                      }`}
                    >
                      {v === 'calendar' ? 'Calendar' : 'Upcoming'}
                    </button>
                  ))}
                </div>
                {view === 'calendar' && (
                  <div className="flex items-center gap-1.5">
                    <Button variant="ghost" size="sm" aria-label="Previous month" onClick={() => setCursor((c) => shiftMonth(c.year, c.month0, -1))}>
                      <ChevronLeft size={18} aria-hidden="true" />
                    </Button>
                    <p className="min-w-[132px] text-center text-sm font-semibold text-text-primary" aria-live="polite">
                      {monthTitle(cursor.year, cursor.month0)}
                    </p>
                    <Button variant="ghost" size="sm" aria-label="Next month" onClick={() => setCursor((c) => shiftMonth(c.year, c.month0, 1))}>
                      <ChevronRight size={18} aria-hidden="true" />
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => setCursor({ year: Number(today.slice(0, 4)), month0: Number(today.slice(5, 7)) - 1 })}>
                      Today
                    </Button>
                  </div>
                )}
              </div>

              {view === 'calendar' ? (
                <div className={refreshing ? 'opacity-70 transition-opacity' : 'transition-opacity'}>
                  <TimeOffCalendar
                    days={days}
                    technicians={techs}
                    data={data}
                    jobs={jobs}
                    capacity={capacity}
                    today={today}
                    onCellClick={(technicianId, day) => openForm({ type: 'time_off', initial: { technician_id: technicianId, start_date: day, end_date: day } })}
                  />
                </div>
              ) : agenda.length === 0 ? (
                <EmptyState
                  icon={CalendarOff}
                  title="Nothing scheduled"
                  description="No upcoming time off or blackouts. Add some and dispatch will plan around them."
                  action={{ label: 'Add time off', onClick: () => openForm({ type: 'time_off', initial: { start_date: today } }) }}
                />
              ) : (
                <ul className="space-y-2.5" aria-label="Upcoming time off and blackouts">
                  {agenda.map((item) => (
                    <li key={`${item.type}-${item.id}`} className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-bg-secondary p-4">
                      <div className="flex min-w-0 items-start gap-3">
                        <span
                          className={`mt-1 h-8 w-1 shrink-0 rounded-full ${item.type === 'blackout' ? 'bg-danger' : 'bg-warning-500'}`}
                          aria-hidden="true"
                        />
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-text-primary">{item.title}</p>
                          <p className="text-sm text-text-secondary">{formatRange(item.start_date, item.end_date)}</p>
                          {item.detail && <p className="break-words text-xs text-text-secondary">{item.detail}</p>}
                        </div>
                      </div>
                      <Button variant="ghost" size="sm" className="shrink-0" onClick={() => setCancelTarget(item)}>
                        Cancel
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <WeeklyAvailability technicians={techs} weekly={data.weekly} savingId={savingDays} onToggle={(id, day) => void toggleDay(id, day)} />
          </div>
        )}
      </div>

      <ConfirmDialog
        open={cancelTarget !== null}
        title={cancelTarget?.type === 'blackout' ? 'Cancel this blackout?' : 'Cancel this time off?'}
        description={
          cancelTarget
            ? `${cancelTarget.title}, ${formatRange(cancelTarget.start_date, cancelTarget.end_date)}. Dispatch will treat ${
                cancelTarget.type === 'blackout' ? 'these days' : 'this technician'
              } as available again. A cancelled entry can't be reinstated, but you can add a new one.`
            : ''
        }
        confirmLabel="Cancel entry"
        onConfirm={() => void confirmCancel()}
        onCancel={() => setCancelTarget(null)}
      />
    </DashboardLayout>
  );
}
