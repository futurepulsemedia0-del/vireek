/**
 * Technician detail — /dashboard/team/:id
 *
 * Pure aggregation helpers (unit-tested in technicianDetail.test.ts) plus one
 * data-access function. Nothing here creates new data: it reads the tables the
 * rest of the app already writes (team_members, technician_credentials, jobs,
 * review_requests, technician_scorecards, employees, timesheets,
 * commission_records, pay_runs / pay_run_items) and every query is scoped to
 * the account owner.
 */

import { supabase, type Job, type ReviewRequest, type TeamMember, type TechnicianCredential } from '@/lib/supabase';
import { computeTechnicianPerformance, type TechnicianMetrics, type TechnicianScorecard } from '@/lib/technicianPerformance';
import type { CommissionRecord, Employee, PayRun, PayRunItem, Timesheet } from '@/lib/payroll';

// ============================================================
// Shared helpers
// ============================================================

const DAY_MS = 86_400_000;

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
export function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}
/** Local YYYY-MM-DD (never UTC, so "today" matches what the user sees). */
export function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** Parses a Postgres `date` ("2026-03-01") as a local-midnight Date. */
function parseDateOnly(s: string): Date {
  return new Date(`${s.slice(0, 10)}T00:00:00`);
}

export interface PeriodRange {
  start: Date;
  end: Date;
}

/** The last `days` days including today, and the equally long window right before it. */
export function periodRanges(days: number, now: Date = new Date()): { current: PeriodRange; previous: PeriodRange } {
  const end = endOfDay(now);
  const start = startOfDay(new Date(now.getTime() - (days - 1) * DAY_MS));
  const prevEnd = endOfDay(new Date(start.getTime() - DAY_MS));
  const prevStart = startOfDay(new Date(start.getTime() - days * DAY_MS));
  return { current: { start, end }, previous: { start: prevStart, end: prevEnd } };
}

/** current − previous, or null when either side has no data. */
export function metricDelta(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return Math.round((current - previous) * 100) / 100;
}

// ============================================================
// Credentials
// ============================================================

export type CredentialHealth = 'valid' | 'expiring_soon' | 'expired' | 'revoked' | 'pending_renewal';
export const EXPIRING_SOON_DAYS = 60;

export interface CredentialView {
  credential: TechnicianCredential;
  health: CredentialHealth;
  /** Whole days until expiry (negative once expired); null when it never expires. */
  daysLeft: number | null;
}

export function credentialHealth(c: Pick<TechnicianCredential, 'status' | 'expires_at'>, now: Date = new Date()): { health: CredentialHealth; daysLeft: number | null } {
  const daysLeft = c.expires_at ? Math.round((parseDateOnly(c.expires_at).getTime() - startOfDay(now).getTime()) / DAY_MS) : null;
  if (c.status === 'revoked') return { health: 'revoked', daysLeft };
  if (daysLeft !== null && daysLeft < 0) return { health: 'expired', daysLeft };
  if (c.status === 'pending_renewal') return { health: 'pending_renewal', daysLeft };
  if (daysLeft !== null && daysLeft <= EXPIRING_SOON_DAYS) return { health: 'expiring_soon', daysLeft };
  return { health: 'valid', daysLeft };
}

const HEALTH_ORDER: Record<CredentialHealth, number> = { expired: 0, expiring_soon: 1, pending_renewal: 2, valid: 3, revoked: 4 };

/** Needs-attention first, then soonest expiry. */
export function buildCredentialViews(credentials: TechnicianCredential[], now: Date = new Date()): CredentialView[] {
  return credentials
    .map((credential) => ({ credential, ...credentialHealth(credential, now) }))
    .sort((a, b) => HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health] || (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity));
}

export function credentialAttentionCount(views: CredentialView[]): number {
  return views.filter((v) => v.health === 'expired' || v.health === 'expiring_soon' || v.health === 'pending_renewal').length;
}

// ============================================================
// Scorecard
// ============================================================

export function computeTechScorecard(tech: TeamMember, jobs: Job[], reviews: ReviewRequest[], range: PeriodRange): TechnicianMetrics {
  const result = computeTechnicianPerformance(jobs, reviews, [tech], range.start, range.end);
  return result.byTechnician[0];
}

