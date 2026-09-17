import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronLeft,
  ChevronRight,
  Calendar,
  LayoutGrid,
  Clock,
  X,
  Plus,
  MapPin,
  Wrench,
  User as UserIcon,
  TriangleAlert as AlertTriangle,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, Job, TeamMember } from '@/lib/supabase';
import { useKeyboardShortcut } from '@/lib/hooks';
import { useRealtimeSubscription } from '@/lib/realtime';
import { LiveIndicator } from '@/components/LiveIndicator';

// ============================================================
// New: Dispatch Calendar — visual week/day scheduling board.
// Closes the gap with ServiceTitan/Jobber/Housecall Pro, which all put a
// drag-and-drop calendar in front of dispatchers instead of a plain list.
// Jobs page remains the source of truth for full job detail, invoicing,
// and creation; this page is purely a scheduling/reassignment surface
// that writes to the same `jobs` table so both stay in sync in realtime.
// ============================================================

type ViewMode = 'week' | 'day';
type JobStatus = Job['job_status'];

const STATUS_DOT: Record<JobStatus, string> = {
  scheduled: 'bg-accent',
  en_route: 'bg-blue-500',
  in_progress: 'bg-warning-500',
  completed: 'bg-success-500',
  cancelled: 'bg-danger',
};

const STATUS_OPTIONS: { key: JobStatus; label: string }[] = [
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'en_route', label: 'En Route' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'completed', label: 'Completed' },
  { key: 'cancelled', label: 'Cancelled' },
];

const DURATION_OPTIONS = [30, 60, 90, 120, 180, 240];

interface PaletteEntry {
  bg: string;
  text: string;
}

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

