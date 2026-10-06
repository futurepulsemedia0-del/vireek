import { describe, expect, it } from 'vitest';
import {
  assessJobUnknowns,
  causeOverlap,
  resolutionInputError,
  statusFor,
  type RawComplianceReview,
  type RawDiagnosisSession,
  type RawEquipment,
  type RawResolution,
  type UnknownsInput,
} from '@/lib/unknownsEngine';

const ok = <T,>(data: T) => ({ ok: true, data });

const completeUnit: RawEquipment = {
  id: 'eq1',
  equipment_type: 'furnace',
  make: 'Carrier',
  model: '59TP6',
  serial_number: 'SN123',
  install_date: '2020-01-01',
  status: 'active',
};

const session = (over: Partial<RawDiagnosisSession> = {}): RawDiagnosisSession => ({
  id: 's1',
  equipment_id: 'eq1',
  confidence: 0.82,
  severity: 'medium',
  top_cause: 'Dirty flame sensor',
  top_likelihood: 0.82,
  missing_info: [],
  parts: [],
  created_at: '2026-10-01T10:00:00Z',
  ...over,
});

const review = (over: Partial<RawComplianceReview> = {}): RawComplianceReview => ({
  permit_likelihood: 'possibly_required',
  jurisdiction_basis: 'address',
  jurisdiction_coverage: 'us_curated',
  requirements: [{ key: 'p1', category: 'permit', severity: 'blocker' }],
  item_progress: {},
  verify_questions: [],
  ...over,
});

function base(over: Partial<UnknownsInput> = {}): UnknownsInput {
  return {
    job: {
      id: 'j1',
      job_status: 'scheduled',
      service_type: 'Furnace repair',
      dispatch_note: 'Gate code 1234, dog in yard',
      address: '1 Main St',
      latitude: 1,
      longitude: 2,
      site_id: null,
      customer_phone: '555',
      quote_id: null,
      invoice_amount: null,
      technician_diagnosis: null,
      diagnosis_notes: null,
      before_photo_count: 0,
    },
    diagnosis: ok([]),
    equipment: ok([]),
    parts: ok([]),
    site: ok(null),
    compliance: ok(null),
    noSurprise: null,
    resolutions: [],
    ...over,
  };
}

const dim = (input: UnknownsInput, key: string) =>
  assessJobUnknowns(input).dimensions.find((d) => d.key === key)!;

describe('statusFor', () => {
  it('maps confidence bands and flag overrides', () => {
    expect(statusFor(95, {})).toBe('known');
    expect(statusFor(75, {})).toBe('likely');
    expect(statusFor(50, {})).toBe('uncertain');
    expect(statusFor(20, {})).toBe('unknown');
    expect(statusFor(95, { machineOnly: true })).toBe('unverified');
    expect(statusFor(95, { contradiction: true })).toBe('contradictory');
    expect(statusFor(80, { noEvidence: true })).toBe('unknown');
  });
});

describe('causeOverlap', () => {
  it('detects agreement and disagreement, and refuses to compare empty text', () => {
    expect(causeOverlap('Failed run capacitor', 'bad capacitor on the blower')).toBeGreaterThanOrEqual(0.34);
    expect(causeOverlap('Dirty flame sensor', 'Cracked heat exchanger')).toBe(0);
    expect(causeOverlap('', 'anything')).toBeNull();
  });
});

describe('diagnosis', () => {
  it('is unknown with no evidence', () => {
    expect(dim(base(), 'diagnosis').status).toBe('unknown');
  });
  it('AI-only evidence is unverified, never known', () => {
    const d = dim(base({ diagnosis: ok([session()]) }), 'diagnosis');
    expect(d.status).toBe('unverified');
    expect(d.confidencePct).toBe(82);
  });
  it('technician text that disagrees with the AI is contradictory', () => {
    const input = base({ diagnosis: ok([session()]) });
    input.job.technician_diagnosis = 'Cracked heat exchanger found on inspection';
    expect(dim(input, 'diagnosis').status).toBe('contradictory');
  });
  it('agreeing technician + AI is human-backed and high', () => {
    const input = base({ diagnosis: ok([session()]) });
    input.job.technician_diagnosis = 'Cleaned a dirty flame sensor, ignition restored';
    const d = dim(input, 'diagnosis');
    expect(d.status).toBe('known');
    expect(d.confidencePct).toBeGreaterThanOrEqual(90);
  });
  it('two confident runs with different causes contradict each other', () => {
    const a = session({ id: 'a', created_at: '2026-10-01T11:00:00Z', top_cause: 'Cracked heat exchanger' });
    const b = session({ id: 'b', created_at: '2026-10-01T10:00:00Z' });
    expect(dim(base({ diagnosis: ok([a, b]) }), 'diagnosis').status).toBe('contradictory');
  });
  it('a failed load is unknown, not silent', () => {
    const d = dim(base({ diagnosis: { ok: false, data: [] } }), 'diagnosis');
    expect(d.status).toBe('unknown');
    expect(d.gaps[0]).toMatch(/could not be loaded/);
  });
});

