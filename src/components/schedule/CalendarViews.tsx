import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  Calendar,
  CalendarDays,
  Check,
  ChevronDown,
  Clock,
  Filter,
  LayoutGrid,
  List,
  MapPin,
  Palette,
  Printer,
  User as UserIcon,
  Users,
} from 'lucide-react';
import type { Job, TeamMember } from '@/lib/supabase';
import { fromDateKey, toDateKey, type MoveTargetOption } from '@/lib/scheduleDnd';
import { DraggableJob, DropZone } from '@/components/schedule/ScheduleDnd';
import {
  COLOR_MODE_OPTIONS,
  VIEW_OPTIONS,
  WEEKDAY_LABELS,
  addDays,
  allStatusOptions,
  buildAgenda,
  buildLegend,
  buildMonthGrid,
  buildResourceWeek,
  formatClock,
  formatClockCompact,
  formatDuration,
  groupJobsByDay,
  isSameMonth,
  jobMinutes,
  moveGridFocus,
  periodLabel,
  resolveJobColor,
  splitOverflow,
  startOfWeekMonday,
  statusColor,
  type AgendaGroupBy,
  type CalendarView,
  type ColorMode,
  type ExtendedView,
  type LegendEntry,
} from '@/lib/calendarViews';

// ============================================================
// Month / Agenda / Resources views for the Dispatch Calendar.
// Week & Day stay in CalendarBoard.tsx. All three views here reuse the same
// ScheduleDnd drop zones (day / lane targets), so drag-and-drop, keyboard
// moves, undo and the double-booking checks behave exactly as in Week/Day.
// ============================================================

const VIEW_ICONS: Record<CalendarView, typeof Calendar> = {
  month: CalendarDays,
  week: LayoutGrid,
  day: Calendar,
  resources: Users,
  agenda: List,
};

const MAX_CHIPS_PER_CELL = 3;
const techName = (t: TeamMember) => t.member_name ?? t.member_email;
const initials = (name: string) =>
  name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

type Lane = { key: string; technician: TeamMember | null };

interface BoardProps {
  isDraggable: (job: Job) => boolean;
  pendingIds: ReadonlySet<string>;
  /** Options for each card's "Move to…" menu. */
  moveTargetsFor: (job: Job) => MoveTargetOption[];
  onCardClick: (job: Job) => void;
}

// ------------------------------------------------------------
// Toolbar pieces
// ------------------------------------------------------------

