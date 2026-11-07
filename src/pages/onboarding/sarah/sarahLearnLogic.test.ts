import { describe, it, expect } from 'vitest';
import { FIELD_DEFS } from '../../../../supabase/functions/_shared/sarah-learn/schema.ts';
import { formatValue, goLiveBlockers, groupFields, parseEditInput, reviewCounts, diffStatus, type LearnField } from './sarahLearnLogic';

const f = (key: string, o: Partial<LearnField> = {}): LearnField => ({
  id: key, key, value: 'x', prev_value: null, confidence: 'high', assumed: false, sensitive: false, origin: 'source', source_id: null, citation: 'q', status: 'pending', edit_count: 0, ...o,
});

describe('goLiveBlockers', () => {
  const ready = { readiness_passed: true, test_call_confirmed_at: '2026-01-01' };
  const required = ['business_name', 'services_offered', 'service_area'].map((k) => f(k, { status: 'approved' }));
  it('is empty when everything is approved, proven and test-called', () => {
    expect(goLiveBlockers(ready, required)).toEqual([]);
  });
  it('lists every unmet gate', () => {
    expect(goLiveBlockers({ readiness_passed: false, test_call_confirmed_at: null }, [f('business_name', { status: 'approved' }), f('diagnostic_fee', { sensitive: true })])).toEqual(['required_missing', 'sensitive_pending', 'readiness', 'test_call']);
  });
  it('rejected sensitive items do not block, pending ones do', () => {
    expect(goLiveBlockers(ready, [...required, f('warranties', { sensitive: true, status: 'rejected' })])).toEqual([]);
    expect(goLiveBlockers(ready, [...required, f('warranties', { sensitive: true })])).toEqual(['sensitive_pending']);
  });
});

describe('edit round-trips', () => {
  it('lists, hours, faqs and emergency survive format -> parse', () => {
    expect(parseEditInput('services_offered', formatValue('services_offered', ['a', 'b']))).toEqual(['a', 'b']);
    const hours = { mon: { open: '08:00', close: '17:00' }, fri: { open: '09:00', close: '12:00' } };
    expect(parseEditInput('hours', formatValue('hours', hours))).toEqual(hours);
    const faqs = [{ question: 'Q1?', answer: 'A1' }, { question: 'Q2?', answer: 'A2' }];
    expect(parseEditInput('faqs', formatValue('faqs', faqs))).toEqual(faqs);
    const em = { mode: 'yes_premium', note: '24/7' };
    expect(parseEditInput('emergency_policy', formatValue('emergency_policy', em))).toEqual(em);
  });
  it('rejects invalid input', () => {
    expect(parseEditInput('hours', 'mon 25:00-17:00')).toBeNull();
    expect(parseEditInput('hours', 'mon 17:00-08:00')).toBeNull();
    expect(parseEditInput('emergency_policy', 'maybe')).toBeNull();
    expect(parseEditInput('business_name', '   ')).toBeNull();
  });
});

describe('review helpers', () => {
  it('groups by field group and counts review work', () => {
    const fields = [f('business_name'), f('diagnostic_fee', { sensitive: true }), f('trade', { assumed: true, confidence: 'low' }), f('faqs', { edit_count: 2, status: 'edited' })];
    const groups = groupFields(fields).map((g) => g.group);
    expect(groups).toEqual(['basics', 'pricing', 'faq']);
    const c = reviewCounts(fields);
    expect(c.pendingSensitive).toHaveLength(1);
    expect(c.pendingSafe).toHaveLength(1);
    expect(c.assumed).toHaveLength(1);
    expect(c.edits).toBe(2);
  });
  it('diffStatus flags changed values on re-run', () => {
    expect(diffStatus(f('a', { prev_value: 'old', value: 'new' }))).toBe('changed');
    expect(diffStatus(f('a', { prev_value: 'same', value: 'same' }))).toBe('same');
  });
  it('every field has a group so nothing is hidden from review', () => {
    for (const d of FIELD_DEFS) expect(groupFields([f(d.key)])).toHaveLength(1);
  });
});
