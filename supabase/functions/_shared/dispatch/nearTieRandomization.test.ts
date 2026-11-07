import { describe, it, expect } from 'vitest';
import { attemptOrder, buildRandomizationLog, hash53, normalizeSettings, planRandomization, RANDOMIZATION_OFF, type RandomizationSettings } from './nearTieRandomization';
import type { RankedTechnician } from './rulesEngine';

const rt = (id: string, score: number, eligible = true): RankedTechnician => ({ technician_id: id, technician_name: id, eligible, score, rank: null, factors: [], blocked_by: [], summary: '' });
const on: RandomizationSettings = { enabled: true, epsilon: 1, top_k: 3, max_eta_delta_minutes: 10, excluded_service_types: [], salt: 'salt-1' };
const input = (over: Record<string, unknown> = {}) => ({
  settings: on, job: { id: 'job-1', service_type: 'plumbing', is_vip: false },
  ranked: [rt('a', 20), rt('b', 19.5), rt('c', 10), rt('x', 30, false)], etaMinutes: () => 20, ...over,
}) as Parameters<typeof planRandomization>[0];

describe('settings', () => {
  it('is OFF for missing, disabled or salt-less rows', () => {
    expect(normalizeSettings(null)).toEqual(RANDOMIZATION_OFF);
    expect(normalizeSettings({ enabled: false, salt: 's' }).enabled).toBe(false);
    expect(normalizeSettings({ enabled: true, salt: '' }).enabled).toBe(false);
  });
  it('clamps out-of-range values', () => {
    const s = normalizeSettings({ enabled: true, salt: 's', epsilon: 99, top_k: 99, max_eta_delta_minutes: -5 });
    expect([s.epsilon, s.top_k, s.max_eta_delta_minutes]).toEqual([10, 5, 0]);
  });
});

describe('planRandomization', () => {
  it('does nothing when disabled', () => {
    const p = planRandomization(input({ settings: RANDOMIZATION_OFF }));
    expect(p.applied).toBe(false);
    expect(p.reason).toBe('disabled');
  });
  it('draws only among eligible candidates inside the epsilon band (quality band by construction)', () => {
    for (let i = 0; i < 500; i++) {
      const p = planRandomization(input({ job: { id: `j${i}`, service_type: 'plumbing', is_vip: false } }));
      expect(p.applied).toBe(true);
      expect(['a', 'b']).toContain(p.drawnTechnicianId as string); // c is 10 points worse, x is ineligible
      expect(p.tieSet.map((t) => t.technician_id)).toEqual(['a', 'b']);
      expect(20 - (p.tieSet.find((t) => t.technician_id === p.drawnTechnicianId)!.score)).toBeLessThan(1 + 1e-9);
    }
  });
  it('is deterministic per (salt, job) and changes with the salt', () => {
    const a = planRandomization(input());
    const b = planRandomization(input());
    expect(b).toEqual(a);
    const draws = new Set(Array.from({ length: 40 }, (_, i) => planRandomization(input({ settings: { ...on, salt: `s${i}` } })).drawnTechnicianId));
    expect(draws.size).toBe(2);
  });
  it('logs a correct propensity: 1 / |tie set|, and the draw is uniform', () => {
    const counts: Record<string, number> = { a: 0, b: 0 };
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const p = planRandomization(input({ job: { id: `job-${i}`, service_type: 'plumbing', is_vip: false } }));
      expect(p.propensity).toBe(0.5);
      counts[p.drawnTechnicianId as string] += 1;
    }
    expect(Math.abs(counts.a / n - 0.5)).toBeLessThan(0.03);
    const three = planRandomization(input({ ranked: [rt('a', 20), rt('b', 20), rt('c', 19.9)] }));
    expect(three.propensity).toBeCloseTo(1 / 3, 10);
  });
  it('caps the tie set at top_k', () => {
    const p = planRandomization(input({ settings: { ...on, top_k: 2 }, ranked: [rt('a', 20), rt('b', 20), rt('c', 20)] }));
    expect(p.tieSet).toHaveLength(2);
    expect(p.propensity).toBe(0.5);
  });
  it('never randomizes VIP jobs, emergency-like or excluded services, or a single eligible candidate', () => {
    expect(planRandomization(input({ job: { id: 'j', service_type: 'plumbing', is_vip: true } })).reason).toBe('vip_job');
    expect(planRandomization(input({ job: { id: 'j', service_type: 'Emergency plumbing', is_vip: false } })).reason).toBe('excluded_service');
    expect(planRandomization(input({ job: { id: 'j', service_type: 'No Heat', is_vip: false } })).reason).toBe('excluded_service');
    expect(planRandomization(input({ settings: { ...on, excluded_service_types: ['roofing'] }, job: { id: 'j', service_type: 'Roofing', is_vip: false } })).reason).toBe('excluded_service');
    expect(planRandomization(input({ ranked: [rt('a', 20), rt('b', 20, false)] })).reason).toBe('fewer_than_two_tied');
  });
  it('never randomizes when ETAs differ by more than the limit or are unknown (fail closed)', () => {
    const eta = (m: Record<string, number | null>) => (id: string) => m[id] ?? null;
    expect(planRandomization(input({ etaMinutes: eta({ a: 10, b: 25 }) })).reason).toBe('eta_delta_exceeded');
    expect(planRandomization(input({ etaMinutes: eta({ a: 10, b: null }) })).reason).toBe('eta_unknown');
    expect(planRandomization(input({ etaMinutes: eta({ a: 10, b: 20 }) })).applied).toBe(true);
  });
  it('does not alter the ranking input', () => {
    const ranked = [rt('a', 20), rt('b', 20)];
    const copy = JSON.stringify(ranked);
    planRandomization(input({ ranked }));
    expect(JSON.stringify(ranked)).toBe(copy);
  });
});

describe('attemptOrder / log', () => {
  const elig = [rt('a', 20), rt('b', 19.5), rt('c', 10)];
  it('tries the drawn technician, then other tie members, then the rest', () => {
    const plan = planRandomization(input({ ranked: [...elig, rt('x', 1, false)] }));
    const order = attemptOrder(elig, plan).map((r) => r.technician_id);
    expect(order[0]).toBe(plan.drawnTechnicianId);
    expect(order[2]).toBe('c');
    expect(order).toHaveLength(3);
  });
  it('keeps engine order when not applied', () => {
    expect(attemptOrder(elig, planRandomization(input({ settings: RANDOMIZATION_OFF }))).map((r) => r.technician_id)).toEqual(['a', 'b', 'c']);
  });
  it('flags when the executed technician differs from the draw', () => {
    const plan = planRandomization(input());
    expect(buildRandomizationLog(plan, plan.drawnTechnicianId).executed_as_drawn).toBe(true);
    expect(buildRandomizationLog(plan, 'c').executed_as_drawn).toBe(false);
    expect(buildRandomizationLog(planRandomization(input({ settings: RANDOMIZATION_OFF })), 'a').executed_as_drawn).toBeNull();
  });
});

describe('hash53', () => {
  it('is stable', () => {
    expect(hash53('x')).toBe(hash53('x'));
    expect(hash53('x')).not.toBe(hash53('y'));
  });
});
