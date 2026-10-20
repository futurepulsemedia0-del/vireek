import { describe, it, expect } from 'vitest';
import {
  allocateShares,
  bpsToPercentInput,
  describeCrewError,
  draftFromCrew,
  effectiveShares,
  formatBps,
  formatMinutes,
  normalizeSkills,
  percentInputToBps,
  plannedCommissionShares,
  plannedLaborShares,
  seedManualShares,
  skillGaps,
  splitCents,
  toRpcMembers,
  validateCrewDraft,
  type CrewDraft,
  type CrewDraftMember,
  type JobCrew,
} from './jobCrew';

function member(technicianId: string, role: CrewDraftMember['role'], laborBps = 0, commissionBps = 0): CrewDraftMember {
  return { technicianId, role, laborBps, commissionBps };
}

function draft(over: Partial<CrewDraft> = {}): CrewDraft {
  return {
    members: [member('a', 'lead'), member('b', 'helper')],
    laborMode: 'role_weights',
    commissionMode: 'role_weights',
    requiredSkills: [],
    ...over,
  };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('allocateShares', () => {
  it('splits by weight and always totals exactly', () => {
    expect(allocateShares([50, 30, 20], 10000)).toEqual([5000, 3000, 2000]);
    expect(allocateShares([50, 30, 30], 10000)).toEqual([4546, 2727, 2727]);
  });

  it('gives leftover units to the largest remainder, earliest index on ties', () => {
    expect(allocateShares([1, 1, 1], 100)).toEqual([34, 33, 33]);
    expect(allocateShares([1, 1], 1)).toEqual([1, 0]);
  });

  it('falls back to an equal split when every weight is zero', () => {
    expect(allocateShares([0, 0, 0, 0], 10000)).toEqual([2500, 2500, 2500, 2500]);
  });

  it('keeps a zero-weight member at zero', () => {
    expect(allocateShares([120, 60, 0], 10000)).toEqual([6667, 3333, 0]);
  });

  it('handles empty input and zero totals', () => {
    expect(allocateShares([], 100)).toEqual([]);
    expect(allocateShares([3, 2], 0)).toEqual([0, 0]);
  });

  it('rejects invalid weights and totals', () => {
    expect(() => allocateShares([-1, 2], 100)).toThrow();
    expect(() => allocateShares([1.5, 2], 100)).toThrow();
    expect(() => allocateShares([1, 2], -5)).toThrow();
    expect(() => allocateShares([1, 2], 10.5)).toThrow();
  });

  it('never loses or invents a cent (randomised)', () => {
    let seed = 12345;
    const rand = (max: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % max;
    };
    for (let i = 0; i < 300; i += 1) {
      const n = 1 + rand(12);
      const weights = Array.from({ length: n }, () => rand(100));
      const total = rand(5_000_000);
      const out = allocateShares(weights, total);
      expect(sum(out)).toBe(total);
      expect(out.every((x) => Number.isInteger(x) && x >= 0)).toBe(true);
    }
  });
});

describe('splitCents', () => {
  it('splits money by basis-point shares without losing a cent', () => {
    const parts = splitCents(10001, [5000, 3000, 2000]);
    expect(sum(parts)).toBe(10001);
    expect(parts).toEqual([5001, 3000, 2000]);
  });
});

describe('planned shares', () => {
  const members = [member('a', 'lead'), member('b', 'helper'), member('c', 'apprentice')];

  it('role weights', () => {
    expect(plannedLaborShares({ members, laborMode: 'role_weights' })).toEqual([5000, 3000, 2000]);
  });

  it('equal', () => {
    expect(plannedLaborShares({ members, laborMode: 'equal' })).toEqual([3334, 3333, 3333]);
  });

  it('actual_hours falls back to role weights as the stored plan', () => {
    expect(plannedLaborShares({ members, laborMode: 'actual_hours' })).toEqual([5000, 3000, 2000]);
  });

  it('manual passes the typed values through', () => {
    const m = [member('a', 'lead', 7000), member('b', 'helper', 3000)];
    expect(plannedLaborShares({ members: m, laborMode: 'manual' })).toEqual([7000, 3000]);
  });

  it('commission can follow the labor split', () => {
    const d = { members, laborMode: 'equal' as const, commissionMode: 'labor' as const };
    expect(plannedCommissionShares(d)).toEqual([3334, 3333, 3333]);
  });

  it('commission by role when labor is something else', () => {
    const d = { members, laborMode: 'equal' as const, commissionMode: 'role_weights' as const };
    expect(plannedCommissionShares(d)).toEqual([5000, 3000, 2000]);
  });
});

describe('effectiveShares', () => {
  const planned = [5000, 3000, 2000];

  it('uses the plan when the mode is not actual_hours', () => {
    const r = effectiveShares({ plannedLabor: planned, plannedCommission: planned, minutes: [10, 10, 10], laborMode: 'role_weights', commissionMode: 'role_weights' });
    expect(r.labor).toEqual(planned);
    expect(r.commission).toEqual(planned);
  });

  it('uses each person’s own minutes in actual_hours mode', () => {
    const r = effectiveShares({ plannedLabor: planned, plannedCommission: planned, minutes: [120, 60, 0], laborMode: 'actual_hours', commissionMode: 'role_weights' });
    expect(r.labor).toEqual([6667, 3333, 0]);
    expect(r.commission).toEqual(planned);
  });

  it('falls back to the plan until anyone has worked a minute', () => {
    const r = effectiveShares({ plannedLabor: planned, plannedCommission: planned, minutes: [0, 0, 0], laborMode: 'actual_hours', commissionMode: 'labor' });
    expect(r.labor).toEqual(planned);
    expect(r.commission).toEqual(planned);
  });

  it('commission follows actual hours when set to labor', () => {
    const r = effectiveShares({ plannedLabor: planned, plannedCommission: planned, minutes: [30, 90, 0], laborMode: 'actual_hours', commissionMode: 'labor' });
    expect(r.commission).toEqual(r.labor);
    expect(sum(r.commission)).toBe(10000);
  });

  it('normalises plans that no longer total 100% (a removed technician)', () => {
    const r = effectiveShares({ plannedLabor: [5000, 3000], plannedCommission: [5000, 3000], minutes: [0, 0], laborMode: 'role_weights', commissionMode: 'role_weights' });
    expect(sum(r.labor)).toBe(10000);
    expect(r.labor).toEqual([6250, 3750]);
  });
});

describe('skills', () => {
  it('normalises, de-duplicates and caps', () => {
    expect(normalizeSkills([' HVAC ', 'hvac', '', 'Gas Line'])).toEqual(['hvac', 'gas line']);
    expect(normalizeSkills(Array.from({ length: 30 }, (_, i) => `s${i}`))).toHaveLength(20);
    expect(normalizeSkills(['x'.repeat(60)])[0]).toHaveLength(40);
  });

  it('finds required skills nobody on the crew has', () => {
    expect(skillGaps(['HVAC', 'Electrical'], [['hvac'], ['plumbing']])).toEqual(['electrical']);
    expect(skillGaps(['hvac'], [['HVAC ']])).toEqual([]);
    expect(skillGaps([], [['hvac']])).toEqual([]);
  });
});

describe('validateCrewDraft', () => {
  it('accepts an empty roster (no crew) and a valid crew', () => {
    expect(validateCrewDraft(draft({ members: [] }))).toBeNull();
    expect(validateCrewDraft(draft())).toBeNull();
  });

  it('needs at least two people', () => {
    expect(validateCrewDraft(draft({ members: [member('a', 'lead')] }))).toMatch(/at least two/i);
  });

  it('caps the crew size', () => {
    const many = Array.from({ length: 13 }, (_, i) => member(`t${i}`, i === 0 ? 'lead' : 'helper'));
    expect(validateCrewDraft(draft({ members: many }))).toMatch(/at most 12/i);
  });

  it('rejects duplicates and missing technicians', () => {
    expect(validateCrewDraft(draft({ members: [member('a', 'lead'), member('a', 'helper')] }))).toMatch(/only appear once/i);
    expect(validateCrewDraft(draft({ members: [member('a', 'lead'), member('', 'helper')] }))).toMatch(/choose a technician/i);
  });

  it('requires exactly one lead', () => {
    expect(validateCrewDraft(draft({ members: [member('a', 'helper'), member('b', 'apprentice')] }))).toMatch(/exactly one lead/i);
    expect(validateCrewDraft(draft({ members: [member('a', 'lead'), member('b', 'lead')] }))).toMatch(/only one person/i);
  });

  it('checks manual shares total 100%', () => {
    const bad = draft({ laborMode: 'manual', members: [member('a', 'lead', 6000), member('b', 'helper', 3000)] });
    expect(validateCrewDraft(bad)).toMatch(/labor shares total 90%/i);
    const good = draft({ laborMode: 'manual', members: [member('a', 'lead', 6000), member('b', 'helper', 4000)] });
    expect(validateCrewDraft(good)).toBeNull();
    const badCommission = draft({ commissionMode: 'manual', members: [member('a', 'lead', 0, 5000), member('b', 'helper', 0, 6000)] });
    expect(validateCrewDraft(badCommission)).toMatch(/commission shares total 110%/i);
  });

  it('rejects out-of-range manual values', () => {
    const d = draft({ laborMode: 'manual', members: [member('a', 'lead', 12000), member('b', 'helper', -2000)] });
    expect(validateCrewDraft(d)).toMatch(/between 0% and 100%/i);
  });
});

describe('toRpcMembers / draftFromCrew / seedManualShares', () => {
  it('only sends manual values in manual modes', () => {
    const d = draft({ laborMode: 'manual', members: [member('a', 'lead', 6000, 111), member('b', 'helper', 4000, 222)] });
    expect(toRpcMembers(d)).toEqual([
      { technician_id: 'a', role: 'lead', labor_bps: 6000, commission_bps: 0 },
      { technician_id: 'b', role: 'helper', labor_bps: 4000, commission_bps: 0 },
    ]);
  });

  it('starts a new crew with just the lead', () => {
    const d = draftFromCrew(null, 'lead-1');
    expect(d.members).toEqual([member('lead-1', 'lead')]);
    expect(draftFromCrew(null, null).members).toEqual([]);
  });

  it('round-trips a saved crew', () => {
    const crew: JobCrew = {
      has_crew: true,
      can_manage: true,
      can_see_money: true,
      labor_mode: 'actual_hours',
      commission_mode: 'labor',
      required_skills: ['hvac'],
      skill_gaps: [],
      total_minutes: 0,
      members: [
        { assignment_id: '1', technician_id: 'a', name: 'A', role: 'lead', skills: [], net_minutes: 0, labor_bps: 5000, commission_bps: 5000, labor_cost_cents: 0 },
        { assignment_id: '2', technician_id: 'b', name: 'B', role: 'helper', skills: [], net_minutes: 0, labor_bps: null, commission_bps: null, labor_cost_cents: null },
      ],
    };
    const d = draftFromCrew(crew, 'a');
    expect(d.laborMode).toBe('actual_hours');
    expect(d.members[1]).toEqual(member('b', 'helper', 0, 0));
    expect(d.requiredSkills).toEqual(['hvac']);
  });

  it('seeds manual shares from the role split', () => {
    const seeded = seedManualShares(draft());
    expect(seeded.members.map((m) => m.laborBps)).toEqual([6250, 3750]);
    expect(sum(seeded.members.map((m) => m.commissionBps))).toBe(10000);
  });
});

describe('formatting', () => {
  it('formats basis points', () => {
    expect(formatBps(5000)).toBe('50%');
    expect(formatBps(3333)).toBe('33.33%');
    expect(formatBps(3350)).toBe('33.5%');
    expect(formatBps(0)).toBe('0%');
  });

  it('parses percent input strictly', () => {
    expect(percentInputToBps('33.33')).toBe(3333);
    expect(percentInputToBps(' 50 ')).toBe(5000);
    expect(percentInputToBps('12,5')).toBe(1250);
    expect(percentInputToBps('100')).toBe(10000);
    expect(percentInputToBps('100.5')).toBeNull();
    expect(percentInputToBps('abc')).toBeNull();
    expect(percentInputToBps('-5')).toBeNull();
    expect(percentInputToBps('1.234')).toBeNull();
    expect(percentInputToBps('')).toBeNull();
  });

  it('round-trips percent text', () => {
    expect(bpsToPercentInput(3333)).toBe('33.33');
    expect(percentInputToBps(bpsToPercentInput(3333))).toBe(3333);
  });

  it('formats minutes', () => {
    expect(formatMinutes(0)).toBe('0m');
    expect(formatMinutes(45)).toBe('45m');
    expect(formatMinutes(120)).toBe('2h');
    expect(formatMinutes(135)).toBe('2h 15m');
    expect(formatMinutes(Number.NaN)).toBe('0m');
  });
});

describe('describeCrewError', () => {
  it('maps known database errors', () => {
    expect(describeCrewError({ message: 'crew_needs_one_lead' })).toMatch(/exactly one lead/i);
    expect(describeCrewError({ message: 'ERROR: crew_unassign_blocked: remove the crew' })).toMatch(/remove the crew/i);
    expect(describeCrewError({ message: 'This job is already on a statement. Void it.' })).toMatch(/statement/i);
    expect(describeCrewError({ code: '42501', message: 'denied' })).toMatch(/permission/i);
  });

  it('has a safe fallback', () => {
    expect(describeCrewError(null)).toMatch(/could not save/i);
    expect(describeCrewError({ message: 'boom' })).toMatch(/could not save/i);
  });
});