export function scoreTone(kind: 'ftf' | 'csat' | 'callback' | 'utilization', value: number | null): 'good' | 'warn' | 'bad' | 'none' {
  if (value === null) return 'none';
  switch (kind) {
    case 'ftf': return value >= 90 ? 'good' : value >= 80 ? 'warn' : 'bad';
    case 'csat': return value >= 4.5 ? 'good' : value >= 4 ? 'warn' : 'bad';
    case 'callback': return value <= 8 ? 'good' : value <= 15 ? 'warn' : 'bad';
    case 'utilization': return value > 95 ? 'warn' : value >= 50 ? 'good' : 'warn';
  }
}

// ============================================================
// Skills — declared vs demonstrated
// ============================================================

export interface SkillEvidence {
  name: string;
  declared: boolean;
  jobs: number;
  firstTimeFixRate: number | null;
  csatAvg: number | null;
  lastJobAt: string | null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function skillMatches(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x));
}

/**
 * Joins what the tech *says* they can do (team_members.skills) with what the
 * completed-job history *shows* they do (service_type), so a manager can see
 * both unproven claims and undeclared experience.
 */
export function computeSkillEvidence(declared: string[], allJobs: Job[], reviews: ReviewRequest[], technicianId: string): SkillEvidence[] {
  const reworkedIds = new Set(allJobs.filter((j) => j.is_rework && j.rework_of_job_id).map((j) => j.rework_of_job_id as string));
  const done = allJobs.filter((j) => j.assigned_technician_id === technicianId && j.job_status === 'completed' && j.service_type);

  const byType = new Map<string, Job[]>();
  for (const j of done) byType.set(j.service_type as string, [...(byType.get(j.service_type as string) ?? []), j]);

  const out: SkillEvidence[] = [];
  const claimed = new Set<number>();

  for (const [type, jobs] of byType) {
    const idx = declared.findIndex((d) => skillMatches(d, type));
    if (idx >= 0) claimed.add(idx);
    const ratings = reviews.filter((r) => r.rating !== null && r.job_id && jobs.some((j) => j.id === r.job_id)).map((r) => r.rating as number);
    const callbacks = jobs.filter((j) => reworkedIds.has(j.id)).length;
    const last = jobs.map((j) => j.completed_at ?? j.scheduled_datetime).filter((x): x is string => Boolean(x)).sort().pop() ?? null;
    out.push({
      name: idx >= 0 ? declared[idx] : type,
      declared: idx >= 0,
      jobs: jobs.length,
      firstTimeFixRate: Math.round((1 - callbacks / jobs.length) * 1000) / 10,
      csatAvg: ratings.length ? Math.round((ratings.reduce((s, r) => s + r, 0) / ratings.length) * 100) / 100 : null,
      lastJobAt: last,
    });
  }
  declared.forEach((name, i) => {
    if (!claimed.has(i)) out.push({ name, declared: true, jobs: 0, firstTimeFixRate: null, csatAvg: null, lastJobAt: null });
  });

  // Proven declared skills, then undeclared experience, then unproven claims.
  const rank = (s: SkillEvidence) => (s.declared && s.jobs > 0 ? 0 : !s.declared ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || b.jobs - a.jobs || a.name.localeCompare(b.name));
}

// ============================================================
// Availability (next N days)
// ============================================================

export type AvailabilityState = 'open' | 'busy' | 'full' | 'off';

export interface AvailabilityDay {
  date: string;
  booked: number;
  capacity: number;
  state: AvailabilityState;
}

const LOAD_STATUSES = new Set<Job['job_status']>(['scheduled', 'en_route', 'in_progress', 'completed']);

