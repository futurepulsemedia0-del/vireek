// Loads everything rankTechnicians() needs. Structural `Db` type so the SAME loader runs with the
// service-role client (edge) and the RLS-scoped browser client. Every query is filtered by the
// account owner id on top of RLS.

import {
  DEFAULT_PARAMS,
  RULE_TYPES,
  type DispatchRule,
  type EngineJob,
  type EnginePreference,
  type EngineTechnician,
  type EngineTerritory,
  type RuleMode,
  type RuleType,
} from './rulesEngine.ts';

// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = { from: (table: string) => any };

export interface RulesContext {
  rules: DispatchRule[];
  technicians: EngineTechnician[];
  territories: EngineTerritory[];
  preferences: EnginePreference[];
  openJobs: { id: string; technician_id: string; day: string; minutes: number }[];
}

const OPEN_STATUSES = ['scheduled', 'en_route', 'in_progress'];
const QUALITY_MIN_SAMPLE = 5;

export const dayKey = (iso: string | null | undefined): string | null => (iso ? new Date(iso).toISOString().slice(0, 10) : null);

function isRuleType(v: unknown): v is RuleType {
  return typeof v === 'string' && (RULE_TYPES as string[]).includes(v);
}

export function normalizeRule(row: Record<string, unknown>): DispatchRule | null {
  if (!isRuleType(row.rule_type) || typeof row.id !== 'string') return null;
  const mode: RuleMode = row.mode === 'require' ? 'require' : 'score';
  const weight = typeof row.weight === 'number' ? Math.min(100, Math.max(0, row.weight)) : 10;
  return {
    id: row.id,
    rule_type: row.rule_type,
    name: typeof row.name === 'string' && row.name ? row.name : row.rule_type,
    enabled: row.enabled !== false,
    mode,
    weight,
    params: row.params && typeof row.params === 'object' ? (row.params as Record<string, unknown>) : {},
    position: typeof row.position === 'number' ? row.position : 0,
  };
}

export async function loadRules(db: Db, ownerId: string): Promise<DispatchRule[]> {
  const { data, error } = await db.from('dispatch_rules').select('id, rule_type, name, enabled, mode, weight, params, position').eq('user_id', ownerId).order('position', { ascending: true });
  if (error) throw new Error(error.message);
  return (Array.isArray(data) ? data : []).flatMap((r: Record<string, unknown>) => { const n = normalizeRule(r); return n ? [n] : []; });
}

/** 1 − (share of the technician's completed jobs, last 90 days, that later needed a rework visit). Null under 5 jobs. */
async function loadQuality(db: Db, ownerId: string): Promise<Record<string, number>> {
  try {
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const [done, redo] = await Promise.all([
      db.from('jobs').select('id, assigned_technician_id').eq('user_id', ownerId).eq('job_status', 'completed').gte('completed_at', since).not('assigned_technician_id', 'is', null).limit(3000),
      db.from('jobs').select('rework_of_job_id').eq('user_id', ownerId).eq('is_rework', true).not('rework_of_job_id', 'is', null).gte('created_at', since).limit(3000),
    ]);
    const reworked = new Set<string>((redo.data ?? []).map((r: { rework_of_job_id: string }) => r.rework_of_job_id));
    const tally: Record<string, { n: number; bad: number }> = {};
    for (const j of (done.data ?? []) as { id: string; assigned_technician_id: string }[]) {
      const t = (tally[j.assigned_technician_id] ??= { n: 0, bad: 0 });
      t.n += 1;
      if (reworked.has(j.id)) t.bad += 1;
    }
    const out: Record<string, number> = {};
    for (const [id, t] of Object.entries(tally)) if (t.n >= QUALITY_MIN_SAMPLE) out[id] = 1 - t.bad / t.n;
    return out;
  } catch {
    return {}; // quality is an optional signal — never block dispatch on it
  }
}

