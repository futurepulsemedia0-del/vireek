import { supabase } from '@/lib/supabase';
import {
  addDaysIso,
  friendlyError,
  todayIso,
  type InstallProject,
  type ProjectMilestone,
  type ProjectPhase,
} from '@/lib/installProjects';
import type { ProjectBundle } from '@/lib/installProjectsApi';
import type { BlackoutRange, CrewBooking, DepType, PhaseCrewRow, PhaseDependency, TimeOffRange } from '@/lib/projectScheduler';

// Project Scheduler data layer. Every query is scoped to the account owner
// (`user_id = ownerId`) on top of RLS. Reads of OTHER commitments (other
// projects' phases, work-order visits, jobs, time off, blackouts) are
// best-effort: if one source is unavailable the Gantt still loads and the
// missing source is listed in `notes`.

type Res<T> = { data: T | null; error: { message: string } | null };

function unwrap<T>(res: Res<T>, fallback: string): T {
  if (res.error) throw new Error(friendlyError(res.error, fallback));
  return res.data as T;
}

async function soft<T>(run: () => PromiseLike<Res<T>>, fallback: T, label: string, notes: string[]): Promise<T> {
  try {
    const res = await run();
    if (res.error) throw new Error(res.error.message);
    return res.data ?? fallback;
  } catch {
    notes.push(label);
    return fallback;
  }
}

export interface TechnicianOption {
  id: string;
  name: string;
  role: string | null;
}

export interface ProjectSharing {
  token: string;
  enabled: boolean;
  show_dates: boolean;
}

export interface SchedulerData {
  dependencies: PhaseDependency[];
  crew: PhaseCrewRow[];
  technicians: TechnicianOption[];
  bookings: CrewBooking[];
  timeOff: TimeOffRange[];
  blackouts: BlackoutRange[];
  sharing: ProjectSharing | null;
  /** Optional sources that could not be loaded (shown as a soft notice). */
  notes: string[];
}

const localDay = (stamp: string): string => todayIso(new Date(stamp));

