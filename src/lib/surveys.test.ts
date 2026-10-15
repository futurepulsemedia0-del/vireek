import { describe, it, expect } from 'vitest';
import {
  buildTrend,
  computeCsat,
  computeNps,
  defaultTemplateInput,
  describeSurveyError,
  firstName,
  isLowScore,
  isValidScore,
  npsBucket,
  recoverySeverity,
  renderMergeTags,
  scoreByTechnician,
  summarize,
  validateTemplate,
  type SurveyInvitation,
} from './surveys';

function inv(over: Partial<SurveyInvitation>): SurveyInvitation {
  return {
    id: Math.random().toString(36).slice(2),
    user_id: 'owner-1',
    template_id: 't1',
    job_id: 'j1',
    technician_id: null,
    template_name: 'Post-job NPS',
    survey_type: 'nps',
    channel: 'both',
    customer_name: 'Ada Lovelace',
    customer_phone: null,
    customer_email: null,
    service_type: null,
    status: 'responded',
    trigger_source: 'auto',
    sent_at: '2026-10-07T10:00:00Z',
    channel_used: 'sms',
    delivery_error: null,
    score: 10,
    comment: null,
    responded_at: '2026-10-07T12:00:00Z',
    low_score_threshold: 6,
    created_at: '2026-10-07T09:00:00Z',
    ...over,
  };
}

describe('npsBucket', () => {
  it('classifies the standard NPS boundaries', () => {
    expect(npsBucket(10)).toBe('promoter');
    expect(npsBucket(9)).toBe('promoter');
    expect(npsBucket(8)).toBe('passive');
    expect(npsBucket(7)).toBe('passive');
    expect(npsBucket(6)).toBe('detractor');
    expect(npsBucket(0)).toBe('detractor');
  });
});

describe('computeNps', () => {
  it('returns null NPS with no responses', () => {
    expect(computeNps([])).toMatchObject({ responses: 0, nps: null });
  });
  it('computes %promoters - %detractors, rounded', () => {
    // 2 promoters, 1 passive, 1 detractor of 4 -> (2-1)/4 = 25
    expect(computeNps([10, 9, 8, 3]).nps).toBe(25);
    // all detractors -> -100, all promoters -> 100
    expect(computeNps([0, 5, 6]).nps).toBe(-100);
    expect(computeNps([9, 10]).nps).toBe(100);
  });
  it('ignores out-of-range / non-integer scores', () => {
    expect(computeNps([11, -1, 9.5, 10]).responses).toBe(1);
  });
});

describe('computeCsat', () => {
  it('returns nulls with no responses', () => {
    expect(computeCsat([])).toEqual({ responses: 0, satisfied: 0, csat: null, average: null });
  });
  it('counts 4-5 as satisfied and averages to one decimal', () => {
    const r = computeCsat([5, 4, 3, 1]);
    expect(r.csat).toBe(50);
    expect(r.average).toBe(3.3);
  });
  it('ignores NPS-only scores (0, 6+)', () => {
    expect(computeCsat([0, 7, 5]).responses).toBe(1);
  });
});

describe('score validation + recovery rules', () => {
  it('validates ranges per type', () => {
    expect(isValidScore('nps', 0)).toBe(true);
    expect(isValidScore('nps', 11)).toBe(false);
    expect(isValidScore('csat', 0)).toBe(false);
    expect(isValidScore('csat', 5)).toBe(true);
    expect(isValidScore('csat', 2.5)).toBe(false);
  });
  it('flags low scores at or below the threshold', () => {
    expect(isLowScore('nps', 6, 6)).toBe(true);
    expect(isLowScore('nps', 7, 6)).toBe(false);
    expect(isLowScore('csat', 2, 2)).toBe(true);
    expect(isLowScore('csat', 3, 2)).toBe(false);
    expect(isLowScore('csat', 99, 2)).toBe(false);
  });
  it('mirrors the DB severity rule', () => {
    expect(recoverySeverity('nps', 3)).toBe('critical');
    expect(recoverySeverity('nps', 4)).toBe('high');
    expect(recoverySeverity('csat', 1)).toBe('critical');
    expect(recoverySeverity('csat', 2)).toBe('high');
  });
});

describe('summarize', () => {
  it('computes response rate over delivered surveys only', () => {
    const rows = [
      inv({ score: 10 }),
      inv({ score: 3 }),
      inv({ status: 'sent', score: null, responded_at: null }),
      inv({ status: 'sent', score: null, responded_at: null }),
      inv({ status: 'failed', score: null, responded_at: null }),
      inv({ status: 'pending', score: null, responded_at: null }),
      inv({ survey_type: 'csat', score: 5 }),
    ];
    const s = summarize(rows);
    expect(s.sent).toBe(5); // 3 responded + 2 sent; failed/pending never reached a customer
    expect(s.responded).toBe(3);
    expect(s.responseRate).toBe(60);
    expect(s.nps.nps).toBe(0); // one promoter, one detractor
    expect(s.csat.csat).toBe(100);
  });
  it('has a null response rate when nothing was delivered', () => {
    expect(summarize([inv({ status: 'pending', score: null, responded_at: null })]).responseRate).toBeNull();
  });
});