export function computeAvailability(
  tech: Pick<TeamMember, 'dispatch_enabled' | 'max_jobs_per_day' | 'id'>,
  jobs: Pick<Job, 'assigned_technician_id' | 'scheduled_datetime' | 'job_status'>[],
  now: Date = new Date(),
  days = 7,
): AvailabilityDay[] {
  const counts = new Map<string, number>();
  for (const j of jobs) {
    if (j.assigned_technician_id !== tech.id || !j.scheduled_datetime || !LOAD_STATUSES.has(j.job_status)) continue;
    const key = localDateKey(new Date(j.scheduled_datetime));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const base = startOfDay(now);
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
    const date = localDateKey(d);
    const booked = counts.get(date) ?? 0;
    const capacity = Math.max(0, tech.max_jobs_per_day ?? 0);
    let state: AvailabilityState;
    if (!tech.dispatch_enabled || capacity === 0) state = 'off';
    else if (booked >= capacity) state = 'full';
    else if (booked >= Math.ceil(capacity * 0.6)) state = 'busy';
    else state = 'open';
    return { date, booked, capacity, state };
  });
}

/** "Live" within 15 minutes, otherwise how stale the last GPS ping is; null if never reported. */
export function locationFreshness(updatedAt: string | null, now: Date = new Date()): { live: boolean; minutesAgo: number } | null {
  if (!updatedAt) return null;
  const minutesAgo = Math.max(0, Math.round((now.getTime() - new Date(updatedAt).getTime()) / 60_000));
  return { live: minutesAgo <= 15, minutesAgo };
}

// ============================================================
// Hours
// ============================================================

export interface HoursSummary {
  regular: number;
  overtime: number;
  total: number;
  pendingHours: number;
  entries: number;
  weeks: { weekStart: string; hours: number }[];
}

const r1 = (n: number) => Math.round(n * 100) / 100;

function mondayOf(d: Date): Date {
  const s = startOfDay(d);
  const dow = (s.getDay() + 6) % 7; // Monday = 0
  return new Date(s.getFullYear(), s.getMonth(), s.getDate() - dow);
}

/** Rejected timesheets never count. Weekly buckets always cover the last `weeksBack` weeks ending now. */
export function summarizeHours(timesheets: Pick<Timesheet, 'work_date' | 'regular_hours' | 'overtime_hours' | 'status'>[], range: PeriodRange, now: Date = new Date(), weeksBack = 8): HoursSummary {
  const valid = timesheets.filter((t) => t.status !== 'rejected');
  const inRange = valid.filter((t) => {
    const d = parseDateOnly(t.work_date);
    return d >= range.start && d <= range.end;
  });
  const regular = inRange.reduce((s, t) => s + Number(t.regular_hours), 0);
  const overtime = inRange.reduce((s, t) => s + Number(t.overtime_hours), 0);
  const pendingHours = inRange.filter((t) => t.status === 'pending').reduce((s, t) => s + Number(t.regular_hours) + Number(t.overtime_hours), 0);

  const thisMonday = mondayOf(now);
  const weeks = Array.from({ length: weeksBack }, (_, i) => {
    const ws = new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - 7 * (weeksBack - 1 - i));
    const we = new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + 7);
    const hours = valid
      .filter((t) => { const d = parseDateOnly(t.work_date); return d >= ws && d < we; })
      .reduce((s, t) => s + Number(t.regular_hours) + Number(t.overtime_hours), 0);
    return { weekStart: localDateKey(ws), hours: r1(hours) };
  });

  return { regular: r1(regular), overtime: r1(overtime), total: r1(regular + overtime), pendingHours: r1(pendingHours), entries: inRange.length, weeks };
}

// ============================================================
// Earnings
// ============================================================

export interface PayslipView {
  item: PayRunItem;
  run: Pick<PayRun, 'id' | 'pay_date' | 'pay_period_start' | 'pay_period_end' | 'status'>;
}

export interface EarningsSummary {
  periodGrossCents: number;
  periodNetCents: number;
  ytdGrossCents: number;
  ytdNetCents: number;
  /** Commission earned but not yet on a pay run. */
  commissionUnpaidCents: number;
  commissionPaidCents: number;
  lastPay: { payDate: string; netCents: number } | null;
}