export async function fetchSchedulerData(ownerId: string, bundle: ProjectBundle): Promise<SchedulerData> {
  const projectId = bundle.project.id;
  const scoped = (table: string) => supabase.from(table).select('*').eq('user_id', ownerId).eq('project_id', projectId);

  const [deps, crew, members, sharing] = await Promise.all([
    scoped('install_phase_dependencies').order('created_at'),
    scoped('install_phase_crews').order('created_at'),
    supabase.from('team_members').select('id, member_name, member_email, role').eq('account_owner_id', ownerId).order('member_name').limit(500),
    supabase.from('install_project_shares').select('token, enabled, show_dates').eq('user_id', ownerId).eq('project_id', projectId).maybeSingle(),
  ]);

  const dependencies = unwrap(deps as Res<PhaseDependency[]>, 'Could not load phase links.') ?? [];
  const crewRows = unwrap(crew as Res<PhaseCrewRow[]>, 'Could not load crews.') ?? [];
  const technicians = (unwrap(members as Res<{ id: string; member_name: string | null; member_email: string; role: string | null }[]>, 'Could not load your team.') ?? []).map(
    (m): TechnicianOption => ({ id: m.id, name: m.member_name?.trim() || m.member_email, role: m.role }),
  );
  const sharingRow = unwrap(sharing as Res<ProjectSharing>, 'Could not load sharing.');

  const notes: string[] = [];
  const today = todayIso();
  const dates = bundle.phases.flatMap((p) => [p.planned_start, p.planned_end]).filter((d): d is string => !!d);
  const from = addDaysIso([today, ...dates].reduce((a, b) => (a < b ? a : b)), -30);
  const to = addDaysIso([today, ...dates].reduce((a, b) => (a > b ? a : b)), 60);
  const techIds = [...new Set(crewRows.map((c) => c.technician_id))];

  let bookings: CrewBooking[] = [];
  let timeOff: TimeOffRange[] = [];
  let blackouts: BlackoutRange[] = [];

  if (techIds.length) {
    const ownJobs = new Set(bundle.jobs.map((j) => j.job_id));
    const [phaseBookings, visits, jobs, off] = await Promise.all([
      loadOtherPhases(ownerId, projectId, techIds, from, to, notes),
      soft(
        () =>
          supabase
            .from('work_order_visits')
            .select('id, assigned_technician_id, scheduled_start, scheduled_end')
            .eq('user_id', ownerId)
            .in('assigned_technician_id', techIds)
            .in('status', ['scheduled', 'in_progress'])
            .gte('scheduled_start', `${from}T00:00:00`)
            .lte('scheduled_start', `${to}T23:59:59`)
            .limit(2000) as unknown as PromiseLike<Res<{ id: string; assigned_technician_id: string; scheduled_start: string; scheduled_end: string | null }[]>>,
        [],
        'work-order visits',
        notes,
      ),
      soft(
        () =>
          supabase
            .from('jobs')
            .select('id, assigned_technician_id, scheduled_datetime')
            .eq('user_id', ownerId)
            .in('assigned_technician_id', techIds)
            .in('job_status', ['scheduled', 'en_route', 'in_progress'])
            .gte('scheduled_datetime', `${from}T00:00:00`)
            .lte('scheduled_datetime', `${to}T23:59:59`)
            .limit(2000) as unknown as PromiseLike<Res<{ id: string; assigned_technician_id: string; scheduled_datetime: string }[]>>,
        [],
        'scheduled jobs',
        notes,
      ),
      soft(
        () =>
          supabase
            .from('technician_time_off')
            .select('technician_id, start_date, end_date, kind')
            .eq('user_id', ownerId)
            .eq('status', 'approved')
            .in('technician_id', techIds)
            .lte('start_date', to)
            .gte('end_date', from) as unknown as PromiseLike<Res<TimeOffRange[]>>,
        [],
        'time off',
        notes,
      ),
    ]);
    timeOff = off;
    bookings = [
      ...phaseBookings,
      ...visits.map((v): CrewBooking => ({ id: v.id, technician_id: v.assigned_technician_id, kind: 'work_order', label: 'Work-order visit', start: localDay(v.scheduled_start), end: localDay(v.scheduled_end ?? v.scheduled_start) })),
      ...jobs.filter((j) => !ownJobs.has(j.id)).map((j): CrewBooking => ({ id: j.id, technician_id: j.assigned_technician_id, kind: 'job', label: 'Job', start: localDay(j.scheduled_datetime), end: localDay(j.scheduled_datetime) })),
    ];
  }

  blackouts = await soft(
    () =>
      supabase
        .from('company_blackout_dates')
        .select('label, start_date, end_date')
        .eq('user_id', ownerId)
        .eq('status', 'active')
        .lte('start_date', to)
        .gte('end_date', from) as unknown as PromiseLike<Res<BlackoutRange[]>>,
    [],
    'company blackout dates',
    notes,
  );

  return { dependencies, crew: crewRows, technicians, bookings, timeOff, blackouts, sharing: sharingRow ?? null, notes };
}