export async function loadRulesContext(db: Db, ownerId: string, days: string[]): Promise<RulesContext> {
  const sortedDays = [...days].sort();
  const from = sortedDays.length ? new Date(`${sortedDays[0]}T00:00:00Z`).getTime() - 86_400_000 : Date.now() - 86_400_000;
  const to = sortedDays.length ? new Date(`${sortedDays[sortedDays.length - 1]}T00:00:00Z`).getTime() + 2 * 86_400_000 : Date.now() + 2 * 86_400_000;

  const [rules, techs, territories, prefs, open, quality] = await Promise.all([
    loadRules(db, ownerId),
    db.from('team_members').select('id, member_name, member_email, skills, service_area, territory_id, max_jobs_per_day, home_latitude, home_longitude, current_latitude, current_longitude').eq('account_owner_id', ownerId).eq('role', 'technician').eq('invite_status', 'active').eq('dispatch_enabled', true),
    db.from('territories').select('id, name, center_latitude, center_longitude, radius_miles').eq('user_id', ownerId),
    db.from('dispatch_technician_preferences').select('technician_id, customer_id, service_type, preference').eq('user_id', ownerId),
    db.from('jobs').select('id, assigned_technician_id, scheduled_datetime, duration_minutes').eq('user_id', ownerId).in('job_status', OPEN_STATUSES).not('assigned_technician_id', 'is', null).gte('scheduled_datetime', new Date(from).toISOString()).lt('scheduled_datetime', new Date(to).toISOString()).limit(5000),
    loadQuality(db, ownerId),
  ]);
  if (techs.error) throw new Error(techs.error.message);

  const technicians: EngineTechnician[] = ((techs.data ?? []) as Record<string, unknown>[]).map((t) => ({
    id: t.id as string,
    name: (t.member_name as string | null) ?? (t.member_email as string | null) ?? 'Technician',
    skills: Array.isArray(t.skills) ? (t.skills as string[]) : [],
    service_area: (t.service_area as string | null) ?? null,
    territory_id: (t.territory_id as string | null) ?? null,
    lat: (t.current_latitude as number | null) ?? (t.home_latitude as number | null) ?? null,
    lon: (t.current_longitude as number | null) ?? (t.home_longitude as number | null) ?? null,
    max_jobs_per_day: typeof t.max_jobs_per_day === 'number' ? t.max_jobs_per_day : 6,
    quality: quality[t.id as string] ?? null,
  }));

  return {
    rules,
    technicians,
    territories: ((territories.data ?? []) as EngineTerritory[]),
    preferences: ((prefs.data ?? []) as EnginePreference[]),
    openJobs: ((open.data ?? []) as Record<string, unknown>[]).flatMap((j) => {
      const day = dayKey(j.scheduled_datetime as string | null);
      return day ? [{ id: j.id as string, technician_id: j.assigned_technician_id as string, day, minutes: typeof j.duration_minutes === 'number' && j.duration_minutes > 0 ? j.duration_minutes : DEFAULT_PARAMS.default_job_minutes }] : [];
    }),
  };
}

/** VIP = customer lifecycle_stage 'vip' or a VIP tag. Returns the set of VIP customer ids among `ids`. */
export async function loadVipCustomerIds(db: Db, ownerId: string, ids: string[]): Promise<Set<string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Set();
  const { data } = await db.from('customers').select('id, lifecycle_stage, tags').eq('user_id', ownerId).in('id', unique);
  return new Set(((data ?? []) as { id: string; lifecycle_stage: string; tags: string[] | null }[])
    .filter((c) => c.lifecycle_stage === 'vip' || (c.tags ?? []).some((t) => t.toLowerCase() === 'vip'))
    .map((c) => c.id));
}

export function toEngineJob(row: Record<string, unknown>, vipIds: Set<string>): EngineJob {
  const customerId = (row.customer_id as string | null) ?? null;
  return {
    id: row.id as string,
    service_type: (row.service_type as string | null) ?? null,
    address: (row.address as string | null) ?? null,
    lat: (row.latitude as number | null) ?? null,
    lon: (row.longitude as number | null) ?? null,
    duration_minutes: (row.duration_minutes as number | null) ?? null,
    customer_id: customerId,
    is_vip: customerId ? vipIds.has(customerId) : false,
  };
}
