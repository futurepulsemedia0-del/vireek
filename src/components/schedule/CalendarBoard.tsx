import { Clock, MapPin, TriangleAlert as AlertTriangle, User as UserIcon } from 'lucide-react';
import type { Job, TeamMember } from '@/lib/supabase';
import { toDateKey, type MoveTargetOption } from '@/lib/scheduleDnd';
import { DraggableJob, DropZone } from '@/components/schedule/ScheduleDnd';

// ============================================================
// Calendar boards (week grid, technician day lanes, unscheduled strip),
// rebuilt on @dnd-kit. Visual design is unchanged from the previous native-DnD
// version in CalendarPage.tsx; only the drag/drop wiring differs.
// ============================================================

export interface PaletteEntry {
  bg: string;
  text: string;
}

type JobStatus = Job['job_status'];

const STATUS_DOT: Record<JobStatus, string> = {
  scheduled: 'bg-accent',
  en_route: 'bg-blue-500',
  in_progress: 'bg-warning-500',
  completed: 'bg-success-500',
  cancelled: 'bg-danger',
  no_show: 'bg-warning-500',
};

function formatTime(iso: string | null): string {
  if (!iso) return 'Unscheduled';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function initials(name: string): string {
  return name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

const techName = (t: TeamMember) => t.member_name ?? t.member_email;

// ------------------------------------------------------------
// Job card (visual only — dragging is added by <DraggableJob>)
// ------------------------------------------------------------

export function CalendarJobCard({
  job,
  technician,
  color,
  onClick,
}: {
  job: Job;
  technician: TeamMember | null;
  color: PaletteEntry;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group w-full cursor-grab rounded-xl border border-border bg-bg-primary p-3 text-left shadow-sm transition-all hover:border-accent/40 hover:shadow-card active:cursor-grabbing dark:shadow-card-dark"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-text-secondary">
          <Clock size={12} />
          {formatTime(job.scheduled_datetime)}
        </span>
        <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[job.job_status]}`} title={job.job_status.replace(/_/g, ' ')} />
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
          {technician ? initials(techName(technician)) : <UserIcon size={11} />}
        </span>
        <span className="truncate text-xs text-text-secondary">{technician ? techName(technician) : 'Unassigned'}</span>
      </div>
    </button>
  );
}

/** Card + drag behaviour, used by all three boards. */
function DraggableCalendarCard({
  job,
  technician,
  color,
  draggable,
  pending,
  moveTargets,
  onOpen,
}: {
  job: Job;
  technician: TeamMember | null;
  color: PaletteEntry;
  draggable: boolean;
  pending: boolean;
  moveTargets: MoveTargetOption[];
  onOpen: (job: Job) => void;
}) {
  return (
    <DraggableJob
      jobId={job.id}
      label={`${job.customer_name}${job.service_type ? `, ${job.service_type}` : ''}`}
      disabled={!draggable}
      pending={pending}
      moveTargets={moveTargets}
    >
      <CalendarJobCard job={job} technician={technician} color={color} onClick={() => onOpen(job)} />
    </DraggableJob>
  );
}

interface BoardCommon {
  getColor: (techId: string | null) => PaletteEntry;
  isDraggable: (job: Job) => boolean;
  pendingIds: ReadonlySet<string>;
  /** Targets offered in each card's "Move to…" menu. */
  moveTargetsFor: (job: Job) => MoveTargetOption[];
  onCardClick: (job: Job) => void;
}

// ------------------------------------------------------------
// Week view — one drop zone per day
// ------------------------------------------------------------

export function WeekGrid({
  weekDays,
  jobsByDay,
  technicians,
  ...common
}: BoardCommon & {
  weekDays: Date[];
  jobsByDay: Map<string, Job[]>;
  technicians: TeamMember[];
}) {
  const today = new Date();
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-7">
      {weekDays.map((day) => {
        const jobs = jobsByDay.get(day.toDateString()) ?? [];
        const isToday = isSameDay(day, today);
        return (
          <DropZone
            key={day.toDateString()}
            target={{ kind: 'day', date: toDateKey(day) }}
            label={day.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
            className="flex min-h-[220px] flex-col rounded-2xl border border-border bg-bg-secondary p-3 shadow-card dark:shadow-card-dark"
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
                <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] font-semibold text-text-secondary">{jobs.length}</span>
              )}
            </div>
            <div className="flex flex-1 flex-col gap-2 overflow-y-auto">
              {jobs.length === 0 ? (
                <p className="mt-4 text-center text-xs text-text-secondary/60">No jobs</p>
              ) : (
                jobs.map((job) => (
                  <DraggableCalendarCard
                    key={job.id}
                    job={job}
                    technician={technicians.find((t) => t.id === job.assigned_technician_id) ?? null}
                    color={common.getColor(job.assigned_technician_id)}
                    draggable={common.isDraggable(job)}
                    pending={common.pendingIds.has(job.id)}
                    moveTargets={common.moveTargetsFor(job)}
                    onOpen={common.onCardClick}
                  />
                ))
              )}
            </div>
          </DropZone>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------
// Day view — one drop zone per technician lane (+ Unassigned)
// ------------------------------------------------------------

export function DayLanes({
  lanes,
  laneJobs,
  ...common
}: BoardCommon & {
  lanes: { key: string; technician: TeamMember | null }[];
  laneJobs: Map<string, Job[]>;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {lanes.map((lane) => {
        const jobs = laneJobs.get(lane.key) ?? [];
        const color = common.getColor(lane.technician?.id ?? null);
        const name = lane.technician ? techName(lane.technician) : 'Unassigned';
        return (
          <DropZone
            key={lane.key}
            target={{ kind: 'lane', technicianId: lane.technician?.id ?? null }}
            label={`${name} lane`}
            className="flex min-h-[280px] flex-col rounded-2xl border border-border bg-bg-secondary p-3 shadow-card dark:shadow-card-dark"
          >
            <div className="mb-2.5 flex items-center gap-2">
              <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${color.bg} ${color.text}`}>
                {lane.technician ? initials(name) : <UserIcon size={14} />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-text-primary">{name}</p>
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
                  <DraggableCalendarCard
                    key={job.id}
                    job={job}
                    technician={lane.technician}
                    color={color}
                    draggable={common.isDraggable(job)}
                    pending={common.pendingIds.has(job.id)}
                    moveTargets={common.moveTargetsFor(job)}
                    onOpen={common.onCardClick}
                  />
                ))
              )}
            </div>
          </DropZone>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------