/** Phases of OTHER projects that use the same crew members. */
async function loadOtherPhases(ownerId: string, projectId: string, techIds: string[], from: string, to: string, notes: string[]): Promise<CrewBooking[]> {
  const rows = await soft(
    () =>
      supabase.from('install_phase_crews').select('phase_id, technician_id, project_id').eq('user_id', ownerId).neq('project_id', projectId).in('technician_id', techIds).limit(2000) as unknown as PromiseLike<
        Res<{ phase_id: string; technician_id: string; project_id: string }[]>
      >,
    [],
    'other projects’ crews',
    notes,
  );
  if (!rows.length) return [];
  const phaseIds = [...new Set(rows.map((r) => r.phase_id))];
  const phases: { id: string; name: string; project_id: string; planned_start: string | null; planned_end: string | null; status: string }[] = [];
  for (let i = 0; i < phaseIds.length; i += 150) {
    phases.push(
      ...(await soft(
        () =>
          supabase.from('install_project_phases').select('id, name, project_id, planned_start, planned_end, status').eq('user_id', ownerId).in('id', phaseIds.slice(i, i + 150)) as unknown as PromiseLike<
            Res<typeof phases>
          >,
        [],
        'other projects’ phases',
        notes,
      )),
    );
  }
  const live = phases.filter((p) => p.status !== 'completed' && p.planned_start && p.planned_end && p.planned_end >= from && p.planned_start <= to);
  const projectIds = [...new Set(live.map((p) => p.project_id))];
  const names = new Map<string, string>();
  if (projectIds.length) {
    const projects = await soft(
      () => supabase.from('install_projects').select('id, name').eq('user_id', ownerId).in('id', projectIds.slice(0, 150)) as unknown as PromiseLike<Res<{ id: string; name: string }[]>>,
      [],
      'other projects',
      notes,
    );
    for (const p of projects) names.set(p.id, p.name);
  }
  const byPhase = new Map(live.map((p) => [p.id, p]));
  return rows.flatMap((r): CrewBooking[] => {
    const p = byPhase.get(r.phase_id);
    return p ? [{ id: `${r.phase_id}:${r.technician_id}`, technician_id: r.technician_id, kind: 'phase', label: `${names.get(p.project_id) ?? 'Another project'} · ${p.name}`, start: p.planned_start!, end: p.planned_end! }] : [];
  });
}

// ------------------------------------------------------------------
// Writes
// ------------------------------------------------------------------

async function patch(table: string, ownerId: string, id: string, values: Record<string, unknown>, fallback: string): Promise<void> {
  unwrap((await supabase.from(table).update(values).eq('id', id).eq('user_id', ownerId)) as Res<null>, fallback);
}

export async function addDependencies(ownerId: string, projectId: string, rows: { predecessor_id: string; successor_id: string; dep_type: DepType; lag_days: number }[]): Promise<void> {
  if (!rows.length) return;
  unwrap(
    (await supabase.from('install_phase_dependencies').insert(rows.map((r) => ({ ...r, user_id: ownerId, project_id: projectId })))) as Res<null>,
    'Could not link the phases.',
  );
}

export const updateDependency = (ownerId: string, id: string, values: { dep_type?: DepType; lag_days?: number }) =>
  patch('install_phase_dependencies', ownerId, id, values, 'Could not update the link.');

export async function removeDependency(ownerId: string, id: string): Promise<void> {
  unwrap((await supabase.from('install_phase_dependencies').delete().eq('id', id).eq('user_id', ownerId)) as Res<null>, 'Could not remove the link.');
}

/** Adds before removing, so a failure part-way leaves a superset of the crew, never a gap. */
export async function setPhaseCrew(ownerId: string, projectId: string, phaseId: string, next: string[], current: string[]): Promise<void> {
  const add = next.filter((t) => !current.includes(t));
  const drop = current.filter((t) => !next.includes(t));
  if (add.length) {
    unwrap(
      (await supabase.from('install_phase_crews').insert(add.map((technician_id) => ({ user_id: ownerId, project_id: projectId, phase_id: phaseId, technician_id })))) as Res<null>,
      'Could not assign the crew.',
    );
  }
  if (drop.length) {
    unwrap((await supabase.from('install_phase_crews').delete().eq('user_id', ownerId).eq('phase_id', phaseId).in('technician_id', drop)) as Res<null>, 'Could not update the crew.');
  }
}

export interface RescheduleChange {
  id: string;
  /** Both null clears the phase's dates (used by undo). */
  start: string | null;
  end: string | null;
  /** The phase's updated_at as the client last saw it; a mismatch rejects the whole batch. */
  expectedUpdatedAt?: string;
}

