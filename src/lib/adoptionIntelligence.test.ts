import { describe, expect, it } from 'vitest';
import {
  adoptionTrend,
  buildOnboardingPlan,
  computeAdoption,
  computeAdoptionSummary,
  interventionOutcome,
  SCORE_WEIGHTS,
  type AdoptionSignalRow,
} from '@/lib/adoptionIntelligence';

function row(overrides: Partial<AdoptionSignalRow> = {}): AdoptionSignalRow {
  return {
    team_member_id: 't1',
    member_name: 'Sam',
    member_email: 'sam@example.com',
    jobs_completed: 0,
    jobs_with_ai: 0,
    ai_sessions: 0,
    jobs_with_photos: 0,
    jobs_with_diagnosis: 0,
    jobs_with_work_notes: 0,
    jobs_with_evidence: 0,
    jobs_with_signature: 0,
    lessons_completed: 0,
    simulator_attempts: 0,
    ...overrides,
  };
}

const technicianA = row({
  team_member_id: 'a',
  member_name: 'Technician A',
  jobs_completed: 25,
  jobs_with_ai: 21,
  ai_sessions: 30,
  jobs_with_photos: 25,
  jobs_with_diagnosis: 24,
  jobs_with_work_notes: 24,
  jobs_with_evidence: 23,
  jobs_with_signature: 24,
});

const technicianB = row({
  team_member_id: 'b',
  member_name: 'Technician B',
  jobs_completed: 12,
  jobs_with_ai: 2,
  ai_sessions: 2,
  jobs_with_photos: 5,
  jobs_with_diagnosis: 5,
  jobs_with_work_notes: 5,
  jobs_with_evidence: 5,
  jobs_with_signature: 5,
});

describe('score weights', () => {
  it('sum to exactly 1', () => {
    expect(SCORE_WEIGHTS.ai + SCORE_WEIGHTS.documentation).toBe(1);
  });
});

describe('computeAdoption', () => {
  it('rates a heavy AI + documentation user as high', () => {
    const a = computeAdoption(technicianA);
    expect(a.aiUsagePct).toBe(84);
    expect(a.level).toBe('high');
    expect(a.gaps).toEqual([]);
  });

  it('rates a low AI + weak documentation user as low', () => {
    const b = computeAdoption(technicianB);
    expect(b.aiUsagePct).toBe(17);
    expect(b.documentationPct).toBe(42);
    expect(b.score).toBe(28);
    expect(b.level).toBe('low');
    expect(b.gaps[0]).toBe('ai');
  });

  it('refuses to assign a level below the minimum job count', () => {
    const a = computeAdoption(row({ jobs_completed: 2, jobs_with_ai: 2 }));
    expect(a.level).toBe('insufficient');
    expect(a.score).toBeNull();
  });

  it('never produces NaN when there are no jobs', () => {
    const a = computeAdoption(row());
    expect(a.aiUsagePct).toBeNull();
    expect(a.documentationPct).toBeNull();
    expect(a.weakestPart).toBeNull();
    expect(a.level).toBe('insufficient');
  });

  it('clamps counts that exceed completed jobs and ignores bad values', () => {
    const a = computeAdoption(
      row({ jobs_completed: 4, jobs_with_ai: 9, jobs_with_photos: -3, jobs_with_evidence: Number.NaN }),
    );
    expect(a.aiUsagePct).toBe(100);
    expect(a.breakdown.find((b) => b.part === 'photos')?.pct).toBe(0);
    expect(a.breakdown.find((b) => b.part === 'evidence')?.pct).toBe(0);
  });

  it('falls back to the email when the technician has no name', () => {
    expect(computeAdoption(row({ member_name: '  ' })).name).toBe('sam@example.com');
  });
});

describe('buildOnboardingPlan', () => {
  it('leads with the biggest gap and stays short', () => {
    const plan = buildOnboardingPlan(computeAdoption(technicianB));
    expect(plan[0].dimension).toBe('ai');
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.length <= 4).toBe(true);
    expect(plan[plan.length - 1].id).toBe('learn-apprenticeship');
  });

  it('returns no plan for high adoption or too little data', () => {
    expect(buildOnboardingPlan(computeAdoption(technicianA))).toEqual([]);
    expect(buildOnboardingPlan(computeAdoption(row()))).toEqual([]);
  });

  it('targets documentation when AI usage is already strong', () => {
    const plan = buildOnboardingPlan(
      computeAdoption(
        row({
          jobs_completed: 10,
          jobs_with_ai: 9,
          jobs_with_photos: 0,
          jobs_with_diagnosis: 5,
          jobs_with_work_notes: 5,
          jobs_with_evidence: 2,
          jobs_with_signature: 0,
        }),
      ),
    );
    expect(plan[0].dimension).toBe('documentation');
    expect(plan[0].id).toBe('doc-photos');
  });
});

describe('computeAdoptionSummary', () => {
  it('counts levels and the adoption rate over measured technicians only', () => {
    const list = [technicianA, technicianB, row({ team_member_id: 'c', jobs_completed: 1 })].map(
      computeAdoption,
    );
    const s = computeAdoptionSummary(list);
    expect(s.technicians).toBe(3);
    expect(s.measured).toBe(2);
    expect(s.high).toBe(1);
    expect(s.low).toBe(1);
    expect(s.insufficient).toBe(1);
    expect(s.adoptionRatePct).toBe(50);
  });

  it('handles an empty team', () => {
    const s = computeAdoptionSummary([]);
    expect(s.adoptionRatePct).toBeNull();
    expect(s.weakestTeamPart).toBeNull();
  });
});

describe('trend and intervention outcome', () => {
  it('classifies score movement', () => {
    expect(adoptionTrend(70, 50)).toBe('improving');
    expect(adoptionTrend(50, 70)).toBe('declining');
    expect(adoptionTrend(52, 50)).toBe('steady');
    expect(adoptionTrend(null, 50)).toBe('unknown');
  });

  it('judges whether an onboarding plan worked', () => {
    expect(interventionOutcome(28, 61)).toEqual({ verdict: 'improved', delta: 33 });
    expect(interventionOutcome(60, 58)).toEqual({ verdict: 'unchanged', delta: -2 });
    expect(interventionOutcome(60, 40)).toEqual({ verdict: 'declined', delta: -20 });
    expect(interventionOutcome(null, 40)).toEqual({ verdict: 'unmeasured', delta: null });
  });
});