/** Only approved / paid runs count as earnings — drafts and voids don't. */
export function summarizeEarnings(
  payslips: PayslipView[],
  commissions: Pick<CommissionRecord, 'commission_cents' | 'status' | 'pay_run_item_id'>[],
  range: PeriodRange,
  now: Date = new Date(),
): EarningsSummary {
  const counted = payslips.filter((p) => p.run.status === 'approved' || p.run.status === 'paid');
  const inRange = counted.filter((p) => { const d = parseDateOnly(p.run.pay_date); return d >= range.start && d <= range.end; });
  const ytd = counted.filter((p) => parseDateOnly(p.run.pay_date).getFullYear() === now.getFullYear());
  const sum = (list: PayslipView[], k: 'gross_pay_cents' | 'net_pay_cents') => list.reduce((s, p) => s + p.item[k], 0);
  const last = [...counted].sort((a, b) => b.run.pay_date.localeCompare(a.run.pay_date))[0];

  return {
    periodGrossCents: sum(inRange, 'gross_pay_cents'),
    periodNetCents: sum(inRange, 'net_pay_cents'),
    ytdGrossCents: sum(ytd, 'gross_pay_cents'),
    ytdNetCents: sum(ytd, 'net_pay_cents'),
    commissionUnpaidCents: commissions.filter((c) => c.status !== 'paid' && !c.pay_run_item_id).reduce((s, c) => s + c.commission_cents, 0),
    commissionPaidCents: commissions.filter((c) => c.status === 'paid').reduce((s, c) => s + c.commission_cents, 0),
    lastPay: last ? { payDate: last.run.pay_date, netCents: last.item.net_pay_cents } : null,
  };
}

// ============================================================
// Job history
// ============================================================

export type JobFilter = 'all' | 'upcoming' | 'completed' | 'cancelled';

export function filterJobHistory(jobs: Job[], technicianId: string, filter: JobFilter, query: string): Job[] {
  const q = query.trim().toLowerCase();
  return jobs
    .filter((j) => j.assigned_technician_id === technicianId)
    .filter((j) => {
      if (filter === 'completed') return j.job_status === 'completed';
      if (filter === 'cancelled') return j.job_status === 'cancelled' || j.job_status === 'no_show';
      if (filter === 'upcoming') return j.job_status === 'scheduled' || j.job_status === 'en_route' || j.job_status === 'in_progress';
      return true;
    })
    .filter((j) => !q || [j.customer_name, j.service_type, j.address].some((f) => (f ?? '').toLowerCase().includes(q)))
    .sort((a, b) => new Date(b.scheduled_datetime ?? 0).getTime() - new Date(a.scheduled_datetime ?? 0).getTime());
}

// ============================================================
// Data access
// ============================================================

export type DetailSection = 'credentials' | 'jobs' | 'reviews' | 'snapshots' | 'payroll';

export interface TechnicianDetailData {
  member: TeamMember;
  credentials: TechnicianCredential[];
  /** The technician's own jobs plus rework jobs (needed to detect callbacks). */
  jobs: Job[];
  reviews: ReviewRequest[];
  snapshots: TechnicianScorecard[];
  employee: Employee | null;
  timesheets: Timesheet[];
  commissions: CommissionRecord[];
  payslips: PayslipView[];
  /** Sections whose query failed — the rest of the page still renders. */
  errors: Partial<Record<DetailSection, string>>;
  payrollIncluded: boolean;
}

const JOB_COLUMNS =
  'id, user_id, customer_name, customer_phone, service_type, address, scheduled_datetime, completed_at, duration_minutes, assigned_technician_id, job_status, invoice_amount, invoice_status, is_rework, rework_of_job_id';

const msg = (e: unknown) => (e instanceof Error ? e.message : (e as { message?: string } | null)?.message ?? 'Request failed');

