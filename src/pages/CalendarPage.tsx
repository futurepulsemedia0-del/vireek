import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft, ChevronRight, X, Plus, MapPin, Wrench } from 'lucide-react';
import { DurationPredictionBadge } from '@/components/jobs/DurationPredictionBadge';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, Job, TeamMember } from '@/lib/supabase';
import { useKeyboardShortcut } from '@/lib/hooks';
import { useRealtimeSubscription } from '@/lib/realtime';
import { LiveIndicator } from '@/components/LiveIndicator';
import { ScheduleDndProvider } from '@/components/schedule/ScheduleDnd';
import {
  WeekGrid,
  DayLanes,
  UnscheduledStrip,
  CalendarJobCard,
  type PaletteEntry,
} from '@/components/schedule/CalendarBoard';
import { useScheduleBoard } from '@/hooks/useScheduleBoard';
import { CalendarExtendedViews, CalendarToolbarExtras, CalendarViewSwitcher } from '@/components/schedule/CalendarViews';
import { useCalendarPrefs, useCalendarShortcuts } from '@/hooks/useCalendarView';
import { describeFilters, filterJobs, isExtendedView, periodLabel, shiftAnchor, statusColor } from '@/lib/calendarViews';
import { toDateKey, type MoveTargetOption } from '@/lib/scheduleDnd';

// ============================================================
// Dispatch Calendar — visual week/day scheduling board.
// Closes the gap with ServiceTitan/Jobber/Housecall Pro, which all put a
// drag-and-drop calendar in front of dispatchers instead of a plain list.
// Jobs page remains the source of truth for full job detail, invoicing,
// and creation; this page is purely a scheduling/reassignment surface
// that writes to the same `jobs` table so both stay in sync in realtime.
// The boards themselves (week grid, day lanes, unscheduled strip) live in
// components/schedule/CalendarBoard.tsx and use @dnd-kit.
// ============================================================

type JobStatus = Job['job_status'];

const STATUS_OPTIONS: { key: JobStatus; label: string }[] = [
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'en_route', label: 'En Route' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'completed', label: 'Completed' },
  { key: 'cancelled', label: 'Cancelled' },
];

const DURATION_OPTIONS = [30, 60, 90, 120, 180, 240];

// A small fixed palette so each technician gets a stable, distinct color
// across the week grid, the day lanes, and job cards. Indexed by position
// in the technicians list (not by id) so it stays deterministic and cheap.
const TECH_PALETTE: PaletteEntry[] = [
  { bg: 'bg-accent/15', text: 'text-accent' },
  { bg: 'bg-cta/15', text: 'text-cta' },
  { bg: 'bg-success-500/15', text: 'text-success-500' },
  { bg: 'bg-warning-500/15', text: 'text-warning-500' },
  { bg: 'bg-blue-500/15', text: 'text-blue-500' },
  { bg: 'bg-danger/15', text: 'text-danger' },
];

const UNASSIGNED_COLOR: PaletteEntry = { bg: 'bg-bg-tertiary', text: 'text-text-secondary' };

// ============================================================
// DATE HELPERS
// ============================================================