function formatTime(iso: string | null): string {
  if (!iso) return 'Unscheduled';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function formatWeekRangeLabel(weekStart: Date): string {
  const weekEnd = addDays(weekStart, 6);
  const sameMonth = weekStart.getMonth() === weekEnd.getMonth();
  const startStr = weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const endStr = weekEnd.toLocaleDateString(
    'en-US',
    sameMonth ? { day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }
  );
  return `${startStr} \u2013 ${endStr}`;
}

// Move a job to a new calendar day while preserving its existing
// time-of-day (or defaulting to 9:00 AM if it had none yet).
function reDateKeepTime(targetDay: Date, existingIso: string | null): string {
  const result = new Date(targetDay);
  if (existingIso) {
    const existing = new Date(existingIso);
    result.setHours(existing.getHours(), existing.getMinutes(), 0, 0);
  } else {
    result.setHours(9, 0, 0, 0);
  }
  return result.toISOString();
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

function initials(name: string): string {
  return name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

// ============================================================
// SHARED UI PIECES
// ============================================================

function SkeletonBlock({ className }: { className: string }) {
  return <div className={`animate-pulse rounded bg-bg-tertiary ${className}`} />;
}

function CalendarJobCard({
  job,
  technician,
  color,
  isDragging,
  onDragStart,
  onDragEnd,
  onClick,
}: {
  job: Job;
  technician: TeamMember | null;
  color: PaletteEntry;
  isDragging: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      className={`group w-full cursor-grab rounded-xl border border-border bg-bg-primary p-3 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-card active:cursor-grabbing dark:shadow-card-dark ${
        isDragging ? 'opacity-40' : ''
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-text-secondary">
          <Clock size={12} />
          {formatTime(job.scheduled_datetime)}
        </span>
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[job.job_status]}`}
          title={job.job_status.replace(/_/g, ' ')}
        />
      </div>
      <p className="mt-1.5 truncate text-sm font-semibold text-text-primary">{job.customer_name}</p>
      {job.service_type && <p className="truncate text-xs text-text-secondary">{job.service_type}</p>}
      {job.address && (
        <p className="mt-1 flex items-center gap-1 truncate text-xs text-text-secondary/80" title={job.address}>
          <MapPin size={11} className="shrink-0" /> {job.address}
        </p>
      )}
      <div className="mt-2 flex items-center gap-1.5">
        <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${color.bg} ${color.text}`}>
          {technician ? initials(technician.member_name ?? technician.member_email) : <UserIcon size={11} />}
        </span>
        <span className="truncate text-xs text-text-secondary">
          {technician ? technician.member_name ?? technician.member_email : 'Unassigned'}
        </span>
      </div>
    </button>
  );
}

// ============================================================
// WEEK VIEW
// ============================================================

function WeekGrid({
  weekDays,
  jobsByDay,
  technicians,
  getColor,
  draggingId,
  dragOverKey,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onCardClick,
}: {
  weekDays: Date[];
  jobsByDay: Map<string, Job[]>;
  technicians: TeamMember[];
  getColor: (techId: string | null) => PaletteEntry;
  draggingId: string | null;
  dragOverKey: string | null;
  onDragStart: (e: React.DragEvent, jobId: string) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent, key: string) => void;
  onDrop: (e: React.DragEvent, day: Date) => void;
  onCardClick: (job: Job) => void;
}) {
  const today = new Date();
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-7">
      {weekDays.map((day) => {
        const key = day.toDateString();
        const jobs = jobsByDay.get(key) ?? [];
        const isToday = isSameDay(day, today);
        const isOver = dragOverKey === key;
        return (
          <div
            key={key}
            onDragOver={(e) => onDragOver(e, key)}
            onDrop={(e) => onDrop(e, day)}
            className={`flex min-h-[220px] flex-col rounded-2xl border p-3 shadow-card transition-colors dark:shadow-card-dark ${
              isOver ? 'border-accent bg-accent/5' : 'border-border bg-bg-secondary'
            }`}
          >
            <div className="mb-2.5 flex items-center justify-between">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">
                  {day.toLocaleDateString('en-US', { weekday: 'short' })}
                </p>
                <p className={`text-sm font-bold ${isToday ? 'text-accent' : 'text-text-primary'}`}>
                  {day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </p>
              </div>
              {jobs.length > 0 && (
                <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] font-semibold text-text-secondary">
                  {jobs.length}
                </span>
              )}
            </div>
            <div className="flex flex-1 flex-col gap-2 overflow-y-auto">
              {jobs.length === 0 ? (
                <p className="mt-4 text-center text-xs text-text-secondary/60">No jobs</p>
              ) : (
                jobs.map((job) => (
                  <CalendarJobCard
                    key={job.id}
                    job={job}
                    technician={technicians.find((t) => t.id === job.assigned_technician_id) ?? null}
                    color={getColor(job.assigned_technician_id)}
                    isDragging={draggingId === job.id}
                    onDragStart={(e) => onDragStart(e, job.id)}
                    onDragEnd={onDragEnd}
                    onClick={() => onCardClick(job)}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
// DAY VIEW (technician lanes)
// ============================================================

function DayLanes({
  lanes,
  laneJobs,
  getColor,
  draggingId,
  dragOverKey,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onCardClick,
}: {
  lanes: { key: string; technician: TeamMember | null }[];
  laneJobs: Map<string, Job[]>;
  getColor: (techId: string | null) => PaletteEntry;
  draggingId: string | null;
  dragOverKey: string | null;
  onDragStart: (e: React.DragEvent, jobId: string) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent, key: string) => void;
  onDrop: (e: React.DragEvent, techId: string | null) => void;
  onCardClick: (job: Job) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {lanes.map((lane) => {
        const jobs = laneJobs.get(lane.key) ?? [];
        const isOver = dragOverKey === lane.key;
        const color = getColor(lane.technician?.id ?? null);
        return (
          <div
            key={lane.key}
            onDragOver={(e) => onDragOver(e, lane.key)}
            onDrop={(e) => onDrop(e, lane.technician?.id ?? null)}
            className={`flex min-h-[280px] flex-col rounded-2xl border p-3 shadow-card transition-colors dark:shadow-card-dark ${
              isOver ? 'border-accent bg-accent/5' : 'border-border bg-bg-secondary'
            }`}
          >
            <div className="mb-2.5 flex items-center gap-2">
              <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${color.bg} ${color.text}`}>
                {lane.technician ? initials(lane.technician.member_name ?? lane.technician.member_email) : <UserIcon size={14} />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-text-primary">
                  {lane.technician ? lane.technician.member_name ?? lane.technician.member_email : 'Unassigned'}
                </p>
                <p className="text-xs text-text-secondary">
                  {jobs.length} {jobs.length === 1 ? 'job' : 'jobs'}
                </p>
              </div>
            </div>
            <div className="flex flex-1 flex-col gap-2 overflow-y-auto">
              {jobs.length === 0 ? (
                <p className="mt-4 text-center text-xs text-text-secondary/60">No jobs scheduled</p>
              ) : (
                jobs.map((job) => (
                  <CalendarJobCard
                    key={job.id}
                    job={job}
                    technician={lane.technician}
                    color={color}
                    isDragging={draggingId === job.id}
                    onDragStart={(e) => onDragStart(e, job.id)}
                    onDragEnd={onDragEnd}
                    onClick={() => onCardClick(job)}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
// UNSCHEDULED BUCKET — jobs with no scheduled_datetime never fall off the
// board; drag them onto a day to schedule, or drag a scheduled job back
// here to pull it off the calendar without deleting it.
// ============================================================

function UnscheduledStrip({
  jobs,
  technicians,
  getColor,
  draggingId,
  isDragOver,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onCardClick,
}: {
  jobs: Job[];
  technicians: TeamMember[];
  getColor: (techId: string | null) => PaletteEntry;
  draggingId: string | null;
  isDragOver: boolean;
  onDragStart: (e: React.DragEvent, jobId: string) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onCardClick: (job: Job) => void;
}) {
  return (
    <div
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`mt-5 rounded-2xl border p-4 shadow-card transition-colors dark:shadow-card-dark ${
        isDragOver ? 'border-accent bg-accent/5' : 'border-dashed border-border bg-bg-secondary/60'
      }`}
    >
      <div className="mb-3 flex items-center gap-2">
        <AlertTriangle size={16} className="text-warning-500" />
        <h3 className="text-sm font-semibold text-text-primary">Needs Scheduling</h3>
        <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] font-semibold text-text-secondary">
          {jobs.length}
        </span>
      </div>
      {jobs.length === 0 ? (
        <p className="text-xs text-text-secondary/70">
          Every open job has a date. Drag a job card here to pull it off the schedule without deleting it.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {jobs.map((job) => (
            <CalendarJobCard
              key={job.id}
              job={job}
              technician={technicians.find((t) => t.id === job.assigned_technician_id) ?? null}
              color={getColor(job.assigned_technician_id)}
              isDragging={draggingId === job.id}
              onDragStart={(e) => onDragStart(e, job.id)}
              onDragEnd={onDragEnd}
              onClick={() => onCardClick(job)}
            />
          ))}
        </div>
      )}
    </div>
  );
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
            {DURATION_OPTIONS.map((mins) => (
              <option key={mins} value={mins}>
                {mins < 60 ? `${mins} min` : `${(mins / 60).toString().replace('.0', '')} hr${mins > 60 && mins % 60 !== 0 ? ` ${mins % 60}m` : ''}`}
              </option>
            ))}
          </select>
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
            {saving ? 'Saving\u2026' : 'Save Changes'}
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
            Open Full Job Record in Jobs \u2192
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
  const [viewMode, setViewMode] = useState<ViewMode>('week');
  const [anchorDate, setAnchorDate] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const [techFilter, setTechFilter] = useState<string>('all');
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

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
        if (!canViewAll && teamMember && row.assigned_technician_id !== teamMember.id) return;
        setAllJobs((prev) => (prev.some((j) => j.id === row.id) ? prev : [row, ...prev]));
      } else if (payload.eventType === 'UPDATE') {
        const row = payload.new as Job;
        if (!canViewAll && teamMember && row.assigned_technician_id !== teamMember.id) {
          setAllJobs((prev) => prev.filter((j) => j.id !== row.id));
          return;
        }
        setAllJobs((prev) =>
          prev.some((j) => j.id === row.id) ? prev.map((j) => (j.id === row.id ? row : j)) : [row, ...prev]
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
    [techColorMap]
  );

  const activeJobs = useMemo(() => allJobs.filter((j) => j.job_status !== 'cancelled'), [allJobs]);

  const visibleJobs = useMemo(() => {
    if (techFilter === 'unassigned') return activeJobs.filter((j) => !j.assigned_technician_id);
    if (techFilter !== 'all') return activeJobs.filter((j) => j.assigned_technician_id === techFilter);
    return activeJobs;
  }, [activeJobs, techFilter]);

  const scheduledJobs = useMemo(() => visibleJobs.filter((j) => j.scheduled_datetime), [visibleJobs]);
  const unscheduledJobs = useMemo(
    () => visibleJobs.filter((j) => !j.scheduled_datetime).sort((a, b) => a.customer_name.localeCompare(b.customer_name)),
    [visibleJobs]
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
    map.forEach((arr) => arr.sort((a, b) => new Date(a.scheduled_datetime!).getTime() - new Date(b.scheduled_datetime!).getTime()));
    return map;
  }, [weekDays, scheduledJobs]);

  const dayJobs = useMemo(
    () => scheduledJobs.filter((j) => isSameDay(new Date(j.scheduled_datetime as string), anchorDate)),
    [scheduledJobs, anchorDate]
  );

  const laneTechnicians = useMemo(
    () => (canViewAll ? technicians : technicians.filter((t) => t.id === teamMember?.id)),
    [canViewAll, technicians, teamMember]
  );

  const lanes = useMemo(
    () => [{ key: 'unassigned', technician: null as TeamMember | null }, ...laneTechnicians.map((t) => ({ key: t.id, technician: t }))],
    [laneTechnicians]
  );

  const laneJobs = useMemo(() => {
    const map = new Map<string, Job[]>();
    lanes.forEach((l) => map.set(l.key, []));
    dayJobs.forEach((j) => {
      const key = j.assigned_technician_id && map.has(j.assigned_technician_id) ? j.assigned_technician_id : 'unassigned';
      map.get(key)!.push(j);
    });
    map.forEach((arr) => arr.sort((a, b) => new Date(a.scheduled_datetime!).getTime() - new Date(b.scheduled_datetime!).getTime()));
    return map;
  }, [lanes, dayJobs]);

  // ------------------------------------------------------------
  // Mutations
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
          const { error: restError } = await supabase
            .from('jobs')
            .update(rest)
            .eq('id', jobId);

          if (restError) throw restError;
        }
      } else {
        const { error } = await supabase
          .from('jobs')
          .update(updates)
          .eq('id', jobId);

        if (error) throw error;
      }

      if (successMessage) toast(successMessage, 'success');
      return true;
    } catch (err) {
      if (previous) {
        setAllJobs((prev) => prev.map((j) => (j.id === jobId ? previous : j)));
        setSelectedJob((prev) => (prev && prev.id === jobId ? previous : prev));
      }

      toast(
        err instanceof Error
          ? err.message
          : 'Could not update the job. Please try again.',
        'error'
      );

      return false;
    }
  },
  [allJobs, toast]
);

  // ------------------------------------------------------------
  // Drag and drop
  // ------------------------------------------------------------

  const handleDragStart = (e: React.DragEvent, jobId: string) => {
    setDraggingId(jobId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', jobId);
  };

  const handleDragEnd = () => {
    setDraggingId(null);
    setDragOverKey(null);
  };

  const handleDragOverKey = (e: React.DragEvent, key: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverKey(key);
  };

  const handleDropOnDay = async (e: React.DragEvent, day: Date) => {
    e.preventDefault();
    const jobId = e.dataTransfer.getData('text/plain');
    setDraggingId(null);
    setDragOverKey(null);
    if (!jobId) return;
    const job = allJobs.find((j) => j.id === jobId);
    if (!job) return;
    if (job.scheduled_datetime && isSameDay(new Date(job.scheduled_datetime), day)) return;
    const newIso = reDateKeepTime(day, job.scheduled_datetime);
    await updateJob(jobId, { scheduled_datetime: newIso }, `Moved to ${day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.`);
  };

  const handleDropOnLane = async (e: React.DragEvent, techId: string | null) => {
    e.preventDefault();
    const jobId = e.dataTransfer.getData('text/plain');
    setDraggingId(null);
    setDragOverKey(null);
    if (!jobId) return;
    const job = allJobs.find((j) => j.id === jobId);
    if (!job || job.assigned_technician_id === techId) return;
    const tech = techId ? technicians.find((t) => t.id === techId) : null;
    await updateJob(
      jobId,
      { assigned_technician_id: techId },
      techId ? `Reassigned to ${tech?.member_name ?? tech?.member_email ?? 'technician'}.` : 'Unassigned.'
    );
  };

  const handleDropOnUnscheduled = async (e: React.DragEvent) => {
    e.preventDefault();
    const jobId = e.dataTransfer.getData('text/plain');
    setDraggingId(null);
    setDragOverKey(null);
    if (!jobId) return;
    const job = allJobs.find((j) => j.id === jobId);
    if (!job || !job.scheduled_datetime) return;
    await updateJob(jobId, { scheduled_datetime: null }, 'Removed from schedule.');
  };

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

  const goPrev = () => setAnchorDate((d) => addDays(d, viewMode === 'week' ? -7 : -1));
  const goNext = () => setAnchorDate((d) => addDays(d, viewMode === 'week' ? 7 : 1));
  const goToday = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    setAnchorDate(d);
  };

  const rangeLabel =
    viewMode === 'week'
      ? formatWeekRangeLabel(weekStart)
      : anchorDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <DashboardLayout activeLabel="Calendar">
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
          <div className="flex rounded-xl border border-border bg-bg-primary p-1">
            <button
              type="button"
              onClick={() => setViewMode('week')}
              className={`focus-ring flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                viewMode === 'week' ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              <LayoutGrid size={15} /> Week
            </button>
            <button
              type="button"
              onClick={() => setViewMode('day')}
              className={`focus-ring flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                viewMode === 'day' ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              <Calendar size={15} /> Day
            </button>
          </div>
        </div>
      </div>

      {dataLoading ? (
        <div className={`grid gap-3 ${viewMode === 'week' ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-7' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4'}`}>
          {Array.from({ length: viewMode === 'week' ? 7 : 4 }).map((_, i) => (
            <div key={i} className="rounded-2xl border border-border bg-bg-secondary p-3 shadow-card dark:shadow-card-dark">
              <SkeletonBlock className="h-4 w-16" />
              <SkeletonBlock className="mt-2 h-20 w-full" />
              <SkeletonBlock className="mt-2 h-20 w-full" />
            </div>
          ))}
        </div>
      ) : viewMode === 'week' ? (
        <WeekGrid
          weekDays={weekDays}
          jobsByDay={jobsByDay}
          technicians={technicians}
          getColor={getColor}
          draggingId={draggingId}
          dragOverKey={dragOverKey}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragOver={handleDragOverKey}
          onDrop={handleDropOnDay}
          onCardClick={setSelectedJob}
        />
      ) : (
        <DayLanes
          lanes={lanes}
          laneJobs={laneJobs}
          getColor={getColor}
          draggingId={draggingId}
          dragOverKey={dragOverKey}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragOver={handleDragOverKey}
          onDrop={handleDropOnLane}
          onCardClick={setSelectedJob}
        />
      )}

      {!dataLoading && (
        <UnscheduledStrip
          jobs={unscheduledJobs}
          technicians={technicians}
          getColor={getColor}
          draggingId={draggingId}
          isDragOver={dragOverKey === 'unscheduled'}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragOver={(e) => handleDragOverKey(e, 'unscheduled')}
          onDrop={handleDropOnUnscheduled}
          onCardClick={setSelectedJob}
        />
      )}

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