export async function fetchTechnicianDetail(ownerId: string, technicianId: string, opts: { includePayroll: boolean }): Promise<TechnicianDetailData | null> {
  const { data: member, error } = await supabase
    .from('team_members')
    .select('*')
    .eq('id', technicianId)
    .eq('account_owner_id', ownerId)
    .maybeSingle();
  if (error) throw error;
  if (!member) return null;

  const errors: TechnicianDetailData['errors'] = {};
  const [creds, jobs, rework, reviews, snaps] = await Promise.allSettled([
    supabase.from('technician_credentials').select('*').eq('technician_id', technicianId).eq('user_id', ownerId),
    supabase.from('jobs').select(JOB_COLUMNS).eq('user_id', ownerId).eq('assigned_technician_id', technicianId).order('scheduled_datetime', { ascending: false }).limit(1500),
    supabase.from('jobs').select(JOB_COLUMNS).eq('user_id', ownerId).eq('is_rework', true).not('rework_of_job_id', 'is', null).limit(2000),
    supabase.from('review_requests').select('*').eq('user_id', ownerId).not('rating', 'is', null).limit(3000),
    supabase.from('technician_scorecards').select('*').eq('technician_id', technicianId).eq('user_id', ownerId).order('period_start', { ascending: false }).limit(24),
  ]);

  const unwrap = <T,>(r: PromiseSettledResult<{ data: T | null; error: unknown }>, section: DetailSection, fallback: T): T => {
    if (r.status === 'rejected') { errors[section] = msg(r.reason); return fallback; }
    if (r.value.error) { errors[section] = msg(r.value.error); return fallback; }
    return r.value.data ?? fallback;
  };

  const credentials = unwrap(creds, 'credentials', [] as TechnicianCredential[]);
  const ownJobs = unwrap(jobs, 'jobs', [] as unknown as Job[]) as unknown as Job[];
  const reworkAll = unwrap(rework, 'jobs', [] as unknown as Job[]) as unknown as Job[];
  const ownIds = new Set(ownJobs.map((j) => j.id));
  const mergedJobs = [...ownJobs, ...reworkAll.filter((j) => !ownIds.has(j.id) && j.rework_of_job_id && ownIds.has(j.rework_of_job_id))];

  let employee: Employee | null = null;
  let timesheets: Timesheet[] = [];
  let commissions: CommissionRecord[] = [];
  let payslips: PayslipView[] = [];

  if (opts.includePayroll) {
    try {
      const { data: emp, error: empErr } = await supabase.from('employees').select('*').eq('team_member_id', technicianId).eq('user_id', ownerId).maybeSingle();
      if (empErr) throw empErr;
      employee = (emp as Employee | null) ?? null;
      if (employee) {
        const [ts, cm, items] = await Promise.all([
          supabase.from('timesheets').select('*').eq('employee_id', employee.id).eq('user_id', ownerId).order('work_date', { ascending: false }).limit(800),
          supabase.from('commission_records').select('*').eq('employee_id', employee.id).eq('user_id', ownerId).order('created_at', { ascending: false }).limit(800),
          supabase.from('pay_run_items').select('*').eq('employee_id', employee.id).limit(300),
        ]);
        if (ts.error) throw ts.error;
        if (cm.error) throw cm.error;
        if (items.error) throw items.error;
        timesheets = (ts.data ?? []) as Timesheet[];
        commissions = (cm.data ?? []) as CommissionRecord[];
        const rows = (items.data ?? []) as PayRunItem[];
        if (rows.length) {
          const { data: runs, error: runErr } = await supabase
            .from('pay_runs')
            .select('id, pay_date, pay_period_start, pay_period_end, status')
            .eq('user_id', ownerId)
            .in('id', [...new Set(rows.map((r) => r.pay_run_id))]);
          if (runErr) throw runErr;
          const runById = new Map((runs ?? []).map((r) => [r.id as string, r as PayslipView['run']]));
          payslips = rows.flatMap((item) => { const run = runById.get(item.pay_run_id); return run ? [{ item, run }] : []; })
            .sort((a, b) => b.run.pay_date.localeCompare(a.run.pay_date));
        }
      }
    } catch (e) {
      errors.payroll = msg(e);
    }
  }

  return {
    member: member as TeamMember,
    credentials,
    jobs: mergedJobs,
    reviews: unwrap(reviews, 'reviews', [] as ReviewRequest[]),
    snapshots: unwrap(snaps, 'snapshots', [] as TechnicianScorecard[]),
    employee,
    timesheets,
    commissions,
    payslips,
    errors,
    payrollIncluded: opts.includePayroll,
  };
}
