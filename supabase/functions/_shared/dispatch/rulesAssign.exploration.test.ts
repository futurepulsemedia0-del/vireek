import { describe, it, expect, vi } from 'vitest';

vi.mock('../governance/aiDecisionRecorder.ts', () => ({
  buildDispatchEvidence: vi.fn().mockResolvedValue({ confidencePct: 80, reasonFactors: [], dataUsed: [] }),
  recordAiDecision: vi.fn().mockResolvedValue(undefined),
}));

import { assignJobsWithRules } from './rulesAssign';

type Row = Record<string, unknown>;
interface World {
  settings?: Row | null | { error: string };
  jobs: Row[];
  techs: string[];
  /** jobs.id -> extra columns for the exploration flag query (tags, call_id, sla_response_hours). */
  flags?: Record<string, Row>;
  calls?: Row[];
  verdicts?: Row[] | { error: string };
  /** Rows returned for dispatch_decisions SELECTs (budget state + guardrail). */
  decisionRows?: Row[];
  /** Completed/rework jobs for the guardrail. */
  outcomeJobs?: Row[];
  outcomeReworks?: Row[];
  blockTech?: string;
  insertError?: { code: string; message: string };
}

const SETTINGS_ON = { enabled: true, kill_switch: false, budget_pct: 25, delta: 3, max_regret_pct: 5, per_tech_weekly_cap: 50, guardrail_tolerance_pct: 5, auto_disabled_at: null };
const skillRule = { id: 'r1', rule_type: 'skill_match', name: 'Skill match', enabled: true, mode: 'require', weight: 20, params: {}, position: 1 };

function makeAdmin(w: World) {
  const inserts: Row[] = [];
  const updates: { table: string; patch: Row }[] = [];
  const idsIn = (calls: [string, unknown[]][]) => (calls.find(([m, a]) => m === 'in' && a[0] === 'id' || m === 'in' && a[0] === 'rework_of_job_id')?.[1][1] ?? []) as string[];
  const resolve = (table: string, calls: [string, unknown[]][], select: string): { data: unknown; error: { message: string } | null } => {
    const has = (m: string, a0: unknown) => calls.some(([n, a]) => n === m && a[0] === a0);
    switch (table) {
      case 'dispatch_rules': return { data: [skillRule], error: null };
      case 'team_members': return { data: w.techs.map((id) => ({ id, member_name: id.toUpperCase(), member_email: `${id}@x.io`, skills: ['plumbing'], service_area: null, territory_id: null, max_jobs_per_day: 6, home_latitude: null, home_longitude: null, current_latitude: null, current_longitude: null })), error: null };
      case 'territories': case 'dispatch_technician_preferences': case 'customers': return { data: [], error: null };
      case 'dispatch_exploration_settings':
        if (w.settings && typeof w.settings === 'object' && 'error' in w.settings) return { data: null, error: { message: (w.settings as { error: string }).error } };
        return { data: w.settings ?? null, error: null };
      case 'ftf_predictions':
        return w.verdicts && 'error' in (w.verdicts as object) ? { data: null, error: { message: 'boom' } } : { data: w.verdicts ?? [], error: null };
      case 'calls': return { data: w.calls ?? [], error: null };
      case 'dispatch_decisions': return { data: w.decisionRows ?? [], error: null };
      case 'jobs': {
        if (select.includes('sla_response_hours')) return { data: idsIn(calls).map((id) => ({ id, service_type: 'plumbing', tags: [], call_id: null, sla_response_hours: null, ...(w.flags?.[id] ?? {}) })), error: null };
        if (select.includes('rework_of_job_id') && !select.includes('assigned')) {
          // guardrail rework query OR quality rework query
          if (has('in', 'rework_of_job_id')) return { data: w.outcomeReworks ?? [], error: null };
          return { data: [], error: null };
        }
        if (select.includes('completed_at') && select.includes('is_rework')) return { data: (w.outcomeJobs ?? []).filter((j) => idsIn(calls).includes(j.id as string)), error: null };
        if (has('eq', 'job_status') ) {
          // quality: five clean completed jobs per technician
          return { data: w.techs.flatMap((t) => Array.from({ length: 5 }, (_, i) => ({ id: `done-${t}-${i}`, assigned_technician_id: t }))), error: null };
        }
        if (has('in', 'job_status')) return { data: [], error: null };
        return { data: w.jobs, error: null };
      }
      default: return { data: [], error: null };
    }
  };
  const admin = {
    from(table: string) {
      const calls: [string, unknown[]][] = [];
      let select = '';
      const c: Record<string, unknown> = {};
      for (const m of ['eq', 'in', 'not', 'gte', 'lt', 'limit', 'order']) c[m] = (...a: unknown[]) => { calls.push([m, a]); return c; };
      c.select = (cols: string) => { select = cols; calls.push(['select', [cols]]); return c; };
      c.maybeSingle = () => Promise.resolve(resolve(table, calls, select));
      c.insert = (row: Row) => {
        if (table === 'dispatch_decisions') {
          if (w.insertError && 'propensity' in row) return Promise.resolve({ error: w.insertError });
          inserts.push(row);
        }
        return Promise.resolve({ error: null });
      };
      c.update = (patch: Row) => { updates.push({ table, patch }); return c; };
      c.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(updates.length && calls.length === 1 && calls[0][0] === 'eq' && table === 'dispatch_exploration_settings' ? { error: null } : resolve(table, calls, select)).then(ok, bad);
      return c;
    },
    rpc: vi.fn(async (_fn: string, a: { p_job_id: string; p_technician_id: string }) =>
      a.p_technician_id === w.blockTech
        ? { data: { status: 'at_capacity', reason: 'full' }, error: null }
        : { data: { status: 'assigned', technician_id: a.p_technician_id, technician_name: a.p_technician_id.toUpperCase() }, error: null }),
  };
  return { admin: admin as never, inserts, updates };
}

