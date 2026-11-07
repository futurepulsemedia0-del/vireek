import { describe, it, expect } from 'vitest';
import { assignJobsWithRules } from './rulesAssign';

// Minimal in-memory admin (same query-chain contract as rulesAssign.test.ts).
function makeAdmin(w: { settings?: Record<string, unknown>[]; settingsError?: boolean; jobs: Record<string, unknown>[]; techs: Record<string, unknown>[]; customers?: Record<string, unknown>[]; rpc: (a: { p_job_id: string; p_technician_id: string | null }) => { data?: unknown; error?: { message: string } | null } }) {
  const decisions: Record<string, unknown>[] = [];
  const rpcCalls: { p_job_id: string; p_technician_id: string | null }[] = [];
  const rules = [{ id: 'r1', rule_type: 'skill_match', name: 'Skill', enabled: true, mode: 'require', weight: 20, params: {}, position: 1 }];
  const resolve = (table: string, calls: [string, unknown[]][]) => {
    const has = (m: string, a0: unknown) => calls.some(([n, a]) => n === m && a[0] === a0);
    switch (table) {
      case 'dispatch_rules': return { data: rules, error: null };
      case 'dispatch_randomization_settings': return w.settingsError ? { data: null, error: { message: 'relation does not exist' } } : { data: w.settings ?? [], error: null };
      case 'team_members': return { data: w.techs, error: null };
      case 'customers': return { data: w.customers ?? [], error: null };
      case 'jobs':
        if (has('eq', 'job_status') && calls.some(([n, a]) => n === 'eq' && a[1] === 'completed')) return { data: [], error: null };
        if (calls.some(([n, a]) => n === 'eq' && a[0] === 'is_rework')) return { data: [], error: null };
        if (has('in', 'job_status')) return { data: [], error: null };
        return { data: w.jobs, error: null };
      default: return { data: [], error: null };
    }
  };
  const admin = {
    from(table: string) {
      const calls: [string, unknown[]][] = [];
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'not', 'gte', 'lt', 'limit', 'order']) c[m] = (...a: unknown[]) => { calls.push([m, a]); return c; };
      c.insert = (row: Record<string, unknown>) => { if (table === 'dispatch_decisions') decisions.push(row); return Promise.resolve({ error: null }); };
      c.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(resolve(table, calls)).then(ok, bad);
      return c;
    },
    rpc: async (_fn: string, a: { p_job_id: string; p_technician_id: string | null }) => { rpcCalls.push(a); return w.rpc(a); },
  };
  return { admin: admin as never, decisions, rpcCalls };
}

const tech = (id: string) => ({ id, member_name: id.toUpperCase(), member_email: `${id}@x.io`, skills: ['plumbing'], service_area: null, territory_id: null, max_jobs_per_day: 6, home_latitude: 40, home_longitude: -74, current_latitude: 40, current_longitude: -74 });
const jobRow = (id: string, extra: Record<string, unknown> = {}) => ({ id, service_type: 'plumbing', address: '1 Main', scheduled_datetime: '2026-10-20T14:00:00.000Z', duration_minutes: 60, customer_id: null, latitude: 40.01, longitude: -74.01, ...extra });
const brief = (id: string) => ({ id, service_type: 'plumbing', address: '1 Main', scheduled_datetime: '2026-10-20T14:00:00.000Z' });
const ok = (a: { p_technician_id: string | null }) => ({ data: { status: 'assigned', technician_id: a.p_technician_id, technician_name: a.p_technician_id?.toUpperCase() } });
const settings = [{ enabled: true, epsilon: 1, top_k: 2, max_eta_delta_minutes: 10, excluded_service_types: [], salt: 'salt-xyz' }];

