import { describe, expect, it } from 'vitest';
import { isIsoDay, isSafeProviderLabel, summarizeWorkforce, validateRecordInput, type RecordInput, type WorkforceOverview } from '@/lib/compliance/workforce';

const TODAY = '2026-11-18';
const base: RecordInput = { subjectId: 'u', recordType: 'security_training', courseKey: 'security_awareness_annual', status: 'completed', completedOn: '2026-11-01', validUntil: '', waiverCode: '', providerLabel: 'internal', externalRef: '' };

describe('data minimisation', () => {
  it.each(['jane.doe@example.com', 'ID 123456789', '<b>x</b>', 'x'])('rejects provider label %s', (v) => expect(isSafeProviderLabel(v)).toBe(false));
  it('accepts a vendor name or "internal"', () => {
    expect(isSafeProviderLabel('internal')).toBe(true);
    expect(isSafeProviderLabel('Acme Screening Ltd')).toBe(true);
  });
  it('rejects free-text references', () => {
    expect(validateRecordInput({ ...base, externalRef: 'cleared with notes' }, TODAY)).toContain('reference_invalid');
    expect(validateRecordInput({ ...base, externalRef: 'REF-2026-0042' }, TODAY)).toEqual([]);
  });
});

describe('validateRecordInput', () => {
  it('accepts a valid training record', () => expect(validateRecordInput(base, TODAY)).toEqual([]));
  it('couples course and type', () => {
    expect(validateRecordInput({ ...base, courseKey: '' }, TODAY)).toContain('course_required');
    expect(validateRecordInput({ ...base, recordType: 'background_check' }, TODAY)).toContain('course_not_allowed');
  });
  it('checks dates', () => {
    expect(validateRecordInput({ ...base, completedOn: '' }, TODAY)).toContain('date_required');
    expect(validateRecordInput({ ...base, completedOn: '2026-02-30' }, TODAY)).toContain('date_invalid');
    expect(validateRecordInput({ ...base, completedOn: '2026-12-01' }, TODAY)).toContain('date_future');
    expect(validateRecordInput({ ...base, completedOn: '2020-01-01' }, TODAY)).toContain('date_too_old');
    expect(validateRecordInput({ ...base, validUntil: '2026-10-01' }, TODAY)).toContain('valid_until_before');
  });
  it('requires a coded reason for waivers and forbids it otherwise', () => {
    expect(validateRecordInput({ ...base, status: 'waived' }, TODAY)).toContain('waiver_required');
    expect(validateRecordInput({ ...base, status: 'waived', waiverCode: 'free text' }, TODAY)).toContain('waiver_required');
    expect(validateRecordInput({ ...base, status: 'waived', waiverCode: 'legal_restriction', completedOn: '' }, TODAY)).toEqual([]);
    expect(validateRecordInput({ ...base, waiverCode: 'legal_restriction' }, TODAY)).toContain('waiver_not_allowed');
  });
  it('validates ISO days strictly', () => {
    expect(isIsoDay('2026-02-28')).toBe(true);
    expect(isIsoDay('2026-2-28')).toBe(false);
  });
});

describe('summarizeWorkforce', () => {
  const o: WorkforceOverview = {
    generated_at: '',
    requirements: [
      { requirement_key: 'background_check', record_type: 'background_check', course_key: '', required: false, max_age_days: null, decided_at: null },
      { requirement_key: 'security_awareness_annual', record_type: 'security_training', course_key: 'security_awareness_annual', required: true, max_age_days: 365, decided_at: null },
    ],
    matrix: [
      { subject_id: 'a', subject_email: 'a@x', requirement_key: 'background_check', required: false, state: 'missing', completed_on: null, valid_until: null, provider_label: null, waiver_code: null },
      { subject_id: 'a', subject_email: 'a@x', requirement_key: 'security_awareness_annual', required: true, state: 'current', completed_on: '2026-11-01', valid_until: null, provider_label: null, waiver_code: null },
      { subject_id: 'b', subject_email: 'b@x', requirement_key: 'security_awareness_annual', required: true, state: 'expired', completed_on: '2025-01-01', valid_until: null, provider_label: null, waiver_code: null },
    ],
  };
  it('counts gaps only for required items', () => {
    const s = summarizeWorkforce(o);
    expect(s).toMatchObject({ activeStaff: 2, requiredRequirements: 1, gaps: 1 });
    expect(s.byRequirement.background_check?.missing).toBe(1);
  });
});