function startOfWeekMonday(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function toDatetimeLocalValue(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromDatetimeLocalValue(value: string): string | null {
  if (!value) return null;
  return new Date(value).toISOString();
}

// ============================================================
// SHARED UI PIECES
// ============================================================

function SkeletonBlock({ className }: { className: string }) {
  return <div className={`animate-pulse rounded bg-bg-tertiary ${className}`} />;
}

// ============================================================
// SCHEDULE DRAWER — click any card to edit time, technician, status,
// and estimated duration in one place.
// ============================================================

function ScheduleDrawer({
  job,
  technicians,
  canEditAssignment,
  onClose,
  onSave,
  onUnschedule,
}: {
  job: Job;
  technicians: TeamMember[];
  canEditAssignment: boolean;
  onClose: () => void;
  onSave: (updates: Partial<Job>) => Promise<boolean>;
  onUnschedule: () => void;
}) {
  const navigate = useNavigate();
  const [datetimeValue, setDatetimeValue] = useState(toDatetimeLocalValue(job.scheduled_datetime));
  const [techId, setTechId] = useState(job.assigned_technician_id ?? '');
  const [status, setStatus] = useState<JobStatus>(job.job_status);
  const [duration, setDuration] = useState<number>((job.duration_minutes as number | null) ?? 60);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDatetimeValue(toDatetimeLocalValue(job.scheduled_datetime));
    setTechId(job.assigned_technician_id ?? '');
    setStatus(job.job_status);
    setDuration((job.duration_minutes as number | null) ?? 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id]);

  const handleSave = async () => {
    setSaving(true);
    const ok = await onSave({
      scheduled_datetime: fromDatetimeLocalValue(datetimeValue),
      assigned_technician_id: techId || null,
      job_status: status,
      duration_minutes: duration,
    });
    setSaving(false);
    if (ok) onClose();
  };

  const durationOptions = DURATION_OPTIONS.includes(duration)
    ? DURATION_OPTIONS
    : [...DURATION_OPTIONS, duration].sort((a, b) => a - b);

  return (
    <motion.div
      initial={{ x: '100%' }}
      animate={{ x: 0 }}
      exit={{ x: '100%' }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="fixed right-0 top-0 z-50 h-full w-full max-w-md overflow-y-auto border-l border-border bg-bg-secondary shadow-card-hover dark:shadow-card-hover-dark"
    >
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-bg-secondary/95 px-6 py-4 backdrop-blur-md">
        <h2 className="text-base font-semibold text-text-primary">Reschedule Job</h2>
        <button
          type="button"
          onClick={onClose}
          className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          aria-label="Close panel"
        >
          <X size={18} />
        </button>
      </div>

      <div className="space-y-5 px-6 py-5">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Wrench size={22} />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-lg font-bold text-text-primary">{job.customer_name}</h3>
            {job.service_type && <p className="text-sm text-text-secondary">{job.service_type}</p>}
          </div>
        </div>

        {job.address && (
          <p className="flex items-center gap-1.5 text-sm text-text-secondary">
            <MapPin size={14} className="shrink-0" /> {job.address}
          </p>
        )}

        <div>
          <label className="mb-1.5 block text-xs font-medium text-text-secondary">Date &amp; Time</label>
          <input
            type="datetime-local"
            value={datetimeValue}
            onChange={(e) => setDatetimeValue(e.target.value)}
            className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary"
          />
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-medium text-text-secondary">Estimated Duration</label>
          <select
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
            className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary"
          >
            {durationOptions.map((mins) => (
              <option key={mins} value={mins}>
                {mins < 60
                  ? `${mins} min`
                  : `${(mins / 60).toString().replace('.0', '')} hr${mins > 60 && mins % 60 !== 0 ? ` ${mins % 60}m` : ''}`}
              </option>
            ))}
          </select>
          <DurationPredictionBadge
            className="mt-2"
            input={{
              jobId: job.id,
              serviceType: job.service_type,
              technicianId: techId || null,
              customerId: job.customer_id,
              planMinutes: typeof job.expected_duration_minutes === 'number' ? job.expected_duration_minutes : null,
              slotMinutes: (job.duration_minutes as number | null) ?? null,
            }}
            currentMinutes={duration}
            onApply={setDuration}
          />
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-medium text-text-secondary">Assigned Technician</label>
          <select
            value={techId}
            onChange={(e) => setTechId(e.target.value)}
            disabled={!canEditAssignment}
            className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary disabled:opacity-60"
          >
            <option value="">Unassigned</option>
            {technicians.map((t) => (
              <option key={t.id} value={t.id}>
                {t.member_name ?? t.member_email}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-medium text-text-secondary">Status</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as JobStatus)}
            className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-2 pt-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="focus-ring flex items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:brightness-110 disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
          <button
            type="button"
            onClick={onUnschedule}
            className="focus-ring rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:border-danger/40 hover:text-danger"
          >
            Remove from Schedule
          </button>
          <button
            type="button"
            onClick={() => navigate('/dashboard/jobs')}
            className="focus-ring rounded-xl px-4 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
          >
            Open Full Job Record in Jobs →
          </button>
        </div>
      </div>
    </motion.div>
  );
}

// ============================================================
// MAIN CALENDAR PAGE
// ============================================================

export function CalendarPage() {
  const navigate = useNavigate();
  const { user, profile, profileLoading, isOwner, permissions, teamMember } = useAuth();
  const { toast } = useToast();

  const [allJobs, setAllJobs] = useState<Job[]>([]);
  const [technicians, setTechnicians] = useState<TeamMember[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const { view: viewMode, setView: setViewMode, colorMode, setColorMode, agendaGroupBy, setAgendaGroupBy } = useCalendarPrefs();
  const [statusFilter, setStatusFilter] = useState<Set<string>>(() => new Set());
  const [anchorDate, setAnchorDate] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const [techFilter, setTechFilter] = useState<string>('all');
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);

  const canViewAll = isOwner || permissions.can_view_all_jobs;

  const loadData = useCallback(async () => {
    if (!user) return;
    setDataLoading(true);
    try {
      const [jobsRes, techRes] = await Promise.all([
        supabase.from('jobs').select('*').order('scheduled_datetime', { ascending: true }),
        supabase.from('team_members').select('*').eq('role', 'technician').eq('invite_status', 'active'),
      ]);
      let jobs = (jobsRes.data as Job[]) ?? [];
      if (!canViewAll && teamMember) {
        jobs = jobs.filter((j) => j.assigned_technician_id === teamMember.id);
      }
      setAllJobs(jobs);
      if (techRes.data) setTechnicians(techRes.data as TeamMember[]);
    } catch {
      // Empty states below handle a failed load gracefully.
    } finally {
      setDataLoading(false);
    }
  }, [user, canViewAll, teamMember]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!profileLoading && profile && !profile.onboarding_completed) {
      navigate('/onboarding', { replace: true });
    }
  }, [profile, profileLoading, navigate]);

  // ------------------------------------------------------------
  // Drag & drop board (resolve → validate → optimistic commit with Undo)
  // ------------------------------------------------------------

  const syncSelected = useCallback(
    (row: Job) => setSelectedJob((prev) => (prev?.id === row.id ? { ...prev, ...row } : prev)),
    [],
  );

  const board = useScheduleBoard({
    jobs: allJobs,
    setJobs: setAllJobs,
    technicians,
    canManage: canViewAll,
    viewDay: toDateKey(anchorDate),
    onJobSynced: syncSelected,
  });

  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;

  const jobsLiveStatus = useRealtimeSubscription<Job>({
    channelName: `calendar-jobs-${accountOwnerId ?? 'anon'}`,
    table: 'jobs',
    event: '*',
    filter: accountOwnerId ? `user_id=eq.${accountOwnerId}` : undefined,
    enabled: !!accountOwnerId,
    onChange: (payload) => {
      if (payload.eventType === 'INSERT') {
        const row = payload.new as Job;
        if (board.moves.isPending(row.id)) return;
        if (!canViewAll && teamMember && row.assigned_technician_id !== teamMember.id) return;
        setAllJobs((prev) => (prev.some((j) => j.id === row.id) ? prev : [row, ...prev]));
      } else if (payload.eventType === 'UPDATE') {
        const row = payload.new as Job;
        if (!canViewAll && teamMember && row.assigned_technician_id !== teamMember.id) {
          setAllJobs((prev) => prev.filter((j) => j.id !== row.id));
          return;
        }
        setAllJobs((prev) =>
          prev.some((j) => j.id === row.id) ? prev.map((j) => (j.id === row.id ? row : j)) : [row, ...prev],
        );
        setSelectedJob((prev) => (prev?.id === row.id ? row : prev));
      } else if (payload.eventType === 'DELETE') {
        const row = payload.old as Job;
        setAllJobs((prev) => prev.filter((j) => j.id !== row.id));
        setSelectedJob((prev) => (prev?.id === row.id ? null : prev));
      }
    },
  });

  useKeyboardShortcut({
    key: 'Escape',
    handler: () => {
      if (selectedJob) setSelectedJob(null);
    },
  });

  // ------------------------------------------------------------
  // Derived data
  // ------------------------------------------------------------

  const techColorMap = useMemo(() => {
    const map = new Map<string, PaletteEntry>();
    technicians.forEach((t, i) => map.set(t.id, TECH_PALETTE[i % TECH_PALETTE.length]));
    return map;
  }, [technicians]);

  const getColor = useCallback(
    (techId: string | null) => (techId ? techColorMap.get(techId) ?? UNASSIGNED_COLOR : UNASSIGNED_COLOR),
    [techColorMap],
  );

  const activeJobs = useMemo(() => allJobs.filter((j) => j.job_status !== 'cancelled'), [allJobs]);

  const visibleJobs = useMemo(
    () => filterJobs(activeJobs, { technician: techFilter, statuses: statusFilter }),
    [activeJobs, techFilter, statusFilter],
  );

  const scheduledJobs = useMemo(() => visibleJobs.filter((j) => j.scheduled_datetime), [visibleJobs]);
  const unscheduledJobs = useMemo(
    () => visibleJobs.filter((j) => !j.scheduled_datetime).sort((a, b) => a.customer_name.localeCompare(b.customer_name)),
    [visibleJobs],
  );

  const weekStart = useMemo(() => startOfWeekMonday(anchorDate), [anchorDate]);
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);

  const jobsByDay = useMemo(() => {
    const map = new Map<string, Job[]>();
    weekDays.forEach((d) => map.set(d.toDateString(), []));
    scheduledJobs.forEach((j) => {
      const d = new Date(j.scheduled_datetime as string);
      const key = d.toDateString();
      if (map.has(key)) map.get(key)!.push(j);
    });
    map.forEach((arr) =>
      arr.sort((a, b) => new Date(a.scheduled_datetime!).getTime() - new Date(b.scheduled_datetime!).getTime()),
    );
    return map;
  }, [weekDays, scheduledJobs]);

  const dayJobs = useMemo(
    () => scheduledJobs.filter((j) => isSameDay(new Date(j.scheduled_datetime as string), anchorDate)),
    [scheduledJobs, anchorDate],
  );

  const laneTechnicians = useMemo(
    () => (canViewAll ? technicians : technicians.filter((t) => t.id === teamMember?.id)),
    [canViewAll, technicians, teamMember],
  );

  const lanes = useMemo(
    () => [
      { key: 'unassigned', technician: null as TeamMember | null },
      ...laneTechnicians.map((t) => ({ key: t.id, technician: t as TeamMember | null })),
    ],
    [laneTechnicians],
  );

  const laneJobs = useMemo(() => {
    const map = new Map<string, Job[]>();
    lanes.forEach((l) => map.set(l.key, []));
    dayJobs.forEach((j) => {
      const key = j.assigned_technician_id && map.has(j.assigned_technician_id) ? j.assigned_technician_id : 'unassigned';
      map.get(key)!.push(j);
    });
    map.forEach((arr) =>
      arr.sort((a, b) => new Date(a.scheduled_datetime!).getTime() - new Date(b.scheduled_datetime!).getTime()),
    );
    return map;
  }, [lanes, dayJobs]);

  // ------------------------------------------------------------
  // Mutations (used by the edit drawer)
  // ------------------------------------------------------------

  const updateJob = useCallback(
    async (jobId: string, updates: Partial<Job>, successMessage?: string) => {
      const previous = allJobs.find((j) => j.id === jobId) ?? null;
      setAllJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, ...updates } : j)));
      setSelectedJob((prev) => (prev && prev.id === jobId ? { ...prev, ...updates } : prev));

      try {
        if (updates.assigned_technician_id) {
          const { data, error } = await supabase.rpc('assign_technician_to_job', {
            p_job_id: jobId,
            p_technician_id: updates.assigned_technician_id,
          });

          if (error || data?.status !== 'assigned') {
            throw new Error(data?.reason || error?.message || 'Could not assign this job.');
          }

          const rest = { ...updates };
          delete rest.assigned_technician_id;

          if (Object.keys(rest).length > 0) {
            const { error: restError } = await supabase.from('jobs').update(rest).eq('id', jobId);
            if (restError) throw restError;
          }
        } else {
          const { error } = await supabase.from('jobs').update(updates).eq('id', jobId);
          if (error) throw error;
        }

        if (successMessage) toast(successMessage, 'success');
        return true;
      } catch (err) {
        if (previous) {
          setAllJobs((prev) => prev.map((j) => (j.id === jobId ? previous : j)));
          setSelectedJob((prev) => (prev && prev.id === jobId ? previous : prev));
        }

        toast(err instanceof Error ? err.message : 'Could not update the job. Please try again.', 'error');

        return false;
      }
    },
    [allJobs, toast],
  );

  const moveTargetsFor = useCallback((): MoveTargetOption[] => {
    const unscheduled: MoveTargetOption = {
      key: 'unscheduled',
      label: 'Needs scheduling',
      group: 'Other',
      target: { kind: 'unscheduled' },
    };
    const techTargets = lanes.map(
      (l): MoveTargetOption => ({
        key: `lane-${l.key}`,
        label: l.technician ? l.technician.member_name ?? l.technician.member_email : 'Unassigned',
        group: 'Technician',
        target: { kind: 'lane', technicianId: l.technician?.id ?? null },
      }),
    );
    if (viewMode === 'day') return [...techTargets, unscheduled];
    const dayTargets = weekDays.map(
      (d): MoveTargetOption => ({
        key: `day-${toDateKey(d)}`,
        label: d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }),
        group: 'Day',
        target: { kind: 'day', date: toDateKey(d) },
      }),
    );
    return [...dayTargets, ...techTargets, unscheduled];
  }, [viewMode, weekDays, lanes]);

  const handleDrawerSave = async (updates: Partial<Job>) => {
    if (!selectedJob) return false;
    return updateJob(selectedJob.id, updates, 'Job updated.');
  };

  const handleUnschedule = async () => {
    if (!selectedJob) return;
    await updateJob(selectedJob.id, { scheduled_datetime: null }, 'Removed from schedule.');
    setSelectedJob(null);
  };

  // ------------------------------------------------------------
  // Navigation
  // ------------------------------------------------------------

  const goPrev = useCallback(() => setAnchorDate((d) => shiftAnchor(viewMode, d, -1)), [viewMode]);
  const goNext = useCallback(() => setAnchorDate((d) => shiftAnchor(viewMode, d, 1)), [viewMode]);
  const goToday = useCallback(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    setAnchorDate(d);
  }, []);
  const openDay = useCallback(
    (d: Date) => {
      setAnchorDate(d);
      setViewMode('day');
    },
    [setViewMode],
  );

  const rangeLabel = periodLabel(viewMode, anchorDate);
  const filterSummary = describeFilters(
    techFilter === 'all'
      ? null
      : techFilter === 'unassigned'
        ? 'Unassigned'
        : technicians.find((t) => t.id === techFilter)?.member_name ?? 'Technician',
    [...statusFilter].map((s) => statusColor(s).label),
  );

  useCalendarShortcuts({ enabled: !selectedJob, onView: setViewMode, onPrev: goPrev, onNext: goNext, onToday: goToday });

  const boardCommon = {
    getColor,
    isDraggable: board.isDraggable,
    pendingIds: board.moves.pendingIds,
    moveTargetsFor,
    onCardClick: setSelectedJob,
  };

  return (
    <DashboardLayout activeLabel="Calendar">
      <ScheduleDndProvider
        plan={board.plan}
        onMove={board.handleMove}
        describeJob={(id) => {
          const j = allJobs.find((x) => x.id === id);
          return j ? `${j.customer_name}${j.service_type ? `, ${j.service_type}` : ''}` : 'job';
        }}
        renderOverlay={(id) => {
          const j = allJobs.find((x) => x.id === id);
          return j ? (
            <div className="w-60">
              <CalendarJobCard
                job={j}
                technician={technicians.find((t) => t.id === j.assigned_technician_id) ?? null}
                color={getColor(j.assigned_technician_id)}
                onClick={() => undefined}
              />
            </div>
          ) : null;
        }}
      >
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Dispatch Calendar</h1>
              <LiveIndicator status={jobsLiveStatus} />
            </div>
            <p className="mt-1.5 text-sm text-text-secondary">
              Drag a job onto a day to reschedule it, or onto a technician to reassign it.
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate('/dashboard/jobs')}
            className="focus-ring flex items-center gap-2 rounded-xl bg-cta px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-all hover:brightness-110 hover:shadow-glow-cta"
          >
            <Plus size={16} /> New Job
          </button>
        </div>

        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-bg-secondary p-3 shadow-card dark:shadow-card-dark">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={goPrev}
              aria-label="Previous"
              className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg border border-border text-text-secondary transition-colors hover:text-text-primary"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              type="button"
              onClick={goToday}
              className="focus-ring rounded-lg border border-border px-3 py-2 text-xs font-semibold text-text-secondary transition-colors hover:text-text-primary"
            >
              Today
            </button>
            <button
              type="button"
              onClick={goNext}
              aria-label="Next"
              className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg border border-border text-text-secondary transition-colors hover:text-text-primary"
            >
              <ChevronRight size={16} />
            </button>
            <span className="ml-2 text-sm font-semibold text-text-primary">{rangeLabel}</span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={techFilter}
              onChange={(e) => setTechFilter(e.target.value)}
              className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
            >
              <option value="all">All technicians</option>
              <option value="unassigned">Unassigned</option>
              {technicians.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.member_name ?? t.member_email}
                </option>
              ))}
            </select>
            <CalendarToolbarExtras
              view={viewMode}
              colorMode={colorMode}
              onColorMode={setColorMode}
              statusFilter={statusFilter}
              onStatusFilter={setStatusFilter}
              agendaGroupBy={agendaGroupBy}
              onAgendaGroupBy={setAgendaGroupBy}
            />
            <CalendarViewSwitcher view={viewMode} onChange={setViewMode} />
          </div>
        </div>

        {dataLoading ? (
          <div
            className={`grid gap-3 ${
              viewMode === 'week' ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-7' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4'
            }`}
          >
            {Array.from({ length: viewMode === 'week' ? 7 : 4 }).map((_, i) => (
              <div key={i} className="rounded-2xl border border-border bg-bg-secondary p-3 shadow-card dark:shadow-card-dark">
                <SkeletonBlock className="h-4 w-16" />
                <SkeletonBlock className="mt-2 h-20 w-full" />
                <SkeletonBlock className="mt-2 h-20 w-full" />
              </div>
            ))}
          </div>
        ) : isExtendedView(viewMode) ? (
          <CalendarExtendedViews
            view={viewMode}
            anchorDate={anchorDate}
            onAnchorChange={setAnchorDate}
            onOpenDay={openDay}
            jobs={scheduledJobs}
            technicians={technicians}
            lanes={lanes}
            colorMode={colorMode}
            agendaGroupBy={agendaGroupBy}
            filterSummary={filterSummary}
            isDraggable={board.isDraggable}
            pendingIds={board.moves.pendingIds}
            moveTargetsFor={moveTargetsFor}
            onCardClick={setSelectedJob}
          />
        ) : viewMode === 'week' ? (
          <WeekGrid weekDays={weekDays} jobsByDay={jobsByDay} technicians={technicians} {...boardCommon} />
        ) : (
          <DayLanes lanes={lanes} laneJobs={laneJobs} {...boardCommon} />
        )}

        {!dataLoading && <UnscheduledStrip jobs={unscheduledJobs} technicians={technicians} {...boardCommon} />}
      </ScheduleDndProvider>

      <AnimatePresence>
        {selectedJob && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedJob(null)}
              className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
            />
            <ScheduleDrawer
              job={selectedJob}
              technicians={technicians}
              canEditAssignment={canViewAll}
              onClose={() => setSelectedJob(null)}
              onSave={handleDrawerSave}
              onUnschedule={handleUnschedule}
            />
          </>
        )}
      </AnimatePresence>
    </DashboardLayout>
  );
}