const day = (i: number) => new Date(Date.UTC(2026, 9, 1 + i, 14)).toISOString();
const jobRow = (id: string, i: number, extra: Row = {}) => ({ id, service_type: 'plumbing', address: '1 Main', scheduled_datetime: day(i), duration_minutes: 60, customer_id: null, latitude: null, longitude: null, ...extra });
const brief = (id: string, i: number) => ({ id, service_type: 'plumbing', address: '1 Main', scheduled_datetime: day(i) });
const manyJobs = (n: number) => Array.from({ length: n }, (_, i) => jobRow(`j${i}`, i));
const run = (w: World, ids = w.jobs.map((j) => j.id as string)) => {
  const t = makeAdmin(w);
  return assignJobsWithRules(t.admin, 'acct', ids.map((id, i) => brief(id, w.jobs.findIndex((j) => j.id === id) >= 0 ? w.jobs.findIndex((j) => j.id === id) : i))).then((res) => ({ res, ...t }));
};

describe('assignJobsWithRules + causal dispatch loop', () => {
  it('feature OFF (no settings row): deterministic pick and every decision still carries propensity 1', async () => {
    const { res, inserts } = await run({ jobs: manyJobs(5), techs: ['a', 'b', 'c'], settings: null });
    expect(res.every((r) => r.technicianId === 'a')).toBe(true);
    expect(inserts).toHaveLength(5);
    for (const row of inserts) expect(row).toMatchObject({ mode: 'auto', arm: 'exploit', propensity: 1, policy_version: 'cdl-1' });
  });

  it('settings table missing (migration not applied): never fails dispatch', async () => {
    const { res } = await run({ jobs: manyJobs(3), techs: ['a', 'b'], settings: { error: 'relation does not exist' } });
    expect(res.every((r) => r.technicianId === 'a')).toBe(true);
  });

  it('feature ON: randomizes within budget, logs propensity + set, assignment matches the log', async () => {
    const w: World = { jobs: manyJobs(80), techs: ['a', 'b', 'c'], settings: SETTINGS_ON };
    const { res, inserts } = await run(w);
    expect(res.every((r) => r.technicianId)).toBe(true);
    const explored = inserts.filter((r) => r.arm === 'explore');
    expect(explored.length).toBeGreaterThan(2);
    expect(explored.length / inserts.length).toBeLessThanOrEqual(0.27); // budget 25% (+1 job of slack)
    for (const row of explored) {
      expect(row.set_size).toBe(3);
      expect((row.propensity as number)).toBeGreaterThan(0);
      expect((row.propensity as number)).toBeLessThan(1);
      const set = row.indifference_set as { top_id: string; members: { id: string; p: number }[]; reason: string };
      expect(set.reason).toBe('explored');
      expect(set.members.map((m) => m.id).sort()).toEqual(['a', 'b', 'c']);
      expect(set.members.reduce((s, m) => s + m.p, 0)).toBeCloseTo(1, 5);
      expect(row.recommended_technician_id).toBe('a'); // the engine's own best stays recorded
    }
    // some exploration picks differ from the deterministic top (otherwise nothing was randomized)
    expect(explored.some((r) => r.technician_id !== 'a')).toBe(true);
    // the result returned to the caller matches what was logged
    for (const row of inserts) expect(res.find((r) => r.job_id === row.job_id)?.technicianId).toBe(row.technician_id);
    // non-explored decisions are deterministic picks
    for (const row of inserts.filter((r) => r.arm === 'exploit')) expect(row.technician_id).toBe('a');
  });

  it('same inputs => same assignments (replay-safe)', async () => {
    const w = () => ({ jobs: manyJobs(40), techs: ['a', 'b', 'c'], settings: SETTINGS_ON });
    const one = (await run(w())).res.map((r) => r.technicianId);
    const two = (await run(w())).res.map((r) => r.technicianId);
    expect(two).toEqual(one);
  });

  it('never randomizes emergency / SLA-critical / VIP-call jobs', async () => {
    const jobs = manyJobs(60);
    const flags: Record<string, Row> = {};
    jobs.forEach((j, i) => { if (i % 3 === 0) flags[j.id as string] = { tags: ['Emergency'] }; if (i % 3 === 1) flags[j.id as string] = { sla_response_hours: 4 }; });
    const { inserts } = await run({ jobs, techs: ['a', 'b', 'c'], settings: SETTINGS_ON, flags });
    for (const row of inserts) {
      const i = Number(String(row.job_id).slice(1));
      if (i % 3 !== 2) { expect(row.arm).toBe('exploit'); expect(row.technician_id).toBe('a'); }
    }
    expect(inserts.some((r) => r.arm === 'explore')).toBe(true);
  });

  it('a call flagged is_emergency also blocks randomization', async () => {
    const { inserts } = await run({ jobs: manyJobs(40), techs: ['a', 'b', 'c'], settings: SETTINGS_ON, flags: Object.fromEntries(manyJobs(40).map((j) => [j.id as string, { call_id: 'c1' }])), calls: [{ id: 'c1', is_emergency: true }] });
    expect(inserts.every((r) => r.arm === 'exploit')).toBe(true);
  });

  it('autopilot hold/review verdict on the top pick blocks; lookup failure fails closed', async () => {
    const verdicts = Array.from({ length: 40 }, (_, i) => ({ job_id: `j${i}`, technician_id: 'a', verdict: i % 2 ? 'hold' : 'review' }));
    const held = await run({ jobs: manyJobs(40), techs: ['a', 'b', 'c'], settings: SETTINGS_ON, verdicts });
    expect(held.inserts.every((r) => r.arm === 'exploit')).toBe(true);
    const failed = await run({ jobs: manyJobs(40), techs: ['a', 'b', 'c'], settings: SETTINGS_ON, verdicts: { error: 'x' } });
    expect(failed.inserts.every((r) => r.arm === 'exploit' && r.technician_id === 'a')).toBe(true);
  });

  it('per-account kill switch and auto-disabled flag keep dispatch deterministic', async () => {
    for (const settings of [{ ...SETTINGS_ON, kill_switch: true }, { ...SETTINGS_ON, auto_disabled_at: '2026-10-01T00:00:00Z' }, { ...SETTINGS_ON, enabled: false }]) {
      const { inserts } = await run({ jobs: manyJobs(30), techs: ['a', 'b', 'c'], settings });
      expect(inserts.every((r) => r.arm === 'exploit' && r.technician_id === 'a')).toBe(true);
    }
  });

  it('a randomized pick refused by a DB gate falls back and is logged as a deterministic fallback', async () => {
    const { res, inserts } = await run({ jobs: manyJobs(120), techs: ['a', 'b', 'c'], settings: SETTINGS_ON, blockTech: 'b' });
    expect(res.every((r) => r.technicianId && r.technicianId !== 'b')).toBe(true); // b never gets a job
    const fallbacks = inserts.filter((r) => (r.indifference_set as { reason?: string } | null)?.reason === 'gate_fallback');
    expect(fallbacks.length).toBeGreaterThan(0);
    for (const row of fallbacks) expect(row).toMatchObject({ arm: 'exploit', propensity: 1 });
    // an explore row is only written when the drawn technician really got the job
    for (const row of inserts.filter((r) => r.arm === 'explore')) expect(row.technician_id).not.toBe('b');
  });

  it('guardrail breach switches the account off and dispatch stays deterministic', async () => {
    const ex = Array.from({ length: 60 }, (_, i) => `e${i}`);
    const co = Array.from({ length: 60 }, (_, i) => `k${i}`);
    const decisionRows = [
      ...ex.map((id) => ({ job_id: id, arm: 'explore', set_size: 3, indifference_set: { reason: 'explored' }, technician_id: 'b', created_at: new Date().toISOString() })),
      ...co.map((id) => ({ job_id: id, arm: 'exploit', set_size: 3, indifference_set: { reason: 'not_enrolled' }, technician_id: 'a', created_at: new Date().toISOString() })),
    ];
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const outcomeJobs = [...ex, ...co].map((id) => ({ id, job_status: 'completed', completed_at: old, is_rework: false }));
    const outcomeReworks = ex.slice(0, 30).map((id) => ({ rework_of_job_id: id, created_at: new Date(Date.parse(old) + 3 * 86_400_000).toISOString() })); // 50% callbacks on explore, 0% control
    const { inserts, updates } = await run({ jobs: manyJobs(10), techs: ['a', 'b', 'c'], settings: SETTINGS_ON, decisionRows, outcomeJobs, outcomeReworks });
    expect(updates.some((u) => u.table === 'dispatch_exploration_settings' && u.patch.enabled === false && typeof u.patch.auto_disabled_reason === 'string')).toBe(true);
    expect(inserts.every((r) => r.arm === 'exploit' && r.technician_id === 'a')).toBe(true);
  });

  it('callbacks outside the 14-day window or on immature jobs do not trigger the guardrail', async () => {
    const ex = Array.from({ length: 60 }, (_, i) => `e${i}`);
    const co = Array.from({ length: 60 }, (_, i) => `k${i}`);
    const decisionRows = [
      ...ex.map((id) => ({ job_id: id, arm: 'explore', set_size: 3, indifference_set: { reason: 'explored' }, technician_id: 'b', created_at: new Date().toISOString() })),
      ...co.map((id) => ({ job_id: id, arm: 'exploit', set_size: 3, indifference_set: { reason: 'not_enrolled' }, technician_id: 'a', created_at: new Date().toISOString() })),
      // plenty of ordinary deterministic decisions so the realised exploration share (60/420) is inside the 25% budget
      ...Array.from({ length: 300 }, (_, i) => ({ job_id: `x${i}`, arm: 'exploit', set_size: 1, indifference_set: { reason: 'disabled' }, technician_id: 'a', created_at: new Date().toISOString() })),
    ];
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const outcomeJobs = [...ex, ...co].map((id) => ({ id, job_status: 'completed', completed_at: old, is_rework: false }));
    const late = ex.map((id) => ({ rework_of_job_id: id, created_at: new Date(Date.parse(old) + 20 * 86_400_000).toISOString() })); // day 20 > 14
    const { updates, inserts } = await run({ jobs: manyJobs(40), techs: ['a', 'b', 'c'], settings: SETTINGS_ON, decisionRows, outcomeJobs, outcomeReworks: late });
    expect(updates).toHaveLength(0);
    expect(inserts.some((r) => r.arm === 'explore')).toBe(true);
  });

  it('decision log falls back to the legacy columns if the migration is not applied yet', async () => {
    const { inserts, res } = await run({ jobs: manyJobs(3), techs: ['a', 'b'], settings: null, insertError: { code: '42703', message: 'column "propensity" of relation "dispatch_decisions" does not exist' } });
    expect(res.every((r) => r.technicianId === 'a')).toBe(true);
    expect(inserts).toHaveLength(3);
    for (const row of inserts) { expect(row).not.toHaveProperty('propensity'); expect(row).toMatchObject({ mode: 'auto' }); }
  });
});
