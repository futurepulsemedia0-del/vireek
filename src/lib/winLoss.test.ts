import { describe, expect, it } from 'vitest';
import {
  dollarsToCents, draftFromRecord, emptyDraft, groupSummary, isLowSample, validateDraft,
  type SummaryRow, type WinLossDraft, type WinLossRecord,
} from './winLoss';

const TODAY = '2026-11-15';
const base = (over: Partial<WinLossDraft> = {}): WinLossDraft => ({
  ...emptyDraft(TODAY), dealName: 'Acme HVAC', outcome: 'lost', competitor: 'ServiceTitan', reasons: ['price'], ...over,
});

describe('dollarsToCents', () => {
  it('parses dollars, separators and blanks', () => {
    expect(dollarsToCents('1,250.50')).toBe(125050);
    expect(dollarsToCents('0')).toBe(0);
    expect(dollarsToCents('  ')).toBeNull();
  });
  it('rejects junk, negatives and 3 decimals', () => {
    for (const v of ['abc', '-5', '1.234', '1e3', '$5']) expect(dollarsToCents(v)).toBeNaN();
  });
});

describe('validateDraft', () => {
  it('accepts a valid lost deal and normalises it', () => {
    const r = validateDraft(base({ dealName: '  Acme  ', reasons: ['price', 'price', 'features'], notes: '  hi ', dealValue: '1200' }), TODAY);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload).toMatchObject({ deal_name: 'Acme', reasons: ['price', 'features'], notes: 'hi', deal_value_cents: 120000 });
  });
  it('requires a competitor for a loss but not for a win', () => {
    const lost = validateDraft(base({ competitor: ' ' }), TODAY);
    expect(lost.ok === false && lost.errors.competitor).toBe('competitorRequiredForLoss');
    expect(validateDraft(base({ outcome: 'won', competitor: '' }), TODAY).ok).toBe(true);
  });
  it('requires reasons for won/lost, not for no_decision, and caps at five', () => {
    const none = validateDraft(base({ reasons: [] }), TODAY);
    expect(none.ok === false && none.errors.reasons).toBe('reasonsRequired');
    expect(validateDraft(base({ outcome: 'no_decision', competitor: '', reasons: [] }), TODAY).ok).toBe(true);
    const six = validateDraft(base({ reasons: ['price', 'features', 'voice_quality', 'integrations', 'support', 'other'] }), TODAY);
    expect(six.ok === false && six.errors.reasons).toBe('reasonsTooMany');
  });
  it('requires a deal name and an outcome', () => {
    const r = validateDraft(base({ dealName: ' ', outcome: '' }), TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.errors.dealName).toBe('dealNameRequired'); expect(r.errors.outcome).toBe('outcomeRequired'); }
  });
  it('validates dates: real, >= 2020, not beyond tomorrow (UTC)', () => {
    const e = (d: string) => { const r = validateDraft(base({ closedOn: d }), TODAY); return r.ok ? null : r.errors.closedOn; };
    expect(e('2026-02-30')).toBe('dateInvalid');
    expect(e('2019-12-31')).toBe('dateInvalid');
    expect(e('2026-11-16')).toBeNull();
    expect(e('2026-11-17')).toBe('dateFuture');
  });
  it('rejects invalid values and over-long text', () => {
    const v = validateDraft(base({ dealValue: '-1' }), TODAY);
    expect(v.ok === false && v.errors.dealValue).toBe('valueInvalid');
    const n = validateDraft(base({ notes: 'x'.repeat(4001) }), TODAY);
    expect(n.ok === false && n.errors.notes).toBe('notesTooLong');
  });
});

describe('draftFromRecord', () => {
  it('round-trips a record into an editable draft', () => {
    const rec: WinLossRecord = {
      id: '1', deal_name: 'A', outcome: 'won', competitor: null, reasons: ['price'], notes: null, closed_on: '2024-01-02',
      deal_value_cents: 12345, interview_status: 'completed', created_at: '', updated_at: '',
    };
    expect(draftFromRecord(rec)).toMatchObject({ competitor: '', notes: '', dealValue: '123.45', interviewStatus: 'completed' });
  });
});

describe('groupSummary', () => {
  const row = (dimension: SummaryRow['dimension'], bucket: string, decided: number, no_decisions = 0): SummaryRow => ({
    dimension, bucket, wins: decided, losses: 0, no_decisions, decided, win_rate_pct: 100, won_value_cents: 0, lost_value_cents: 0,
  });
  it('groups by dimension, newest quarter first, busiest bucket first', () => {
    const g = groupSummary([row('quarter', '2024-Q1', 1), row('quarter', '2024-Q2', 1), row('competitor', 'b', 1), row('competitor', 'a', 3), row('overall', 'all', 4)]);
    expect(g.quarter.map((r) => r.bucket)).toEqual(['2024-Q2', '2024-Q1']);
    expect(g.competitor.map((r) => r.bucket)).toEqual(['a', 'b']);
    expect(g.overall).toHaveLength(1);
  });
  it('flags small samples', () => {
    expect(isLowSample({ decided: 4 })).toBe(true);
    expect(isLowSample({ decided: 5 })).toBe(false);
  });
});
