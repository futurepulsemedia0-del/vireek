import { describe, it, expect } from 'vitest';
import {
  haversineMiles,
  loadsForDay,
  rankTechnicians,
  snapshotForAudit,
  type DispatchRule,
  type EngineInput,
  type EngineJob,
  type EngineTechnician,
} from './rulesEngine';

const rule = (o: Partial<DispatchRule> & Pick<DispatchRule, 'rule_type'>): DispatchRule => ({
  id: `r-${o.rule_type}`, name: o.rule_type, enabled: true, mode: 'score', weight: 20, params: {}, position: 0, ...o,
});

const tech = (o: Partial<EngineTechnician> & { id: string }): EngineTechnician => ({
  name: o.id.toUpperCase(), skills: [], service_area: null, territory_id: null, lat: null, lon: null, max_jobs_per_day: 6, quality: null, ...o,
});

const job = (o: Partial<EngineJob> = {}): EngineJob => ({
  id: 'job-1', service_type: 'plumbing', address: '12 Main St, Austin', lat: null, lon: null, duration_minutes: 60, customer_id: 'c1', is_vip: false, ...o,
});

function input(o: Partial<EngineInput> & { technicians: EngineTechnician[] }): EngineInput {
  return { job: job(), rules: [], territories: [], preferences: [], loads: {}, ...o };
}

describe('haversineMiles', () => {
  it('is 0 for the same point and ~69 mi per degree of latitude', () => {
    expect(haversineMiles(30, -97, 30, -97)).toBe(0);
    expect(haversineMiles(30, -97, 31, -97)).toBeGreaterThan(68);
    expect(haversineMiles(30, -97, 31, -97)).toBeLessThan(70);
  });
});

describe('rankTechnicians — base behaviour', () => {
  it('with no rules, load-balances: the less busy technician wins', () => {
    const r = rankTechnicians(input({ technicians: [tech({ id: 'a' }), tech({ id: 'b' })], loads: { a: { jobs: 4, minutes: 240 } } }));
    expect(r.best?.technician_id).toBe('b');
    expect(r.rules_applied).toBe(0);
  });

  it('excludes technicians at capacity and says why', () => {
    const r = rankTechnicians(input({ technicians: [tech({ id: 'a', max_jobs_per_day: 2 })], loads: { a: { jobs: 2, minutes: 120 } } }));
    expect(r.best).toBeNull();
    expect(r.ranked[0].eligible).toBe(false);
    expect(r.ranked[0].summary).toContain('At capacity (2/2 jobs)');
  });

  it('ignores disabled rules', () => {
    const r = rankTechnicians(input({ technicians: [tech({ id: 'a' })], rules: [rule({ rule_type: 'skill_match', mode: 'require', enabled: false })] }));
    expect(r.best?.technician_id).toBe('a');
    expect(r.rules_applied).toBe(0);
  });

  it('is deterministic on ties (stable by id)', () => {
    const r = rankTechnicians(input({ technicians: [tech({ id: 'z' }), tech({ id: 'a' })] }));
    expect(r.ranked.map((x) => x.technician_id)).toEqual(['a', 'z']);
    expect(r.margin).toBe(0);
  });
});

describe('skill_match', () => {
  const techs = [tech({ id: 'a', skills: ['Plumbing'] }), tech({ id: 'b', skills: ['hvac'] })];

  it('require mode excludes technicians without the skill (case-insensitive)', () => {
    const r = rankTechnicians(input({ technicians: techs, rules: [rule({ rule_type: 'skill_match', mode: 'require' })] }));
    expect(r.ranked.filter((x) => x.eligible).map((x) => x.technician_id)).toEqual(['a']);
    expect(r.ranked.find((x) => x.technician_id === 'b')?.blocked_by[0]).toContain('No listed skill for plumbing');
  });

  it('score mode only boosts and never excludes', () => {
    const r = rankTechnicians(input({ technicians: techs, rules: [rule({ rule_type: 'skill_match', weight: 30 })] }));
    expect(r.ranked.every((x) => x.eligible)).toBe(true);
    expect(r.best?.technician_id).toBe('a');
    expect(r.margin).toBe(30);
  });

  it('is neutral when the job has no service type', () => {
    const r = rankTechnicians(input({ job: job({ service_type: null }), technicians: techs, rules: [rule({ rule_type: 'skill_match', mode: 'require' })] }));
    expect(r.ranked.every((x) => x.eligible)).toBe(true);
  });
});

