// src/components/wallboard/WallboardPanels.tsx
//
// Presentational panels for the dispatch TV. Everything is sized in `em` so the
// whole board scales from one root font-size set by the page (readable from
// across a room on a 1080p or 4K screen). Colours are fixed (dark) on purpose:
// a wall display must look the same regardless of the app theme.

import type { ReactNode } from 'react';
import { Banknote, MapPin, PhoneMissed, Truck, TriangleAlert, Wrench } from 'lucide-react';
import {
  JOB_COLUMNS,
  TECH_STATUS_META,
  formatAge,
  formatMoney,
  formatMoneyCompact,
  formatSla,
  formatTimeOfDay,
  groupJobs,
  projectPoints,
  revenuePace,
  type JobCounts,
  type TechStatus,
  type WallJob,
  type WallboardSnapshot,
} from '@/lib/wallboard';

const TONE: Record<'success' | 'accent' | 'warning' | 'muted' | 'danger', string> = {
  success: 'bg-success-subtle text-success ring-success/30',
  accent: 'bg-info-subtle text-info ring-info/30',
  warning: 'bg-warning-subtle text-warning ring-warning/30',
  muted: 'bg-text-muted/15 text-text-secondary ring-border-strong/30',
  danger: 'bg-danger-subtle text-danger ring-danger/40',
};

const DOT: Record<TechStatus, string> = {
  on_site: '#67d97a',
  en_route: '#64aeff',
  driving: '#64aeff',
  available: '#ffcc00',
  offline: '#73726c',
};

const PER_COLUMN = 6;

interface PanelProps {
  snapshot: WallboardSnapshot;
  nowMs: number;
}