export function CalendarViewSwitcher({ view, onChange }: { view: CalendarView; onChange: (v: CalendarView) => void }) {
  return (
    <div role="group" aria-label="Calendar view" className="flex rounded-xl border border-border bg-bg-primary p-1">
      {VIEW_OPTIONS.map((opt) => {
        const Icon = VIEW_ICONS[opt.key];
        const active = view === opt.key;
        return (
          <button
            key={opt.key}
            type="button"
            onClick={() => onChange(opt.key)}
            aria-pressed={active}
            aria-keyshortcuts={opt.shortcut}
            title={`${opt.label} view (${opt.shortcut})`}
            className={`focus-ring flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors sm:px-3 ${
              active ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            <Icon size={15} aria-hidden="true" />
            <span className={active ? '' : 'hidden md:inline'}>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function StatusFilter({ value, onChange }: { value: ReadonlySet<string>; onChange: (next: Set<string>) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const options = useMemo(() => allStatusOptions(), []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = (key: string) => {
    const next = new Set(value);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
        className="focus-ring flex items-center gap-1.5 rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
      >
        <Filter size={14} aria-hidden="true" />
        Status
        {value.size > 0 && (
          <span className="rounded-full bg-accent px-1.5 text-[11px] font-semibold text-white">{value.size}</span>
        )}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div
          role="group"
          aria-label="Filter by status"
          className="absolute right-0 z-30 mt-1.5 w-56 rounded-xl border border-border bg-bg-secondary p-2 shadow-card-hover dark:shadow-card-hover-dark"
        >
          {options.map((opt) => {
            const checked = value.has(opt.key);
            return (
              <label key={opt.key} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-text-primary hover:bg-bg-tertiary">
                <input type="checkbox" checked={checked} onChange={() => toggle(opt.key)} className="sr-only" />
                <span
                  aria-hidden="true"
                  className={`flex h-4 w-4 items-center justify-center rounded border ${checked ? 'border-accent bg-accent text-white' : 'border-border'}`}
                >
                  {checked && <Check size={11} />}
                </span>
                <span className={`h-2 w-2 rounded-full ${opt.dot}`} aria-hidden="true" />
                {opt.label}
              </label>
            );
          })}
          <button
            type="button"
            onClick={() => onChange(new Set())}
            disabled={value.size === 0}
            className="focus-ring mt-1 w-full rounded-lg px-2 py-1.5 text-left text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-50"
          >
            Show all statuses
          </button>
        </div>
      )}
    </div>
  );
}

export function CalendarToolbarExtras({
  view,
  colorMode,
  onColorMode,
  statusFilter,
  onStatusFilter,
  agendaGroupBy,
  onAgendaGroupBy,
}: {
  view: CalendarView;
  colorMode: ColorMode;
  onColorMode: (m: ColorMode) => void;
  statusFilter: ReadonlySet<string>;
  onStatusFilter: (next: Set<string>) => void;
  agendaGroupBy: AgendaGroupBy;
  onAgendaGroupBy: (g: AgendaGroupBy) => void;
}) {
  return (
    <>
      <StatusFilter value={statusFilter} onChange={onStatusFilter} />
      <label className="flex items-center gap-1.5 rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-secondary">
        <Palette size={14} aria-hidden="true" />
        <span className="sr-only md:not-sr-only">Color by</span>
        <select
          value={colorMode}
          onChange={(e) => onColorMode(e.target.value as ColorMode)}
          aria-label="Color jobs by"
          className="focus-ring bg-transparent text-sm text-text-primary"
        >
          {COLOR_MODE_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {view === 'agenda' && (
        <label className="flex items-center gap-1.5 rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-secondary">
          Group by
          <select
            value={agendaGroupBy}
            onChange={(e) => onAgendaGroupBy(e.target.value as AgendaGroupBy)}
            className="focus-ring bg-transparent text-sm text-text-primary"
          >
            <option value="date">Date</option>
            <option value="technician">Technician</option>
          </select>
        </label>
      )}
      <button
        type="button"
        onClick={() => window.print()}
        className="focus-ring flex items-center gap-1.5 rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
        title="Print this view"
      >
        <Printer size={14} aria-hidden="true" />
        <span className="hidden md:inline">Print</span>
      </button>
    </>
  );
}

export function CalendarLegend({ entries, label }: { entries: LegendEntry[]; label: string }) {
  if (entries.length === 0) return null;
  return (
    <ul aria-label={`${label} legend`} className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-text-secondary">
      {entries.map((e) => (
        <li key={e.key} className="flex items-center gap-1.5">
          <span className={`h-2.5 w-2.5 rounded-full [print-color-adjust:exact] ${e.dot}`} aria-hidden="true" />
          {e.label}
          <span className="tabular-nums text-text-secondary/70">{e.count}</span>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------
// Compact chip (Month cells, Resource cells)
// ------------------------------------------------------------

function JobChip({
  job,
  colorMode,
  technicians,
  tabbable,
  board,
}: {
  job: Job;
  colorMode: ColorMode;
  technicians: TeamMember[];
  tabbable: boolean;
  board: BoardProps;
}) {
  const color = resolveJobColor(job, colorMode, technicians);
  const status = statusColor(job.job_status);
  const label = `${job.customer_name}${job.service_type ? `, ${job.service_type}` : ''}`;
  return (
    <DraggableJob
      jobId={job.id}
      label={label}
      disabled={!board.isDraggable(job)}
      pending={board.pendingIds.has(job.id)}
      controlsClassName="right-1 top-1/2 -translate-y-1/2"
    >
      <button
        type="button"
        tabIndex={tabbable ? 0 : -1}
        onClick={() => board.onCardClick(job)}
        aria-label={`${formatClock(job.scheduled_datetime)}, ${label}, ${status.label}. Open to reschedule`}
        className="focus-ring relative flex w-full items-center gap-1.5 overflow-hidden rounded-md border border-border bg-bg-primary py-1 pl-2.5 pr-8 text-left text-[11px] leading-tight transition-colors hover:border-accent/40 [print-color-adjust:exact]"
      >
        <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 ${color.dot}`} />
        <span className="shrink-0 font-semibold tabular-nums text-text-secondary">{formatClockCompact(job.scheduled_datetime)}</span>
        <span className="truncate font-medium text-text-primary">{job.customer_name}</span>
      </button>
    </DraggableJob>
  );
}

// ------------------------------------------------------------
// Month view — WAI-ARIA grid with roving tabindex
// ------------------------------------------------------------

function MonthGrid({
  anchorDate,
  onAnchorChange,
  onOpenDay,
  jobs,
  technicians,
  colorMode,
  board,
}: {
  anchorDate: Date;
  onAnchorChange: (d: Date) => void;
  onOpenDay: (d: Date) => void;
  jobs: Job[];
  technicians: TeamMember[];
  colorMode: ColorMode;
  board: BoardProps;
}) {
  const weeks = useMemo(() => buildMonthGrid(anchorDate), [anchorDate]);
  const byDay = useMemo(() => groupJobsByDay(jobs), [jobs]);
  const gridRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const focusKey = toDateKey(anchorDate);
  const monthJobCount = useMemo(
    () => jobs.filter((j) => j.scheduled_datetime && isSameMonth(new Date(j.scheduled_datetime), anchorDate)).length,
    [jobs, anchorDate],
  );

  // After an arrow key changes the anchor (possibly into another month), move DOM focus to the new cell.
  useEffect(() => {
    const key = pendingFocus.current;
    if (!key) return;
    pendingFocus.current = null;
    gridRef.current?.querySelector<HTMLElement>(`[data-day-key="${key}"]`)?.focus();
  }, [anchorDate]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const cell = e.target as HTMLElement;
    const key = cell.getAttribute?.('data-day-key');
    // Only when the cell itself has focus — chips, drag handles and menus keep their own keys.
    if (!key || cell.getAttribute('role') !== 'gridcell') return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpenDay(fromDateKey(key));
      return;
    }
    const next = moveGridFocus(fromDateKey(key), e.key);
    if (!next) return;
    e.preventDefault();
    pendingFocus.current = toDateKey(next);
    onAnchorChange(next);
  };

  return (
    <div>
      <div
        ref={gridRef}
        role="grid"
        aria-label={`${periodLabel('month', anchorDate)} calendar`}
        aria-rowcount={weeks.length + 1}
        onKeyDown={onKeyDown}
        className="overflow-x-auto rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark"
      >
        <div className="min-w-[44rem]">
          <div role="row" className="grid grid-cols-7 border-b border-border">
            {WEEKDAY_LABELS.map((d) => (
              <div key={d} role="columnheader" className="px-2 py-2 text-center text-xs font-semibold uppercase tracking-wide text-text-secondary">
                {d}
              </div>
            ))}
          </div>
          {weeks.map((week, wi) => (
            <div key={week[0].key} role="row" aria-rowindex={wi + 2} className="grid grid-cols-7 [break-inside:avoid]">
              {week.map((cell) => {
                const cellJobs = byDay.get(cell.key) ?? [];
                const { visible, hidden } = splitOverflow(cellJobs, MAX_CHIPS_PER_CELL);
                const isFocus = cell.key === focusKey;
                const longLabel = cell.date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
                return (
                  <div
                    key={cell.key}
                    role="gridcell"
                    data-day-key={cell.key}
                    tabIndex={isFocus ? 0 : -1}
                    aria-selected={isFocus}
                    aria-current={cell.isToday ? 'date' : undefined}
                    aria-label={`${longLabel}, ${cellJobs.length === 0 ? 'no jobs' : `${cellJobs.length} ${cellJobs.length === 1 ? 'job' : 'jobs'}`}`}
                    onClick={(e) => {
                      // Clicking empty space selects the day; chips and buttons keep their own click.
                      if (!(e.target as HTMLElement).closest('button')) onAnchorChange(cell.date);
                    }}
                    className="focus-ring flex min-h-[7.5rem] flex-col border-b border-r border-border/70 outline-none last:border-r-0 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-accent print:min-h-0"
                  >
                    <DropZone
                      target={{ kind: 'day', date: cell.key }}
                      label={longLabel}
                      className={`flex min-h-[7.5rem] flex-1 flex-col gap-1 p-1.5 print:min-h-0 ${
                        cell.inMonth ? (cell.isWeekend ? 'bg-bg-tertiary/40' : '') : 'bg-bg-tertiary/20 opacity-70'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <button
                          type="button"
                          tabIndex={-1}
                          onClick={() => onOpenDay(cell.date)}
                          aria-label={`Open ${longLabel}`}
                          className={`focus-ring flex h-6 min-w-[1.5rem] items-center justify-center rounded-full px-1 text-xs font-semibold tabular-nums ${
                            cell.isToday ? 'bg-accent text-white' : cell.inMonth ? 'text-text-primary hover:bg-bg-tertiary' : 'text-text-secondary'
                          }`}
                        >
                          {cell.date.getDate()}
                        </button>
                        {cellJobs.length > 0 && (
                          <span className="text-[10px] font-semibold tabular-nums text-text-secondary">{cellJobs.length}</span>
                        )}
                      </div>
                      {visible.map((job) => (
                        <JobChip key={job.id} job={job} colorMode={colorMode} technicians={technicians} tabbable={isFocus} board={board} />
                      ))}
                      {/* Screen: "+N more" opens the day. Print: every job is listed, nothing is hidden. */}
                      {hidden > 0 && (
                        <>
                          <button
                            type="button"
                            tabIndex={isFocus ? 0 : -1}
                            onClick={() => onOpenDay(cell.date)}
                            className="focus-ring rounded-md px-1.5 py-0.5 text-left text-[11px] font-semibold text-accent hover:underline print:hidden"
                          >
                            +{hidden} more
                          </button>
                          <div className="hidden flex-col gap-1 print:flex">
                            {cellJobs.slice(MAX_CHIPS_PER_CELL).map((job) => (
                              <JobChip key={job.id} job={job} colorMode={colorMode} technicians={technicians} tabbable={false} board={board} />
                            ))}
                          </div>
                        </>
                      )}
                    </DropZone>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {monthJobCount === 0 && (
        <p className="mt-3 text-center text-sm text-text-secondary">No jobs scheduled in {periodLabel('month', anchorDate)} with the current filters.</p>
      )}
      <p className="mt-3 text-xs text-text-secondary print:hidden">
        Arrow keys move between days · Enter opens the day · Page Up / Page Down change month · T goes to today
      </p>
    </div>
  );
}

// ------------------------------------------------------------
// Agenda view — grouped list (by date or technician)
// ------------------------------------------------------------

function AgendaRow({
  job,
  technicians,
  colorMode,
  board,
}: {
  job: Job;
  technicians: TeamMember[];
  colorMode: ColorMode;
  board: BoardProps;
}) {
  const color = resolveJobColor(job, colorMode, technicians);
  const status = statusColor(job.job_status);
  const tech = technicians.find((t) => t.id === job.assigned_technician_id) ?? null;
  const label = `${job.customer_name}${job.service_type ? `, ${job.service_type}` : ''}`;
  const start = job.scheduled_datetime ? new Date(job.scheduled_datetime) : null;
  return (
    <DraggableJob
      jobId={job.id}
      label={label}
      disabled={!board.isDraggable(job)}
      pending={board.pendingIds.has(job.id)}
      moveTargets={board.moveTargetsFor(job)}
      controlsClassName="right-2 top-2"
      className="[break-inside:avoid]"
    >
      <button
        type="button"
        onClick={() => board.onCardClick(job)}
        className="focus-ring relative grid w-full grid-cols-[5.5rem_1fr] gap-3 overflow-hidden rounded-xl border border-border bg-bg-primary py-2.5 pl-4 pr-16 text-left transition-colors hover:border-accent/40 sm:grid-cols-[6.5rem_1fr_auto] [print-color-adjust:exact]"
      >
        <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1.5 ${color.dot}`} />
        <span className="flex flex-col text-xs text-text-secondary">
          <span className="flex items-center gap-1 font-semibold text-text-primary">
            <Clock size={12} aria-hidden="true" />
            {formatClock(job.scheduled_datetime)}
          </span>
          <span>{formatDuration(jobMinutes(job))}</span>
          {start && <span className="sm:hidden">{start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-text-primary">{job.customer_name}</span>
          {job.service_type && <span className="block truncate text-xs text-text-secondary">{job.service_type}</span>}
          {job.address && (
            <span className="mt-0.5 flex items-center gap-1 truncate text-xs text-text-secondary/80">
              <MapPin size={11} className="shrink-0" aria-hidden="true" /> {job.address}
            </span>
          )}
        </span>
        <span className="col-span-2 flex flex-wrap items-center gap-2 text-xs sm:col-span-1 sm:flex-col sm:items-end sm:justify-center">
          <span className="flex items-center gap-1.5 text-text-secondary">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-bg-tertiary text-[10px] font-bold">
              {tech ? initials(techName(tech)) : <UserIcon size={11} aria-hidden="true" />}
            </span>
            {tech ? techName(tech) : 'Unassigned'}
          </span>
          <span className="flex items-center gap-1.5 rounded-full bg-bg-tertiary px-2 py-0.5 font-medium text-text-secondary">
            <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} aria-hidden="true" />
            {status.label}
          </span>
        </span>
      </button>
    </DraggableJob>
  );
}

function AgendaList({
  anchorDate,
  jobs,
  technicians,
  lanes,
  groupBy,
  colorMode,
  board,
}: {
  anchorDate: Date;
  jobs: Job[];
  technicians: TeamMember[];
  lanes: Lane[];
  groupBy: AgendaGroupBy;
  colorMode: ColorMode;
  board: BoardProps;
}) {
  const sections = useMemo(() => buildAgenda(jobs, anchorDate, groupBy, lanes), [jobs, anchorDate, groupBy, lanes]);

  if (sections.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-bg-secondary/60 px-6 py-12 text-center">
        <p className="text-sm font-semibold text-text-primary">Nothing scheduled in {periodLabel('agenda', anchorDate)}</p>
        <p className="mt-1 text-xs text-text-secondary">Try another month, or clear the technician / status filters.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {sections.map((section) => {
        const headingId = `agenda-${section.key}`;
        const target =
          groupBy === 'date'
            ? ({ kind: 'day', date: section.key } as const)
            : ({ kind: 'lane', technicianId: section.technician?.id ?? null } as const);
        const body = (
          <>
            <div className="mb-2.5 flex items-baseline justify-between gap-2">
              <h3 id={headingId} className="text-sm font-bold text-text-primary">
                {section.title}
              </h3>
              <span className="text-xs text-text-secondary">{section.subtitle}</span>
            </div>
            <ul aria-labelledby={headingId} className="space-y-2">
              {section.jobs.map((job) => (
                <li key={job.id}>
                  <AgendaRow job={job} technicians={technicians} colorMode={colorMode} board={board} />
                </li>
              ))}
            </ul>
          </>
        );
        // The synthetic "other technicians" section has no real lane to drop onto.
        return section.key === 'other' ? (
          <section key={section.key} className="rounded-2xl border border-border bg-bg-secondary p-3 shadow-card dark:shadow-card-dark">
            {body}
          </section>
        ) : (
          <DropZone
            key={section.key}
            target={target}
            label={section.title}
            className="rounded-2xl border border-border bg-bg-secondary p-3 shadow-card dark:shadow-card-dark [break-inside:avoid-page]"
          >
            {body}
          </DropZone>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------
// Resources view — one lane per technician across the week
// ------------------------------------------------------------

function ResourceWeek({
  anchorDate,
  onOpenDay,
  jobs,
  technicians,
  lanes,
  colorMode,
  board,
}: {
  anchorDate: Date;
  onOpenDay: (d: Date) => void;
  jobs: Job[];
  technicians: TeamMember[];
  lanes: Lane[];
  colorMode: ColorMode;
  board: BoardProps;
}) {
  const weekDays = useMemo(() => {
    const start = startOfWeekMonday(anchorDate);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [anchorDate]);
  const rows = useMemo(() => buildResourceWeek(jobs, weekDays, lanes), [jobs, weekDays, lanes]);
  const today = toDateKey(new Date());
  const cols = 'grid grid-cols-[10rem_repeat(7,minmax(8.5rem,1fr))]';

  return (
    <div className="overflow-x-auto rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark">
      <div className="min-w-[70rem]">
        <div className={`${cols} border-b border-border`}>
          <div className="sticky left-0 z-10 bg-bg-secondary px-3 py-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Resource</div>
          {weekDays.map((d) => {
            const key = toDateKey(d);
            return (
              <button
                key={key}
                type="button"
                onClick={() => onOpenDay(d)}
                aria-label={`Open ${d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}`}
                className={`focus-ring px-2 py-2 text-center text-xs font-semibold ${key === today ? 'text-accent' : 'text-text-secondary hover:text-text-primary'}`}
              >
                {d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
              </button>
            );
          })}
        </div>
        {rows.map((row) => {
          const name = row.technician ? techName(row.technician) : 'Unassigned';
          return (
            <DropZone
              key={row.key}
              target={{ kind: 'lane', technicianId: row.technician?.id ?? null }}
              label={`${name} lane`}
              className="border-b border-border/70 last:border-b-0 [break-inside:avoid]"
            >
              <div role="group" aria-label={`${name}, ${row.totalJobs} ${row.totalJobs === 1 ? 'job' : 'jobs'} this week`} className={cols}>
                <div className="sticky left-0 z-10 flex items-center gap-2 bg-bg-secondary px-3 py-2.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg-tertiary text-xs font-bold text-text-secondary">
                    {row.technician ? initials(name) : <UserIcon size={14} aria-hidden="true" />}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-text-primary">{name}</p>
                    <p className="text-xs text-text-secondary">
                      {row.totalJobs} {row.totalJobs === 1 ? 'job' : 'jobs'} · {formatDuration(row.totalMinutes)}
                    </p>
                  </div>
                </div>
                {row.cells.map((cell) => (
                  <div key={cell.key} className={`flex min-h-[5rem] flex-col gap-1 border-l border-border/60 p-1.5 ${cell.key === today ? 'bg-accent/5' : ''}`}>
                    {cell.overbooked && (
                      <span className="rounded bg-danger/10 px-1.5 py-0.5 text-[10px] font-semibold text-danger">
                        Over capacity ({cell.jobs.length}/{row.technician?.max_jobs_per_day})
                      </span>
                    )}
                    {cell.jobs.map((job) => (
                      <JobChip key={job.id} job={job} colorMode={colorMode} technicians={technicians} tabbable board={board} />
                    ))}
                  </div>
                ))}
              </div>
            </DropZone>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Entry point used by CalendarPage for month / agenda / resources
// ------------------------------------------------------------

// Landscape pages, exact colours, no scrolling boxes. Mounted only while an extended view is on screen,
// so Week/Day printing is untouched.
const PRINT_CSS = `
@media print {
  @page { size: landscape; margin: 1cm; }
  [data-calendar-print] * { overflow: visible !important; max-height: none !important; }
  [data-calendar-print] [role="grid"], [data-calendar-print] .min-w-\\[44rem\\], [data-calendar-print] .min-w-\\[70rem\\] { min-width: 0 !important; }
}`;

export function CalendarExtendedViews({
  view,
  anchorDate,
  onAnchorChange,
  onOpenDay,
  jobs,
  technicians,
  lanes,
  colorMode,
  agendaGroupBy,
  filterSummary,
  ...board
}: BoardProps & {
  view: ExtendedView;
  anchorDate: Date;
  onAnchorChange: (d: Date) => void;
  onOpenDay: (d: Date) => void;
  /** Scheduled jobs after the page's technician + status filters. */
  jobs: Job[];
  technicians: TeamMember[];
  lanes: Lane[];
  colorMode: ColorMode;
  agendaGroupBy: AgendaGroupBy;
  /** e.g. "Maria Lopez · Scheduled, In progress" — printed under the title. */
  filterSummary?: string;
}) {
  const legend = useMemo(() => buildLegend(jobs, colorMode, technicians), [jobs, colorMode, technicians]);
  const legendLabel = COLOR_MODE_OPTIONS.find((o) => o.key === colorMode)?.label ?? 'Status';
  const viewLabel = VIEW_OPTIONS.find((v) => v.key === view)?.label ?? '';

  return (
    <div data-calendar-print>
      <style>{PRINT_CSS}</style>
      <div className="mb-3 hidden print:block">
        <h2 className="text-lg font-bold text-black">
          Dispatch Calendar — {viewLabel} · {periodLabel(view, anchorDate)}
        </h2>
        <p className="text-xs text-black/70">
          {filterSummary ? `${filterSummary} · ` : ''}Printed {new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
        </p>
      </div>
      <CalendarLegend entries={legend} label={legendLabel} />
      {view === 'month' && (
        <MonthGrid
          anchorDate={anchorDate}
          onAnchorChange={onAnchorChange}
          onOpenDay={onOpenDay}
          jobs={jobs}
          technicians={technicians}
          colorMode={colorMode}
          board={board}
        />
      )}
      {view === 'agenda' && (
        <AgendaList
          anchorDate={anchorDate}
          jobs={jobs}
          technicians={technicians}
          lanes={lanes}
          groupBy={agendaGroupBy}
          colorMode={colorMode}
          board={board}
        />
      )}
      {view === 'resources' && (
        <ResourceWeek
          anchorDate={anchorDate}
          onOpenDay={onOpenDay}
          jobs={jobs}
          technicians={technicians}
          lanes={lanes}
          colorMode={colorMode}
          board={board}
        />
      )}
    </div>
  );
}