describe('zone', () => {
  const territories = [{ id: 'north', name: 'North', center_latitude: 30.5, center_longitude: -97.7, radius_miles: 10 }];

  it('uses territory radius when the job is geocoded', () => {
    const r = rankTechnicians(input({
      job: job({ lat: 30.51, lon: -97.7 }),
      territories,
      technicians: [tech({ id: 'in', territory_id: 'north' }), tech({ id: 'far', territory_id: 'north' })],
      rules: [rule({ rule_type: 'zone', mode: 'require' })],
    }));
    expect(r.ranked.every((x) => x.eligible)).toBe(true);
    const out = rankTechnicians(input({
      job: job({ lat: 31.5, lon: -97.7 }), territories,
      technicians: [tech({ id: 'a', territory_id: 'north' })],
      rules: [rule({ rule_type: 'zone', mode: 'require' })],
    }));
    expect(out.best).toBeNull();
    expect(out.ranked[0].blocked_by[0]).toContain('Outside zone North');
  });

  it('falls back to service_area text match', () => {
    const r = rankTechnicians(input({
      technicians: [tech({ id: 'a', service_area: 'Austin' }), tech({ id: 'b', service_area: 'Dallas' })],
      rules: [rule({ rule_type: 'zone', mode: 'require' })],
    }));
    expect(r.ranked.filter((x) => x.eligible).map((x) => x.technician_id)).toEqual(['a']);
  });

  it('unknown zone data is allowed by default and blocked with unknown_policy=block', () => {
    const open = rankTechnicians(input({ technicians: [tech({ id: 'a' })], rules: [rule({ rule_type: 'zone', mode: 'require' })] }));
    expect(open.best?.technician_id).toBe('a');
    const strict = rankTechnicians(input({ technicians: [tech({ id: 'a' })], rules: [rule({ rule_type: 'zone', mode: 'require', params: { unknown_policy: 'block' } })] }));
    expect(strict.best).toBeNull();
  });
});

describe('vip_priority', () => {
  const techs = [tech({ id: 'ace', quality: 0.95 }), tech({ id: 'new', quality: null }), tech({ id: 'meh', quality: 0.6 })];

  it('does nothing for non-VIP jobs', () => {
    const r = rankTechnicians(input({ technicians: techs, rules: [rule({ rule_type: 'vip_priority', weight: 40 })] }));
    expect(r.ranked.every((x) => x.factors.find((f) => f.rule_type === 'vip_priority')?.points === 0)).toBe(true);
  });

  it('score mode favors high-quality technicians on VIP jobs', () => {
    const r = rankTechnicians(input({ job: job({ is_vip: true }), technicians: techs, rules: [rule({ rule_type: 'vip_priority', weight: 40 })] }));
    expect(r.ranked.map((x) => x.technician_id)).toEqual(['ace', 'meh', 'new']);
    expect(r.best?.technician_id).toBe('ace');
  });

  it('require mode enforces min_quality but allows unknown history', () => {
    const r = rankTechnicians(input({ job: job({ is_vip: true }), technicians: techs, rules: [rule({ rule_type: 'vip_priority', mode: 'require', params: { min_quality: 0.9 } })] }));
    expect(r.ranked.filter((x) => x.eligible).map((x) => x.technician_id).sort()).toEqual(['ace', 'new']);
  });
});