/** Atomic, server-validated batch: all phases move or none do. */
export async function reschedulePhases(projectId: string, changes: RescheduleChange[]): Promise<number> {
  const { data, error } = await supabase.rpc('reschedule_install_phases', {
    p_project_id: projectId,
    p_changes: changes.map((c) => ({ id: c.id, planned_start: c.start, planned_end: c.end, expected_updated_at: c.expectedUpdatedAt ?? null })),
  });
  if (error) throw new Error(friendlyError(error, 'Could not reschedule the phases.'));
  return Number(data ?? 0);
}

export const setPhaseLocked = (ownerId: string, id: string, locked: boolean) => patch('install_project_phases', ownerId, id, { locked }, 'Could not update the phase.');
export const setWorkWeekends = (ownerId: string, projectId: string, value: boolean) => patch('install_projects', ownerId, projectId, { work_weekends: value }, 'Could not update the work week.');
export const setMaterialPlan = (ownerId: string, id: string, values: { lead_time_days?: number; expected_date?: string | null }) =>
  patch('install_project_materials', ownerId, id, values, 'Could not update the material.');

export async function saveBaseline(projectId: string): Promise<number> {
  const { data, error } = await supabase.rpc('set_project_baseline', { p_project_id: projectId });
  if (error) throw new Error(friendlyError(error, 'Could not save the baseline.'));
  return Number(data ?? 0);
}

export async function setSharing(projectId: string, opts: { enabled?: boolean; rotate?: boolean; showDates?: boolean }): Promise<ProjectSharing> {
  const { data, error } = await supabase.rpc('set_project_sharing', {
    p_project_id: projectId,
    p_enabled: opts.enabled ?? null,
    p_rotate: opts.rotate ?? false,
    p_show_dates: opts.showDates ?? null,
  });
  if (error) throw new Error(friendlyError(error, 'Could not update the customer link.'));
  return data as ProjectSharing;
}

export const progressLink = (token: string): string => `${window.location.origin}/project/${token}`;

// ------------------------------------------------------------------
// Customer-facing progress (public, token-gated)
// ------------------------------------------------------------------

export interface PublicProgress {
  businessName: string | null;
  showDates: boolean;
  project: Pick<InstallProject, 'name' | 'project_type' | 'status' | 'start_date' | 'target_end_date'>;
  phases: ProjectPhase[];
  milestones: ProjectMilestone[];
}

export type PublicProgressResult = { kind: 'ok'; data: PublicProgress } | { kind: 'not_found' } | { kind: 'error' };

interface RawProgress {
  business_name: string | null;
  show_dates: boolean;
  project: PublicProgress['project'];
  phases: Pick<ProjectPhase, 'id' | 'name' | 'sort_order' | 'weight' | 'status' | 'planned_start' | 'planned_end' | 'actual_start' | 'actual_end'>[];
  milestones: Pick<ProjectMilestone, 'id' | 'phase_id' | 'title' | 'kind' | 'status' | 'due_date' | 'sort_order'>[];
}

/** Widens the minimal public payload to the full shapes the shared progress maths expects. */
export function toPublicProgress(raw: RawProgress): PublicProgress {
  return {
    businessName: raw.business_name,
    showDates: raw.show_dates,
    project: raw.project,
    phases: (raw.phases ?? []).map((p) => ({ ...p, project_id: '', description: null })),
    milestones: (raw.milestones ?? []).map((m) => ({ ...m, project_id: '', notes: null, completed_at: null })),
  };
}

export async function fetchPublicProgress(token: string): Promise<PublicProgressResult> {
  if (!/^[0-9a-f-]{36}$/i.test(token)) return { kind: 'not_found' };
  const { data, error } = await supabase.rpc('get_project_progress', { p_token: token });
  if (error) return { kind: 'error' };
  if (!data) return { kind: 'not_found' };
  return { kind: 'ok', data: toPublicProgress(data as RawProgress) };
}