describe('buildTrend', () => {
  const now = new Date('2026-10-08T15:00:00Z');
  it('returns one bucket per day including empty days', () => {
    const t = buildTrend([], 'nps', 7, now);
    expect(t).toHaveLength(7);
    expect(t[0].date).toBe('2026-10-02');
    expect(t[6].date).toBe('2026-10-08');
    expect(t.every((p) => p.value === null && p.responses === 0)).toBe(true);
  });
  it('buckets by responded_at day and computes the per-day score', () => {
    const rows = [
      inv({ score: 10, responded_at: '2026-10-08T01:00:00Z' }),
      inv({ score: 2, responded_at: '2026-10-08T09:00:00Z' }),
      inv({ score: 9, responded_at: '2026-10-07T09:00:00Z' }),
      inv({ score: 9, responded_at: '2026-09-01T09:00:00Z' }), // outside window
      inv({ survey_type: 'csat', score: 5, responded_at: '2026-10-08T09:00:00Z' }), // other type
    ];
    const t = buildTrend(rows, 'nps', 7, now);
    expect(t[6]).toMatchObject({ date: '2026-10-08', responses: 2, value: 0 });
    expect(t[5]).toMatchObject({ date: '2026-10-07', responses: 1, value: 100 });
  });
  it('handles offset timestamps by normalising to UTC days', () => {
    const t = buildTrend([inv({ score: 10, responded_at: '2026-10-07T23:30:00-05:00' })], 'nps', 7, now);
    expect(t.find((p) => p.date === '2026-10-08')?.responses).toBe(1);
  });
});

describe('scoreByTechnician', () => {
  it('groups, labels unknown technicians safely, and sorts best first', () => {
    const rows = [
      inv({ technician_id: 'a', score: 10 }),
      inv({ technician_id: 'a', score: 9 }),
      inv({ technician_id: 'b', score: 2 }),
      inv({ technician_id: null, score: 8 }),
      inv({ technician_id: 'gone', score: 9 }),
    ];
    const out = scoreByTechnician(rows, 'nps', { a: 'Alex', b: 'Bo' });
    expect(out[0]).toMatchObject({ key: 'a', label: 'Alex', responses: 2, value: 100 });
    expect(out.find((g) => g.key === 'gone')?.label).toBe('Former team member');
    expect(out.find((g) => g.key === 'unassigned')?.label).toBe('Unassigned');
    expect(out[out.length - 1].key).toBe('b');
  });
});

describe('template validation', () => {
  it('accepts the shipped defaults for both types', () => {
    expect(validateTemplate(defaultTemplateInput('nps'))).toEqual({});
    expect(validateTemplate(defaultTemplateInput('csat'))).toEqual({});
  });
  it('requires {{link}} in the SMS body only when SMS is used', () => {
    const base = { ...defaultTemplateInput('nps'), sms_body: 'How did we do? Reply here please.' };
    expect(validateTemplate({ ...base, channel: 'sms' }).sms_body).toMatch(/\{\{link\}\}/);
    expect(validateTemplate({ ...base, channel: 'email' }).sms_body).toBeUndefined();
  });
  it('bounds the low-score threshold per survey type', () => {
    const nps = defaultTemplateInput('nps');
    expect(validateTemplate({ ...nps, low_score_threshold: 9 }).low_score_threshold).toBeDefined();
    expect(validateTemplate({ ...nps, low_score_threshold: 8 }).low_score_threshold).toBeUndefined();
    const csat = defaultTemplateInput('csat');
    expect(validateTemplate({ ...csat, low_score_threshold: 5 }).low_score_threshold).toBeDefined();
    expect(validateTemplate({ ...csat, low_score_threshold: 0 }).low_score_threshold).toBeDefined();
  });
  it('rejects empty/oversized fields and bad numbers', () => {
    const t = { ...defaultTemplateInput('nps'), name: '  ', question: 'hey', send_delay_minutes: -1, cooldown_days: 400 };
    const e = validateTemplate(t);
    expect(e.name).toBeDefined();
    expect(e.question).toBeDefined();
    expect(e.send_delay_minutes).toBeDefined();
    expect(e.cooldown_days).toBeDefined();
  });
});

describe('merge tags', () => {
  const vars = { customer_first_name: 'Ada', business_name: 'Cool Air', link: 'https://x.test/s/abc' };
  it('fills known tags (with optional spaces) and leaves unknown ones alone', () => {
    expect(renderMergeTags('Hi {{customer_first_name}} from {{ business_name }}: {{link}} {{other}}', vars)).toBe(
      'Hi Ada from Cool Air: https://x.test/s/abc {{other}}',
    );
  });
  it('derives a safe first name', () => {
    expect(firstName('Ada Lovelace')).toBe('Ada');
    expect(firstName('  ')).toBe('there');
    expect(firstName(null)).toBe('there');
  });
});

describe('describeSurveyError', () => {
  it('maps known Postgres codes to friendly messages', () => {
    expect(describeSurveyError({ code: '23505' })).toMatch(/active auto-send/);
    expect(describeSurveyError({ code: '42501' })).toMatch(/permission/);
    expect(describeSurveyError({ message: 'boom' })).toBe('boom');
    expect(describeSurveyError(null)).toMatch(/Something went wrong/);
  });
});