// Unscheduled strip — drop here to pull a job off the calendar
// ------------------------------------------------------------

export function UnscheduledStrip({
  jobs,
  technicians,
  ...common
}: BoardCommon & {
  jobs: Job[];
  technicians: TeamMember[];
}) {
  return (
    <DropZone
      target={{ kind: 'unscheduled' }}
      label="Needs Scheduling"
      className="mt-5 rounded-2xl border border-dashed border-border bg-bg-secondary/60 p-4 shadow-card dark:shadow-card-dark"
    >
      <div className="mb-3 flex items-center gap-2">
        <AlertTriangle size={16} className="text-warning-500" />
        <h3 className="text-sm font-semibold text-text-primary">Needs Scheduling</h3>
        <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] font-semibold text-text-secondary">{jobs.length}</span>
      </div>
      {jobs.length === 0 ? (
        <p className="text-xs text-text-secondary/70">
          Every open job has a date. Drag a job card here to pull it off the schedule without deleting it.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {jobs.map((job) => (
            <DraggableCalendarCard
              key={job.id}
              job={job}
              technician={technicians.find((t) => t.id === job.assigned_technician_id) ?? null}
              color={common.getColor(job.assigned_technician_id)}
              draggable={common.isDraggable(job)}
              pending={common.pendingIds.has(job.id)}
              moveTargets={common.moveTargetsFor(job)}
              onOpen={common.onCardClick}
            />
          ))}
        </div>
      )}
    </DropZone>
  );
}
