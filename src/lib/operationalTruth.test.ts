import { describe, expect, it } from 'vitest';
import {
  assessFact,
  computeBaseConfidence,
  normalizeAssertion,
  resolvePolicy,
  resolveTruth,
  type TruthFact,
} from '../../supabase/functions/_shared/truth/engine';

const NOW = new Date('2026-09-30T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const daysAhead = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

function fact(over: Partial<TruthFact> & { id: string }): TruthFact {
  return {
    subject_type: 'technician',
    subject_id: 'tech-1',
    predicate: 'credential.hvac_license',
    value: true,
    source_key: 'state_license_db',
    source_ref: null,
    verified_at: daysAgo(2),
    expires_at: daysAhead(200),
    base_confidence: 0.99,
    evidence_count: 1,
    ...over,
  };
}

const policy = resolvePolicy('credential.hvac_license');

describe('resolveTruth', () => {
  it('has no verified record -> unverified, blocked', () => {
    const r = resolveTruth([], policy, { now: NOW });
    expect(r.verdict).toBe('unverified');
    expect(r.allow).toBe(false);
  });

  it('fresh authoritative fact -> verified and allowed', () => {
    const r = resolveTruth([fact({ id: 'a' })], policy, { now: NOW, expected: true });
    expect(r.verdict).toBe('verified');
    expect(r.allow).toBe(true);
    expect(r.confidence).toBeGreaterThan(0.95);
  });

  it('expired record is never usable', () => {
    const r = resolveTruth([fact({ id: 'a', expires_at: daysAgo(1) })], policy, { now: NOW });
    expect(r.verdict).toBe('expired');
    expect(r.allow).toBe(false);
  });

  it('record older than the freshness limit -> stale', () => {
    const r = resolveTruth([fact({ id: 'a', verified_at: daysAgo(120), expires_at: null })], policy, { now: NOW });
    expect(r.verdict).toBe('stale');
    expect(r.allow).toBe(false);
    expect(r.required_action).toContain('State License Database');
  });

  it('two authorities disagreeing -> conflict', () => {
    const r = resolveTruth(
      [fact({ id: 'a' }), fact({ id: 'b', source_key: 'government_registry', value: false, base_confidence: 0.98 })],
      policy,
      { now: NOW },
    );
    expect(r.verdict).toBe('conflict');
    expect(r.allow).toBe(false);
    expect(r.conflict?.fact_ids.length).toBe(2);
  });

  it('an authority is not out-voted by weak non-authoritative claims', () => {
    const r = resolveTruth(
      [fact({ id: 'a' }), fact({ id: 'b', source_key: 'ai_inference', value: false, base_confidence: 0.45 })],
      policy,
      { now: NOW },
    );
    expect(r.verdict).toBe('verified');
    expect(r.confidence).toBeGreaterThan(0.95);
    expect(r.warnings.join(' ')).toContain('lower-trust');
  });

  it('a non-authoritative value with a strong rival is penalised', () => {
    const r = resolveTruth(
      [
        fact({ id: 'a', source_key: 'document_upload', base_confidence: 0.9 }),
        fact({ id: 'b', source_key: 'field_observation', value: false, base_confidence: 0.3 }),
      ],
      { ...policy, min_confidence: 0.5 },
      { now: NOW },
    );
    expect(r.verdict).toBe('verified');
    expect(r.confidence).toBeLessThan(0.7);
  });

  it('owner-only claim is below the credential policy threshold', () => {
    const r = resolveTruth([fact({ id: 'a', source_key: 'owner_entered', base_confidence: 0.6 })], policy, { now: NOW });
    expect(r.verdict).toBe('low_confidence');
    expect(r.allow).toBe(false);
  });

  it('independent sources corroborate each other (noisy-OR)', () => {
    const r = resolveTruth(
      [
        fact({ id: 'a', source_key: 'owner_entered', base_confidence: 0.7 }),
        fact({ id: 'b', source_key: 'document_upload', base_confidence: 0.85 }),
      ],
      policy,
      { now: NOW },
    );
    expect(r.confidence).toBeGreaterThan(0.9);
    expect(r.verdict).toBe('verified');
  });

  it('the same source cannot corroborate itself', () => {
    const r = resolveTruth(
      [
        fact({ id: 'a', source_key: 'owner_entered', base_confidence: 0.7 }),
        fact({ id: 'b', source_key: 'owner_entered', base_confidence: 0.7 }),
      ],
      policy,
      { now: NOW },
    );
    expect(r.confidence).toBeLessThan(0.71);
  });

  it('verified value that differs from the expected one -> denied', () => {
    const r = resolveTruth([fact({ id: 'a', value: false })], policy, { now: NOW, expected: true });
    expect(r.verdict).toBe('denied');
    expect(r.allow).toBe(false);
  });

  it('warns when expiry is near', () => {
    const r = resolveTruth([fact({ id: 'a', expires_at: daysAhead(10) })], policy, { now: NOW });
    expect(r.verdict).toBe('verified');
    expect(r.warnings.join(' ')).toContain('Expires in 10');
  });

  it('enforces min_independent_sources for non-authoritative claims', () => {
    const strict = { ...policy, min_independent_sources: 2 };
    const r = resolveTruth([fact({ id: 'a', source_key: 'document_upload', base_confidence: 0.99 })], strict, { now: NOW });
    expect(r.verdict).toBe('insufficient_corroboration');
  });
});

describe('assessFact / policy / confidence', () => {
  it('freshness decays with age but stays usable before the limit', () => {
    const young = assessFact(fact({ id: 'a', verified_at: daysAgo(1) }), policy, NOW);
    const old = assessFact(fact({ id: 'b', verified_at: daysAgo(80) }), policy, NOW);
    expect(young.freshness).toBeGreaterThan(old.freshness);
    expect(old.state).toBe('aging');
  });

  it('picks exact override over prefix over built-in', () => {
    const p = resolvePolicy('credential.hvac_license', [
      { predicate: 'credential.', min_confidence: 0.5, max_age_days: 10, min_independent_sources: 1, expiring_warning_days: 1 },
      { predicate: 'credential.hvac_license', min_confidence: 0.95, max_age_days: 20, min_independent_sources: 1, expiring_warning_days: 1 },
    ]);
    expect(p.min_confidence).toBe(0.95);
    expect(resolvePolicy('unknown.thing').max_age_days).toBe(90);
  });

  it('discounts claims without evidence and respects the cap', () => {
    expect(computeBaseConfidence('document_upload', 1)).toBeCloseTo(0.85, 4);
    expect(computeBaseConfidence('document_upload', 0)).toBeCloseTo(0.7225, 4);
    expect(computeBaseConfidence('document_upload', 1, 0.5)).toBe(0.5);
  });
});

describe('normalizeAssertion', () => {
  const base = { subject_type: 'technician', subject_id: 'abc', predicate: 'credential.epa_608', source_key: 'document_upload' };

  it('accepts a valid assertion and defaults value to true', () => {
    const r = normalizeAssertion({ ...base, expires_at: daysAhead(100) }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.value).toBe(true);
  });

  it('rejects bad predicates, unknown sources and future verification', () => {
    expect(normalizeAssertion({ ...base, predicate: 'nope' }, NOW).ok).toBe(false);
    expect(normalizeAssertion({ ...base, source_key: 'made_up' }, NOW).ok).toBe(false);
    expect(normalizeAssertion({ ...base, verified_at: daysAhead(2) }, NOW).ok).toBe(false);
    expect(normalizeAssertion({ ...base, expires_at: daysAgo(1) }, NOW).ok).toBe(false);
  });

  it('validates evidence items', () => {
    expect(normalizeAssertion({ ...base, evidence: [{ kind: 'document' }] }, NOW).ok).toBe(false);
    expect(normalizeAssertion({ ...base, evidence: [{ kind: 'document', content_hash: 'xyz' }] }, NOW).ok).toBe(false);
    expect(normalizeAssertion({ ...base, evidence: [{ kind: 'note', excerpt: 'Seen on site' }] }, NOW).ok).toBe(true);
  });
});
