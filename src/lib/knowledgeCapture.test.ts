import { describe, expect, it } from 'vitest';
import {
  availableActions,
  computeExpertRisk,
  confidenceTier,
  DEPLOY_CONFIDENCE_FLOOR,
  equipmentLabel,
  explainConfidence,
  formatRuleSentence,
  outcomeRate,
  parseSymptoms,
  type ExpertRiskRow,
  type KceRule,
} from './knowledgeCapture';

const NOW = new Date('2027-03-01T00:00:00Z');

const baseRisk: ExpertRiskRow = {
  team_member_id: 'm1',
  member_name: 'Sam',
  expected_departure: null,
  notes: null,
  jobs_completed_180d: 100,
  rules_originated: 10,
  rules_deployed: 8,
  sole_source_rules: 0,
  captures_90d: 12,
  last_capture_at: null,
};

describe('confidenceTier', () => {
  it('maps score bands', () => {
    expect(confidenceTier(90)).toBe('high');
    expect(confidenceTier(75)).toBe('high');
    expect(confidenceTier(74)).toBe('medium');
    expect(confidenceTier(50)).toBe('medium');
    expect(confidenceTier(49)).toBe('low');
  });
});

describe('formatRuleSentence / equipmentLabel', () => {
  it('writes the rule as one sentence', () => {
    const rule = {
      equipment_make: 'Trane',
      equipment_model: 'XR16',
      symptoms: ['loud clicking at startup', 'compressor hums'],
      likely_cause: 'a weak dual run capacitor.',
    };
    expect(formatRuleSentence(rule)).toBe(
      'On Trane XR16: when loud clicking at startup + compressor hums appear, the cause is usually a weak dual run capacitor.',
    );
  });

  it('falls back when equipment is unknown', () => {
    expect(equipmentLabel({ equipment_make: null, equipment_model: null })).toBe('Any equipment');
    expect(equipmentLabel({ equipment_make: 'Carrier', equipment_model: null })).toBe('Carrier');
  });
});

describe('explainConfidence', () => {
  it('orders by contribution and computes points', () => {
    const parts = explainConfidence({
      specificity: { score: 80, weight: 30 },
      corroboration: { score: 60, weight: 25 },
      outcome: { score: 50, weight: 25 },
      verification: { score: 0, weight: 15 },
      recency: { score: 100, weight: 5 },
    });
    expect(parts.map((p) => p.key)).toEqual([
      'specificity',
      'corroboration',
      'outcome',
      'recency',
      'verification',
    ]);
    expect(parts[0].contribution).toBe(24);
    expect(parts.reduce((s, p) => s + p.contribution, 0)).toBe(24 + 15 + 13 + 5 + 0);
  });

  it('handles an empty breakdown', () => {
    expect(explainConfidence(null)).toEqual([]);
    expect(explainConfidence({})).toEqual([]);
  });
});

describe('outcomeRate', () => {
  it('is null with no applications', () => {
    expect(outcomeRate({ applied_count: 0, success_count: 0 })).toBeNull();
  });
  it('rounds to a percentage', () => {
    expect(outcomeRate({ applied_count: 3, success_count: 2 })).toBe(67);
  });
});