describe('max_drive_time', () => {
  const j = job({ lat: 30.0, lon: -97.0 });
  const near = tech({ id: 'near', lat: 30.05, lon: -97.0 });
  const far = tech({ id: 'far', lat: 31.0, lon: -97.0 });

  it('require mode excludes technicians beyond the limit', () => {
    const r = rankTechnicians(input({ job: j, technicians: [near, far], rules: [rule({ rule_type: 'max_drive_time', mode: 'require', params: { max_minutes: 45 } })] }));
    expect(r.ranked.filter((x) => x.eligible).map((x) => x.technician_id)).toEqual(['near']);
    expect(r.ranked.find((x) => x.technician_id === 'far')?.blocked_by[0]).toMatch(/exceeds 45 min limit/);
  });

  it('score mode rewards closeness and penalizes beyond the limit', () => {
    const r = rankTechnicians(input({ job: j, technicians: [near, far], rules: [rule({ rule_type: 'max_drive_time', weight: 30, params: { max_minutes: 45 } })] }));
    const pts = (id: string) => r.ranked.find((x) => x.technician_id === id)!.factors.find((f) => f.rule_type === 'max_drive_time')!.points;
    expect(pts('near')).toBeGreaterThan(20);
    expect(pts('far')).toBe(-30);
    expect(r.best?.technician_id).toBe('near');
  });

  it('missing coordinates are not scored (and block only with unknown_policy=block)', () => {
    const r = rankTechnicians(input({ job: j, technicians: [tech({ id: 'a' })], rules: [rule({ rule_type: 'max_drive_time', mode: 'require' })] }));
    expect(r.best?.technician_id).toBe('a');
    const strict = rankTechnicians(input({ job: j, technicians: [tech({ id: 'a' })], rules: [rule({ rule_type: 'max_drive_time', mode: 'require', params: { unknown_policy: 'block' } })] }));
    expect(strict.best).toBeNull();
  });
});

describe('tech_preference', () => {
  const techs = [tech({ id: 'a' }), tech({ id: 'b' })];
  const base = rule({ rule_type: 'tech_preference', weight: 25 });

  it('prefer boosts, avoid penalizes (matching customer)', () => {
    const r = rankTechnicians(input({ technicians: techs, rules: [base], preferences: [
      { technician_id: 'b', customer_id: 'c1', service_type: null, preference: 'prefer' },
      { technician_id: 'a', customer_id: 'c1', service_type: null, preference: 'avoid' },
    ] }));
    expect(r.best?.technician_id).toBe('b');
    expect(r.ranked.find((x) => x.technician_id === 'a')?.score).toBe(-15); // 10 capacity − 25 avoid
  });

  it('ignores preferences for other customers or service types', () => {
    const r = rankTechnicians(input({ technicians: techs, rules: [base], preferences: [
      { technician_id: 'b', customer_id: 'other', service_type: null, preference: 'prefer' },
      { technician_id: 'b', customer_id: null, service_type: 'hvac', preference: 'prefer' },
    ] }));
    expect(r.margin).toBe(0);
  });

  it('require excludes everyone else regardless of mode', () => {
    const r = rankTechnicians(input({ technicians: techs, rules: [base], preferences: [{ technician_id: 'a', customer_id: 'c1', service_type: null, preference: 'require' }] }));
    expect(r.ranked.filter((x) => x.eligible).map((x) => x.technician_id)).toEqual(['a']);
    expect(r.ranked.find((x) => x.technician_id === 'b')?.blocked_by[0]).toContain('requires A');
  });

  it('avoid in require mode excludes the technician', () => {
    const r = rankTechnicians(input({ technicians: techs, rules: [{ ...base, mode: 'require' }], preferences: [{ technician_id: 'a', customer_id: 'c1', service_type: null, preference: 'avoid' }] }));
    expect(r.ranked.filter((x) => x.eligible).map((x) => x.technician_id)).toEqual(['b']);
  });
});

