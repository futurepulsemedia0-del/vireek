import { describe, it, expect, vi } from 'vitest';

vi.mock('../governance/aiDecisionRecorder.ts', () => ({
  buildDispatchEvidence: vi.fn().mockResolvedValue({ confidencePct: 80, reasonFactors: [], dataUsed: [] }),
  recordAiDecision: vi.fn().mockResolvedValue(undefined),
}));

import { assignJobsWithRules } from './rulesAssign';

type Call = [string, unknown[]];
interface World {
  rules?: Record<string, unknown>[] | { error: string };
  jobs: Record<string, unknown>[];
  open?: Record<string, unknown>[];
  techs: Record<string, unknown>[];
  customers?: Record<string, unknown>[];
  rpc: (args: { p_job_id: string; p_technician_id: string | null }) => { data?: unknown; error?: { message: string } | null };
}

function makeAdmin(w: World) {
  const decisions: Record<string, unknown>[] = [];
  const rpcCalls: { p_job_id: string; p_technician_id: string | null }[] = [];
  const resolve = (table: string, calls: Call[]) => {
    const has = (m: string, a0: unknown, a1?: unknown) => calls.some(([n, a]) => n === m && a[0] === a0 && (a1 === undefined || a[1] === a1));
    switch (table) {
      case 'dispatch_rules':
        return w.rules && 'error' in (w.rules as object) ? { data: null, error: { message: (w.rules as { error: string }).error } } : { data: w.rules ?? [], error: null };
      case 'team_members': return { data: w.techs, error: null };
      case 'territories':
      case 'dispatch_technician_preferences': return { data: [], error: null };
      case 'customers': return { data: w.customers ?? [], error: null };
      case 'jobs':
        if (has('eq', 'job_status', 'completed') || has('eq', 'is_rework', true)) return { data: [], error: null };
        if (has('in', 'job_status')) return { data: w.open ?? [], error: null };
        return { data: w.jobs, error: null };
      default: return { data: [], error: null };
    }
  };
  const admin = {
    from(table: string) {
      const calls: Call[] = [];
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'not', 'gte', 'lt', 'limit', 'order']) c[m] = (...a: unknown[]) => { calls.push([m, a]); return c; };
      c.insert = (row: Record<string, unknown>) => { if (table === 'dispatch_decisions') decisions.push(row); return Promise.resolve({ error: null }); };
      c.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(resolve(table, calls)).then(ok, bad);
      return c;
    },
    rpc: vi.fn(async (_fn: string, args: { p_job_id: string; p_technician_id: string | null }) => { rpcCalls.push(args); return w.rpc(args); }),
  };
  return { admin: admin as never, decisions, rpcCalls };
}

const tech = (id: string, skills: string[]) => ({ id, member_name: id.toUpperCase(), member_email: `${id}@x.io`, skills, service_area: null, territory_id: null, max_jobs_per_day: 6, home_latitude: null, home_longitude: null, current_latitude: null, current_longitude: null });
const jobRow = (id: string, extra: Record<string, unknown> = {}) => ({ id, service_type: 'plumbing', address: '1 Main', scheduled_datetime: '2026-10-20T14:00:00.000Z', duration_minutes: 60, customer_id: null, latitude: null, longitude: null, ...extra });
const brief = (id: string, extra: Record<string, unknown> = {}) => ({ id, service_type: 'plumbing', address: '1 Main', scheduled_datetime: '2026-10-20T14:00:00.000Z', ...extra });
const skillRule = { id: 'r1', rule_type: 'skill_match', name: 'Skill match', enabled: true, mode: 'require', weight: 20, params: {}, position: 1 };
const assigned = (a: { p_technician_id: string | null }) => ({ data: { status: 'assigned', technician_id: a.p_technician_id, technician_name: a.p_technician_id?.toUpperCase() } });