describe('assignJobsWithRules + near-tie randomization', () => {
  it('flag OFF (no settings row): byte-identical to the deterministic path, no randomization key', async () => {
    const { admin, decisions, rpcCalls } = makeAdmin({ jobs: [jobRow('j1')], techs: [tech('a'), tech('b')], rpc: ok });
    await assignJobsWithRules(admin, 'u1', [brief('j1')]);
    expect(rpcCalls[0].p_technician_id).toBe('a'); // tie broken by id, as before
    expect('randomization' in (decisions[0].explanation as object)).toBe(false);
  });

  it('settings table missing => OFF (never breaks dispatch)', async () => {
    const { admin, decisions, rpcCalls } = makeAdmin({ settingsError: true, jobs: [jobRow('j1')], techs: [tech('a'), tech('b')], rpc: ok });
    await assignJobsWithRules(admin, 'u1', [brief('j1')]);
    expect(rpcCalls[0].p_technician_id).toBe('a');
    expect('randomization' in (decisions[0].explanation as object)).toBe(false);
  });

  it('flag ON: picks among the tied, logs propensity/seed/ε, keeps recommended = deterministic top', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const { admin, decisions } = makeAdmin({ settings, jobs: [jobRow(`job-${i}`)], techs: [tech('a'), tech('b')], rpc: ok });
      await assignJobsWithRules(admin, 'u1', [brief(`job-${i}`)]);
      const d = decisions[0];
      const rz = (d.explanation as { randomization: Record<string, unknown> }).randomization;
      expect(rz).toMatchObject({ applied: true, epsilon: 1, propensity: 0.5, executed_as_drawn: true });
      expect(rz.drawn_technician_id).toBe(d.technician_id);
      expect(d.recommended_technician_id).toBe('a');
      seen.add(d.technician_id as string);
    }
    expect(seen.size).toBe(2);
  });

  it('flag ON is deterministic for the same job', async () => {
    const run = async () => { const { admin, decisions } = makeAdmin({ settings, jobs: [jobRow('same')], techs: [tech('a'), tech('b')], rpc: ok }); await assignJobsWithRules(admin, 'u1', [brief('same')]); return decisions[0].technician_id; };
    expect(await run()).toBe(await run());
  });

  it('flag ON but VIP job: deterministic pick and reason logged', async () => {
    const { admin, decisions, rpcCalls } = makeAdmin({ settings, jobs: [jobRow('j1', { customer_id: 'c1' })], customers: [{ id: 'c1', lifecycle_stage: 'vip', tags: [] }], techs: [tech('a'), tech('b')], rpc: ok });
    await assignJobsWithRules(admin, 'u1', [brief('j1')]);
    expect(rpcCalls[0].p_technician_id).toBe('a');
    expect((decisions[0].explanation as { randomization: Record<string, unknown> }).randomization).toMatchObject({ applied: false, reason: 'vip_job' });
  });

  it('DB gate blocks the drawn technician: falls back inside the tie set and flags executed_as_drawn=false', async () => {
    let drawn = '';
    const first = makeAdmin({ settings, jobs: [jobRow('g1')], techs: [tech('a'), tech('b')], rpc: ok });
    await assignJobsWithRules(first.admin, 'u1', [brief('g1')]);
    drawn = first.decisions[0].technician_id as string;
    const { admin, decisions } = makeAdmin({ settings, jobs: [jobRow('g1')], techs: [tech('a'), tech('b')], rpc: (a) => (a.p_technician_id === drawn ? { data: { status: 'blocked_time_off', reason: 'PTO' } } : ok(a)) });
    await assignJobsWithRules(admin, 'u1', [brief('g1')]);
    expect(decisions[0].technician_id).not.toBe(drawn);
    expect((decisions[0].explanation as { randomization: Record<string, unknown> }).randomization).toMatchObject({ drawn_technician_id: drawn, executed_as_drawn: false });
    expect(String(decisions[0].note)).toContain('PTO');
  });

  it('rule-excluded technicians are never drawn (hard constraints preserved)', async () => {
    const { admin, decisions } = makeAdmin({ settings, jobs: [jobRow('j1')], techs: [tech('a'), { ...tech('b'), skills: ['hvac'] }, tech('c')], rpc: ok });
    await assignJobsWithRules(admin, 'u1', [brief('j1')]);
    expect(['a', 'c']).toContain(decisions[0].technician_id as string);
    const rz = (decisions[0].explanation as { randomization: { tie_set: { technician_id: string }[] } }).randomization;
    expect(rz.tie_set.map((t) => t.technician_id)).not.toContain('b');
  });
});