describe('overtime_limit', () => {
  const techs = [tech({ id: 'busy' }), tech({ id: 'free' })];
  const loads = { busy: { jobs: 4, minutes: 540 } };

  it('require mode excludes anyone who would exceed the daily limit', () => {
    const r = rankTechnicians(input({ technicians: techs, loads, rules: [rule({ rule_type: 'overtime_limit', mode: 'require', params: { max_daily_minutes: 560 } })] }));
    expect(r.ranked.filter((x) => x.eligible).map((x) => x.technician_id)).toEqual(['free']);
    expect(r.ranked.find((x) => x.technician_id === 'busy')?.blocked_by[0]).toContain('Day would reach 10h00m (limit 9h20m)');
  });

  it('score mode scales a penalty once past 80% of the limit', () => {
    const r = rankTechnicians(input({ technicians: techs, loads, rules: [rule({ rule_type: 'overtime_limit', weight: 40, params: { max_daily_minutes: 720 } })] }));
    const busy = r.ranked.find((x) => x.technician_id === 'busy')!;
    expect(busy.factors.find((f) => f.rule_type === 'overtime_limit')!.points).toBeLessThan(0);
    expect(r.best?.technician_id).toBe('free');
  });

  it('uses the job duration, falling back to the default', () => {
    const r = rankTechnicians(input({ job: job({ duration_minutes: null }), technicians: [tech({ id: 'a' })], loads: { a: { jobs: 1, minutes: 500 } }, rules: [rule({ rule_type: 'overtime_limit', mode: 'require', params: { max_daily_minutes: 540 } })] }));
    expect(r.best).toBeNull(); // 500 + default 60 = 560 > 540
  });
});

describe('combined rules + explanations', () => {
  it('stacks rules, explains the winner and exposes a margin', () => {
    const j = job({ lat: 30.0, lon: -97.0, is_vip: true });
    const r = rankTechnicians(input({
      job: j,
      technicians: [
        tech({ id: 'a', skills: ['plumbing'], lat: 30.05, lon: -97.0, quality: 0.9 }),
        tech({ id: 'b', skills: ['plumbing'], lat: 30.4, lon: -97.0, quality: 0.99 }),
        tech({ id: 'c', skills: ['hvac'], lat: 30.01, lon: -97.0, quality: 1 }),
      ],
      rules: [
        rule({ rule_type: 'skill_match', mode: 'require', position: 1 }),
        rule({ rule_type: 'max_drive_time', weight: 30, position: 2, params: { max_minutes: 60 } }),
        rule({ rule_type: 'vip_priority', weight: 20, position: 3 }),
      ],
    }));
    expect(r.best?.technician_id).toBe('a');
    expect(r.best?.summary).toContain('min drive');
    expect(r.ranked.at(-1)?.technician_id).toBe('c');
    expect(r.ranked.at(-1)?.eligible).toBe(false);
    expect(r.margin).toBeGreaterThan(0);
    expect(r.best?.rank).toBe(1);
  });

  it('snapshotForAudit is bounded and drops neutral noise', () => {
    const many = Array.from({ length: 9 }, (_, i) => tech({ id: `t${i}` }));
    const r = rankTechnicians(input({ technicians: many, rules: [rule({ rule_type: 'skill_match' })] }));
    const snap = snapshotForAudit(r);
    expect(snap).toHaveLength(5);
    expect(snap[0].factors.every((f) => f.outcome !== 'neutral')).toBe(true);
  });
});

describe('loadsForDay', () => {
  it('sums per-technician jobs and minutes for the day, excluding the job itself', () => {
    const open = [
      { id: 'j1', technician_id: 'a', day: '2026-10-20', minutes: 60 },
      { id: 'j2', technician_id: 'a', day: '2026-10-20', minutes: 90 },
      { id: 'j3', technician_id: 'a', day: '2026-10-21', minutes: 30 },
      { id: 'self', technician_id: 'b', day: '2026-10-20', minutes: 45 },
    ];
    expect(loadsForDay(open, '2026-10-20', 'self')).toEqual({ a: { jobs: 2, minutes: 150 } });
  });
});