describe('availableActions', () => {
  const rule = (over: Partial<KceRule> = {}) => ({
    status: 'candidate' as KceRule['status'],
    confidence_score: 60,
    origin_contributor_id: 'm-origin',
    ...over,
  });
  const reviewer = { canReview: true, isOwner: false, myMemberId: 'm-other' };

  it('offers nothing to non-reviewers', () => {
    expect(
      availableActions(rule(), { canReview: false, isOwner: false, myMemberId: null }),
    ).toEqual([]);
  });

  it('candidate: start review, approve, reject', () => {
    expect(availableActions(rule(), reviewer).map((a) => a.action)).toEqual([
      'start_review',
      'approve',
      'reject',
    ]);
  });

  it('blocks approving your own contribution unless you are the owner', () => {
    const own = { canReview: true, isOwner: false, myMemberId: 'm-origin' };
    const approve = availableActions(rule(), own).find((a) => a.action === 'approve');
    expect(approve?.enabled).toBe(false);
    expect(approve?.disabledReason).toMatch(/different reviewer/i);

    const owner = { canReview: true, isOwner: true, myMemberId: null };
    expect(availableActions(rule(), owner).find((a) => a.action === 'approve')?.enabled).toBe(true);
  });

  it('gates deploy on the confidence floor', () => {
    const low = availableActions(
      rule({ status: 'approved', confidence_score: DEPLOY_CONFIDENCE_FLOOR - 1 }),
      reviewer,
    );
    expect(low.find((a) => a.action === 'deploy')?.enabled).toBe(false);
    const ok = availableActions(
      rule({ status: 'approved', confidence_score: DEPLOY_CONFIDENCE_FLOOR }),
      reviewer,
    );
    expect(ok.find((a) => a.action === 'deploy')?.enabled).toBe(true);
  });

  it('deployed rules can only be revised or retired; terminal states have no actions', () => {
    expect(availableActions(rule({ status: 'deployed' }), reviewer).map((a) => a.action)).toEqual([
      'revise',
      'retire',
    ]);
    expect(availableActions(rule({ status: 'rejected' }), reviewer)).toEqual([]);
    expect(availableActions(rule({ status: 'retired' }), reviewer)).toEqual([]);
  });

  it('reject and retire require a note', () => {
    expect(availableActions(rule(), reviewer).find((a) => a.action === 'reject')?.needsNote).toBe(
      true,
    );
    expect(
      availableActions(rule({ status: 'deployed' }), reviewer).find((a) => a.action === 'retire')
        ?.needsNote,
    ).toBe(true);
  });
});

describe('computeExpertRisk', () => {
  it('is low for a well-captured expert with no departure', () => {
    const r = computeExpertRisk(baseRisk, NOW);
    expect(r.tier).toBe('low');
    expect(r.daysToDeparture).toBeNull();
  });

  it('is critical for a near departure with thin capture and concentrated knowledge', () => {
    const r = computeExpertRisk(
      {
        ...baseRisk,
        expected_departure: '2027-03-31',
        rules_originated: 1,
        sole_source_rules: 10,
        captures_90d: 0,
      },
      NOW,
    );
    expect(r.daysToDeparture).toBe(30);
    expect(r.tier).toBe('critical');
    expect(r.score).toBeGreaterThanOrEqual(70);
    expect(r.reasons.join(' ')).toMatch(/Leaving in 30 days/);
    expect(r.suggestedAction).toMatch(/recorded expert sessions|capture sprint|second technician/i);
  });

  it('never reaches critical without a known departure date', () => {
    const r = computeExpertRisk(
      { ...baseRisk, rules_originated: 0, sole_source_rules: 20, captures_90d: 0 },
      NOW,
    );
    expect(r.score).toBeLessThanOrEqual(60);
    expect(r.tier).not.toBe('critical');
  });

  it('treats a passed departure date as maximum urgency', () => {
    const r = computeExpertRisk({ ...baseRisk, expected_departure: '2027-02-01' }, NOW);
    expect(r.daysToDeparture).toBeLessThanOrEqual(0);
    expect(r.reasons[0]).toMatch(/passed/);
  });

  it('does not judge coverage with too little job history', () => {
    const r = computeExpertRisk({ ...baseRisk, jobs_completed_180d: 2, rules_originated: 0 }, NOW);
    expect(r.capturedPer100Jobs).toBeNull();
    expect(r.score).toBe(0);
  });

  it('ignores an unparseable date instead of throwing', () => {
    const r = computeExpertRisk({ ...baseRisk, expected_departure: 'not-a-date' }, NOW);
    expect(r.daysToDeparture).toBeNull();
  });
});

describe('parseSymptoms', () => {
  it('splits on newlines and semicolons, dedupes, trims, caps at 8', () => {
    expect(parseSymptoms(' a ;b\n a\n\nc ')).toEqual(['a', 'b', 'c']);
    expect(parseSymptoms(Array.from({ length: 12 }, (_, i) => `s${i}`).join('\n'))).toHaveLength(8);
  });
});