describe('assignJobsWithRules', () => {
  it('uses the legacy auto-pick when no rules are enabled', async () => {
    const { admin, rpcCalls, decisions } = makeAdmin({ rules: [], jobs: [jobRow('j1')], techs: [tech('a', ['plumbing'])], rpc: () => ({ data: { status: 'assigned', technician_id: 'a', technician_name: 'A' } }) });
    const res = await assignJobsWithRules(admin, 'u1', [brief('j1')]);
    expect(res[0].engine).toBe('legacy');
    expect(rpcCalls).toEqual([{ p_job_id: 'j1', p_technician_id: null }]);
    expect(decisions).toHaveLength(0);
  });

  it('falls back to legacy when the rules tables are unavailable', async () => {
    const { admin, rpcCalls } = makeAdmin({ rules: { error: 'relation "dispatch_rules" does not exist' }, jobs: [jobRow('j1')], techs: [tech('a', [])], rpc: () => ({ data: { status: 'assigned', technician_id: 'a' } }) });
    const res = await assignJobsWithRules(admin, 'u1', [brief('j1')]);
    expect(res[0].engine).toBe('legacy');
    expect(rpcCalls[0].p_technician_id).toBeNull();
  });

  it('assigns the best rules-eligible technician explicitly and logs the explanation', async () => {
    const { admin, rpcCalls, decisions } = makeAdmin({ rules: [skillRule], jobs: [jobRow('j1')], techs: [tech('a', ['hvac']), tech('b', ['plumbing'])], rpc: assigned });
    const res = await assignJobsWithRules(admin, 'u1', [brief('j1')]);
    expect(rpcCalls).toEqual([{ p_job_id: 'j1', p_technician_id: 'b' }]);
    expect(res[0]).toMatchObject({ engine: 'rules', technicianId: 'b', technicianName: 'B' });
    expect(res[0].reason).toContain('Rules engine');
    expect(decisions[0]).toMatchObject({ user_id: 'u1', job_id: 'j1', technician_id: 'b', recommended_technician_id: 'b', mode: 'auto' });
    expect((decisions[0].explanation as { candidates: unknown[] }).candidates.length).toBe(2);
  });

  it('tries the next eligible technician when a database gate blocks the winner', async () => {
    const { admin, rpcCalls, decisions } = makeAdmin({
      rules: [skillRule],
      jobs: [jobRow('j1')],
      techs: [tech('a', ['plumbing']), tech('b', ['plumbing'])],
      rpc: (a) => (a.p_technician_id === 'a' ? { data: { status: 'blocked_time_off', reason: 'A is unavailable that day: PTO.' } } : assigned(a)),
    });
    const res = await assignJobsWithRules(admin, 'u1', [brief('j1')]);
    expect(rpcCalls.map((c) => c.p_technician_id)).toEqual(['a', 'b']);
    expect(res[0].technicianId).toBe('b');
    expect(decisions[0].recommended_technician_id).toBe('a');
    expect(decisions[0].note).toContain('A is unavailable that day: PTO.');
  });

  it('leaves the job unassigned and logs no_eligible when rules exclude everyone', async () => {
    const { admin, rpcCalls, decisions } = makeAdmin({ rules: [skillRule], jobs: [jobRow('j1')], techs: [tech('a', ['hvac'])], rpc: assigned });
    const res = await assignJobsWithRules(admin, 'u1', [brief('j1')]);
    expect(rpcCalls).toHaveLength(0);
    expect(res[0].technicianId).toBeNull();
    expect(res[0].reason).toContain('No technician satisfies your dispatch rules');
    expect(decisions[0]).toMatchObject({ mode: 'no_eligible', technician_id: null });
  });

  it('stops on a non-gate RPC failure instead of looping through technicians', async () => {
    const { admin, rpcCalls } = makeAdmin({ rules: [skillRule], jobs: [jobRow('j1')], techs: [tech('a', ['plumbing']), tech('b', ['plumbing'])], rpc: () => ({ data: null, error: { message: 'boom' } }) });
    const res = await assignJobsWithRules(admin, 'u1', [brief('j1')]);
    expect(rpcCalls).toHaveLength(1);
    expect(res[0]).toMatchObject({ technicianId: null, reason: 'boom' });
  });

  it('places VIP jobs first and counts new assignments toward capacity', async () => {
    const { admin, rpcCalls } = makeAdmin({
      rules: [{ ...skillRule, enabled: true }],
      jobs: [jobRow('early', { scheduled_datetime: '2026-10-20T08:00:00.000Z' }), jobRow('vip', { customer_id: 'c-vip', scheduled_datetime: '2026-10-20T16:00:00.000Z' })],
      customers: [{ id: 'c-vip', lifecycle_stage: 'vip', tags: [] }],
      techs: [{ ...tech('a', ['plumbing']), max_jobs_per_day: 1 }, tech('b', ['plumbing'])],
      rpc: assigned,
    });
    const res = await assignJobsWithRules(admin, 'u1', [brief('early', { scheduled_datetime: '2026-10-20T08:00:00.000Z' }), brief('vip', { scheduled_datetime: '2026-10-20T16:00:00.000Z' })]);
    expect(rpcCalls.map((c) => c.p_job_id)).toEqual(['vip', 'early']);
    expect(res.map((r) => r.technicianId)).toEqual(['a', 'b']); // a's single slot goes to the VIP job
  });
});