describe('equipment identity', () => {
  it('complete record is known', () => {
    expect(dim(base({ equipment: ok([completeUnit]) }), 'equipment_identity').status).toBe('known');
  });
  it('missing serial lowers confidence below known', () => {
    const d = dim(base({ equipment: ok([{ ...completeUnit, serial_number: null }]) }), 'equipment_identity');
    expect(d.status).not.toBe('known');
  });
  it('diagnosis on a different unit than the linked one is contradictory', () => {
    const d = dim(base({ equipment: ok([completeUnit]), diagnosis: ok([session({ equipment_id: 'other' })]) }), 'equipment_identity');
    expect(d.status).toBe('contradictory');
  });
  it('a removed unit on a live job is contradictory', () => {
    const d = dim(base({ equipment: ok([{ ...completeUnit, status: 'removed' }]) }), 'equipment_identity');
    expect(d.status).toBe('contradictory');
  });
});

describe('part compatibility', () => {
  it('is not applicable when no parts are expected', () => {
    expect(dim(base(), 'part_compatibility').applicable).toBe(false);
  });
  it('is capped below known and stays unverified without a human check', () => {
    const input = base({
      equipment: ok([completeUnit]),
      diagnosis: ok([session({ parts: [{ name: 'Flame sensor', necessity: 'likely' }] })]),
      parts: ok([{ status: 'allocated' }]),
    });
    const d = dim(input, 'part_compatibility');
    expect(d.confidencePct).toBeLessThanOrEqual(85);
    expect(d.status).toBe('unverified');
  });
});

describe('permit requirement', () => {
  it('is unknown before any review exists', () => {
    expect(dim(base(), 'permit_requirement').status).toBe('unknown');
  });
  it('rule/AI review with open items is unverified', () => {
    expect(dim(base({ compliance: ok(review()) }), 'permit_requirement').status).toBe('unverified');
  });
  it('"unlikely" with an unresolved permit blocker contradicts itself', () => {
    expect(dim(base({ compliance: ok(review({ permit_likelihood: 'unlikely' })) }), 'permit_requirement').status).toBe('contradictory');
  });
  it('fully resolved items make it human-backed', () => {
    const r = review({ item_progress: { p1: { status: 'satisfied' } } });
    expect(['known', 'likely']).toContain(dim(base({ compliance: ok(r) }), 'permit_requirement').status);
  });
});

describe('scope & price', () => {
  it('a pending customer decision caps confidence', () => {
    const input = base({ noSurprise: { pending: 1, approved: 0 } });
    input.job.quote_id = 'q1';
    input.job.invoice_amount = 500;
    expect(dim(input, 'scope_and_price').confidencePct).toBeLessThanOrEqual(45);
  });
});

describe('resolutions and gate', () => {
  const verified = (dimension: RawResolution['dimension']): RawResolution => ({
    dimension,
    resolution: 'verified',
    value: 'Confirmed on site',
    note: null,
    resolved_by: 'u',
    resolved_at: '2026-10-01T12:00:00Z',
  });

  it('verified resolution becomes known at 100% and leaves the resolve-first list', () => {
    const open = assessJobUnknowns(base());
    expect(open.resolveFirst.map((d) => d.key)).toContain('diagnosis');
    const closed = assessJobUnknowns(base({ resolutions: [verified('diagnosis')] }));
    const d = closed.dimensions.find((x) => x.key === 'diagnosis')!;
    expect(d.status).toBe('known');
    expect(d.confidencePct).toBe(100);
    expect(closed.resolveFirst.map((x) => x.key)).not.toContain('diagnosis');
  });

  it('waived items stop blocking the gate but do not inflate confidence', () => {
    const waived: RawResolution = { ...verified('diagnosis'), resolution: 'waived', value: null, note: 'Customer declined diagnostics' };
    const d = assessJobUnknowns(base({ resolutions: [waived] })).dimensions.find((x) => x.key === 'diagnosis')!;
    expect(d.state).toBe('waived');
    expect(d.confidencePct).toBe(0);
    expect(d.priority).toBe(0);
  });

  it('empty job resolves first with at most 3 items, ordered by value', () => {
    const r = assessJobUnknowns(base());
    expect(r.verdict).toBe('resolve_first');
    expect(r.resolveFirst.length).toBeLessThanOrEqual(3);
    expect(r.resolveFirst[0].key).toBe('diagnosis');
  });

  it('a fully verified job is clear', () => {
    const keys = ['diagnosis', 'equipment_identity', 'site_condition', 'permit_requirement', 'scope_and_price'] as const;
    const r = assessJobUnknowns(base({ resolutions: keys.map(verified) }));
    expect(r.verdict).toBe('clear');
    expect(r.readinessPct).toBe(100);
  });
});

describe('resolutionInputError', () => {
  it('mirrors the database constraint', () => {
    expect(resolutionInputError('verified', 'x')).not.toBeNull();
    expect(resolutionInputError('verified', 'ok')).toBeNull();
    expect(resolutionInputError('waived', 'too short')).not.toBeNull();
    expect(resolutionInputError('waived', 'customer declined it')).toBeNull();
  });
});