function Chip({ tone, children }: { tone: keyof typeof TONE; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-[0.7em] py-[0.15em] text-[0.7em] font-semibold ring-1 ${TONE[tone]}`}>{children}</span>;
}

function PanelTitle({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <h2 className="mb-[0.6em] flex items-center gap-[0.5em] text-[1.35em] font-semibold tracking-tight text-text-muted">
      {icon}
      {children}
    </h2>
  );
}

const fillWord = (s: string) => s.replace(/_/g, ' ');

// ------------------------------------------------------------------ KPI strip

export function KpiStrip({ snapshot }: { snapshot: WallboardSnapshot }) {
  const { jobCounts, technicians, emergencies, calls, revenue } = snapshot;
  const pace = revenuePace(revenue);
  const activeTechs = technicians.filter((t) => t.status === 'on_site' || t.status === 'en_route' || t.status === 'driving').length;
  const doneOf = `${jobCounts.completed}/${jobCounts.total - jobCounts.cancelled}`;

  const tiles: Array<{ key: string; label: string; value: string; sub: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' }> = [
    { key: 'jobs', label: 'Jobs done', value: doneOf, sub: jobCounts.late > 0 ? `${jobCounts.late} late` : 'On schedule', tone: jobCounts.late > 0 ? 'warn' : 'ok' },
    { key: 'techs', label: 'Techs working', value: `${activeTechs}/${technicians.length}`, sub: 'on site, en route or driving', tone: 'neutral' },
    { key: 'emerg', label: 'Open emergencies', value: String(emergencies.length), sub: emergencies.length === 0 ? 'All clear' : 'Needs attention', tone: emergencies.length > 0 ? 'bad' : 'ok' },
    { key: 'missed', label: 'Missed calls', value: String(calls.missedToday), sub: `of ${calls.totalToday} today`, tone: calls.missedToday > 0 ? 'warn' : 'ok' },
    {
      key: 'rev',
      label: 'Revenue today',
      value: formatMoneyCompact(revenue.today),
      sub: pace.status === 'no_goal' ? 'No goal set' : `${pace.pctOfGoal}% of month goal`,
      tone: pace.status === 'behind' ? 'warn' : pace.status === 'no_goal' ? 'neutral' : 'ok',
    },
  ];
  const border = { ok: 'border-success/30', warn: 'border-warning/50', bad: 'border-danger/70 animate-pulse', neutral: 'border-border-strong/60' } as const;

  return (
    <div className="grid grid-cols-5 gap-[0.8em]" role="list" aria-label="Key numbers">
      {tiles.map((t) => (
        <div key={t.key} role="listitem" className={`rounded-[0.9em] border bg-overlay/70 px-[1em] py-[0.7em] ${border[t.tone]}`}>
          <p className="text-[0.75em] font-medium uppercase tracking-wider text-text-muted">{t.label}</p>
          <p className="text-[2.3em] font-bold leading-tight tabular-nums text-white">{t.value}</p>
          <p className="truncate text-[0.75em] text-text-muted">{t.sub}</p>
        </div>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------------- Jobs

function JobCard({ job, tz }: { job: WallJob; tz: string }) {
  return (
    <li className={`rounded-[0.7em] border px-[0.8em] py-[0.55em] ${job.late ? 'border-warning/60 bg-warning-subtle' : 'border-border-inverse/70 bg-surface-inverse/60'}`}>
      <div className="flex items-baseline justify-between gap-[0.5em]">
        <span className="truncate text-[1.05em] font-semibold text-white">{job.customer}</span>
        <span className="shrink-0 text-[0.85em] tabular-nums text-text-muted">{formatTimeOfDay(job.scheduledAt, tz)}</span>
      </div>
      <div className="flex items-center justify-between gap-[0.5em] text-[0.8em] text-text-muted">
        <span className="truncate">{job.service ?? 'Service call'}</span>
        <span className="shrink-0">{job.late ? <span className="font-bold text-warning">Late ·  </span> : null}{job.technician ?? 'Unassigned'}</span>
      </div>
    </li>
  );
}

function jobsFor(counts: JobCounts, status: string): number {
  switch (status) {
    case 'in_progress':
      return counts.inProgress;
    case 'en_route':
      return counts.enRoute;
    case 'scheduled':
      return counts.scheduled;
    default:
      return counts.completed;
  }
}

export function JobsPanel({ snapshot }: PanelProps) {
  const grouped = groupJobs(snapshot.jobs, PER_COLUMN);
  if (snapshot.jobCounts.total === 0) return <BigMessage icon={<Wrench />} title="No jobs scheduled today" sub="New jobs appear here the moment they are booked." />;
  return (
    <section aria-label="Today's jobs">
      <PanelTitle icon={<Wrench className="h-[1em] w-[1em]" />}>Today&apos;s jobs</PanelTitle>
      <div className="grid grid-cols-4 gap-[0.9em]">
        {JOB_COLUMNS.map((col) => {
          const g = grouped[col.status];
          const total = jobsFor(snapshot.jobCounts, col.status);
          const more = Math.max(0, total - g.items.length);
          return (
            <div key={col.status} className="min-w-0">
              <div className="mb-[0.5em] flex items-baseline justify-between border-b border-border-strong pb-[0.3em]">
                <h3 className="text-[1.05em] font-semibold text-on-inverse">{col.label}</h3>
                <span className="text-[1.6em] font-bold tabular-nums text-white">{total}</span>
              </div>
              <ul className="space-y-[0.5em]">
                {g.items.map((j) => (
                  <JobCard key={j.id} job={j} tz={snapshot.timezone} />
                ))}
              </ul>
              {more > 0 && <p className="mt-[0.5em] text-[0.85em] text-text-muted">+{more} more</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- Technicians

export function TechniciansPanel({ snapshot, nowMs }: PanelProps) {
  const { technicians } = snapshot;
  if (technicians.length === 0) return <BigMessage icon={<Truck />} title="No technicians on the board" sub="Technicians with a GPS vehicle or a job today appear here." />;

  const located = technicians.filter((t) => t.lat !== null && t.lng !== null && t.status !== 'offline');
  const W = 640;
  const H = 440;
  const points = projectPoints(located.map((t) => ({ id: t.id, lat: t.lat as number, lng: t.lng as number })), W, H, 40);
  const byId = new Map(points.map((p) => [p.id, p]));

  return (
    <section aria-label="Technicians" className="grid grid-cols-[1.2fr_1fr] gap-[1em]">
      <div className="min-w-0">
        <PanelTitle icon={<Truck className="h-[1em] w-[1em]" />}>Technicians</PanelTitle>
        <ul className="grid grid-cols-2 gap-[0.6em]">
          {technicians.slice(0, 12).map((t) => {
            const meta = TECH_STATUS_META[t.status];
            return (
              <li key={t.id} className="rounded-[0.7em] border border-border-inverse/70 bg-surface-inverse/60 px-[0.8em] py-[0.6em]">
                <div className="flex items-center justify-between gap-[0.5em]">
                  <span className="truncate text-[1.1em] font-semibold text-white">{t.name}</span>
                  <Chip tone={meta.tone}>{meta.label}</Chip>
                </div>
                <p className="mt-[0.15em] truncate text-[0.85em] text-text-muted">
                  {t.jobCustomer ? `${t.jobCustomer} · ${t.jobService ?? 'Service call'}` : t.status === 'offline' ? 'No recent GPS signal' : 'No active job'}
                </p>
                <p className="flex items-center gap-[0.3em] truncate text-[0.75em] text-text-muted">
                  <MapPin className="h-[0.9em] w-[0.9em] shrink-0" />
                  <span className="truncate">{t.place ?? 'Location unavailable'}</span>
                  <span className="shrink-0">· {formatAge(t.lastFixAt, nowMs)}</span>
                </p>
              </li>
            );
          })}
        </ul>
        {technicians.length > 12 && <p className="mt-[0.5em] text-[0.85em] text-text-muted">+{technicians.length - 12} more</p>}
      </div>

      <div className="rounded-[0.9em] border border-border-inverse/70 bg-overlay/70 p-[0.6em]">
        <p className="mb-[0.3em] text-[0.75em] font-medium uppercase tracking-wider text-text-muted">Live positions</p>
        {points.length === 0 ? (
          <p className="flex h-[16em] items-center justify-center text-[0.95em] text-text-muted">No live GPS fixes right now.</p>
        ) : (
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Live positions of ${points.length} technicians`}>
            <defs>
              <pattern id="wb-grid" width="40" height="40" patternUnits="userSpaceOnUse">
                <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgb(var(--text-primary))" strokeWidth="1" />
              </pattern>
            </defs>
            <rect width={W} height={H} fill="url(#wb-grid)" />
            {located.map((t) => {
              const p = byId.get(t.id);
              if (!p) return null;
              return (
                <g key={t.id} transform={`translate(${p.x} ${p.y})`}>
                  <circle r="16" fill={DOT[t.status]} opacity="0.25" />
                  <circle r="8" fill={DOT[t.status]} />
                  <text y="-18" textAnchor="middle" fontSize="18" fontWeight="600" fill="rgb(var(--border-default))">
                    {t.name.split(' ')[0]}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
        <p className="mt-[0.3em] text-[0.7em] text-text-muted">Relative positions only. North is up.</p>
      </div>
    </section>
  );
}

// ----------------------------------------------------------------- Emergencies

export function EmergenciesPanel({ snapshot, nowMs }: PanelProps) {
  const list = snapshot.emergencies;
  if (list.length === 0) return <BigMessage icon={<TriangleAlert />} title="No open emergencies" sub="Everything is under control." />;
  return (
    <section aria-label="Open emergencies">
      <PanelTitle icon={<TriangleAlert className="h-[1em] w-[1em] text-danger" />}>Open emergencies</PanelTitle>
      <ul className="grid grid-cols-2 gap-[0.8em]">
        {list.slice(0, 8).map((e) => {
          const sla = formatSla(e.slaDueAt, nowMs);
          const hot = e.severity === 'critical' || e.slaBreached || sla.overdue;
          return (
            <li key={e.id} className={`rounded-[0.9em] border px-[1em] py-[0.8em] ${hot ? 'border-danger/70 bg-danger-subtle' : 'border-warning/50 bg-warning-subtle'}`}>
              <div className="flex items-center justify-between gap-[0.5em]">
                <Chip tone={e.severity === 'critical' ? 'danger' : e.severity === 'high' ? 'warning' : 'muted'}>{e.severity.toUpperCase()}</Chip>
                <span className={`text-[1.1em] font-bold tabular-nums ${sla.overdue ? 'text-danger' : 'text-on-inverse'}`}>{sla.text}</span>
              </div>
              <p className="mt-[0.4em] truncate text-[1.4em] font-bold text-white">{e.customer}</p>
              <p className="truncate text-[0.9em] capitalize text-text-muted">
                {e.trade} · {fillWord(e.status)}
              </p>
              <p className={`mt-[0.2em] text-[0.9em] font-semibold ${e.technician ? 'text-success' : 'animate-pulse text-danger'}`}>
                {e.technician ? `Assigned: ${e.technician}` : 'UNASSIGNED'}
              </p>
            </li>
          );
        })}
      </ul>
      {list.length > 8 && <p className="mt-[0.5em] text-[0.9em] text-text-muted">+{list.length - 8} more open</p>}
    </section>
  );
}

// ----------------------------------------------------------------------- Calls

export function CallsPanel({ snapshot }: PanelProps) {
  const { calls, timezone } = snapshot;
  const rate = calls.totalToday > 0 ? Math.round((calls.missedToday / calls.totalToday) * 100) : null;
  return (
    <section aria-label="Missed calls" className="grid grid-cols-[1fr_1.4fr] gap-[1.2em]">
      <div>
        <PanelTitle icon={<PhoneMissed className="h-[1em] w-[1em]" />}>Missed calls today</PanelTitle>
        <p className={`text-[7em] font-bold leading-none tabular-nums ${calls.missedToday > 0 ? 'text-warning' : 'text-success'}`}>{calls.missedToday}</p>
        <p className="mt-[0.4em] text-[1.1em] text-text-muted">
          {rate === null ? 'No calls yet today' : `${rate}% of ${calls.totalToday} calls`}
        </p>
        {calls.emergencyToday > 0 && <p className="mt-[0.3em] text-[1em] font-semibold text-danger">{calls.emergencyToday} emergency call{calls.emergencyToday === 1 ? '' : 's'} today</p>}
      </div>
      <div>
        <p className="mb-[0.5em] text-[0.8em] font-medium uppercase tracking-wider text-text-muted">Most recent</p>
        {calls.recentMissed.length === 0 ? (
          <p className="rounded-[0.9em] border border-success/30 bg-success-subtle px-[1em] py-[1.2em] text-[1.2em] text-success">Every call was answered today.</p>
        ) : (
          <ul className="space-y-[0.5em]">
            {calls.recentMissed.slice(0, 7).map((m) => (
              <li key={m.id} className="flex items-center justify-between rounded-[0.7em] border border-border-inverse/70 bg-surface-inverse/60 px-[0.9em] py-[0.55em]">
                <span className="truncate text-[1.15em] font-semibold text-white">{m.caller}</span>
                <span className="shrink-0 text-[1em] tabular-nums text-text-muted">{formatTimeOfDay(m.at, timezone)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// --------------------------------------------------------------------- Revenue

const PACE_TEXT = {
  ahead: { tone: 'success', label: 'Ahead of pace' },
  on_track: { tone: 'success', label: 'On track' },
  behind: { tone: 'warning', label: 'Behind pace' },
  no_goal: { tone: 'muted', label: 'No goal set' },
} as const;

export function RevenuePanel({ snapshot }: PanelProps) {
  const { revenue } = snapshot;
  const pace = revenuePace(revenue);
  const meta = PACE_TEXT[pace.status];
  const fillPct = pace.goal ? Math.min(100, (revenue.mtd / pace.goal) * 100) : 0;
  const markerPct = pace.goal ? Math.min(100, (pace.expectedToDate / pace.goal) * 100) : 0;
  const maxDay = Math.max(1, ...revenue.daily.map((d) => d.amount));

  return (
    <section aria-label="Revenue versus goal">
      <PanelTitle icon={<Banknote className="h-[1em] w-[1em]" />}>Revenue vs goal</PanelTitle>
      <div className="grid grid-cols-[1.3fr_1fr] gap-[1.2em]">
        <div>
          <p className="text-[0.8em] uppercase tracking-wider text-text-muted">Collected this month</p>
          <p className="text-[5em] font-bold leading-none tabular-nums text-white">{formatMoney(revenue.mtd)}</p>
          {pace.goal ? (
            <>
              <div className="relative mt-[0.9em] h-[1.2em] overflow-hidden rounded-full bg-surface-inverse" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, pace.pctOfGoal)} aria-label="Month-to-date revenue against goal">
                <div className={`h-full rounded-full ${pace.status === 'behind' ? 'bg-warning' : 'bg-success'}`} style={{ width: `${fillPct}%` }} />
                <div className="absolute top-0 h-full w-[0.2em] bg-bg-secondary/80" style={{ left: `${markerPct}%` }} title="Where you should be today" />
              </div>
              <div className="mt-[0.4em] flex items-center justify-between text-[1em] text-text-muted">
                <span>
                  {pace.pctOfGoal}% of {formatMoney(pace.goal)}
                </span>
                <Chip tone={meta.tone}>
                  {meta.label}
                  {pace.status === 'no_goal' ? '' : ` · ${pace.paceDelta >= 0 ? '+' : '-'}${formatMoneyCompact(Math.abs(pace.paceDelta))}`}
                </Chip>
              </div>
            </>
          ) : (
            <p className="mt-[0.9em] text-[1.05em] text-text-muted">Set a monthly revenue goal in Wallboard settings to track pace.</p>
          )}
        </div>
        <div>
          <p className="text-[0.8em] uppercase tracking-wider text-text-muted">Today</p>
          <p className="text-[3em] font-bold leading-none tabular-nums text-white">{formatMoney(revenue.today)}</p>
          {pace.goal && <p className="mt-[0.2em] text-[0.95em] text-text-muted">{pace.todayPct}% of today&apos;s {formatMoneyCompact(pace.dailyTarget)} target</p>}
          <div className="mt-[0.9em] flex h-[6em] items-end gap-[0.4em]" role="img" aria-label="Revenue for the last 7 days">
            {revenue.daily.map((d, i) => (
              <div key={d.day || i} className="flex flex-1 flex-col items-center justify-end">
                <div className={`w-full rounded-t ${i === revenue.daily.length - 1 ? 'bg-info' : 'bg-text-muted'}`} style={{ height: `${Math.max(4, (d.amount / maxDay) * 100)}%` }} />
              </div>
            ))}
          </div>
          <p className="mt-[0.2em] text-[0.7em] text-text-muted">Last 7 days</p>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------- Shared

export function BigMessage({ icon, title, sub }: { icon: ReactNode; title: string; sub: string }) {
  return (
    <div className="flex h-[18em] flex-col items-center justify-center gap-[0.4em] text-center text-text-muted">
      <span className="h-[3em] w-[3em] [&>svg]:h-full [&>svg]:w-full">{icon}</span>
      <p className="text-[1.8em] font-semibold text-white">{title}</p>
      <p className="text-[1.05em] text-text-muted">{sub}</p>
    </div>
  );
}
