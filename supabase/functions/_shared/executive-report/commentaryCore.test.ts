import { describe, it, expect } from 'vitest';
import { deterministicCommentary, isGrounded, validateAiCommentary } from './commentaryCore';
import { buildFacts } from './format';
import { computeExecutiveMetrics } from './metrics';
import { periodForMonth } from './period';
import type { ReportSettings } from './types';

const settings: ReportSettings = {
  user_id: 'u', enabled: true, send_day: 1, send_hour: 8, timezone: 'UTC', include_owner: true,
  include_co_owners: true, extra_recipients: [], ai_commentary_enabled: true,
  revenue_goal: 20000, jobs_goal: null, close_rate_goal_pct: null, margin_goal_pct: null,
};
const metrics = computeExecutiveMetrics(periodForMonth('2026-09', 'UTC')!, {
  jobs: [{ id: 'j', assigned_technician_id: 't', job_status: 'completed', invoice_amount: 12400, invoice_status: 'paid', completed_at: '2026-09-04T00:00:00Z', scheduled_datetime: null, created_at: '2026-09-01T00:00:00Z' }],
  costs: [], quotes: [], calls: [], recoveries: [], technicians: [{ id: 't', member_name: 'Ana', member_email: 'a@x.com' }],
}, settings);
const facts = buildFacts(metrics);

describe('grounding', () => {
  it('accepts numbers present in the facts and small ordinals', () => {
    expect(isGrounded('Revenue was $12,400 this month, 1 job.', facts)).toBe(true);
  });
  it('rejects invented numbers', () => {
    expect(isGrounded('Revenue grew 47% this month.', facts)).toBe(false);
  });
});

describe('validateAiCommentary', () => {
  const good = JSON.stringify({ headline: 'Steady month at $12,400', highlights: ['Ana led with $12,400.'], risks: ['Revenue is behind the $20,000 goal.'], actions: ['Chase open quotes.'] });
  it('accepts grounded JSON, including fenced output', () => {
    expect(validateAiCommentary(good, facts)?.source).toBe('ai');
    expect(validateAiCommentary('```json\n' + good + '\n```', facts)?.highlights).toHaveLength(1);
  });
  it('drops ungrounded items and falls back when too little survives', () => {
    const bad = JSON.stringify({ headline: 'Up 83%', highlights: ['Grew 83%.'], risks: [], actions: ['Do more.'] });
    expect(validateAiCommentary(bad, facts)).toBeNull();
  });
  it('returns null for invalid JSON', () => {
    expect(validateAiCommentary('not json', facts)).toBeNull();
  });
});

describe('deterministicCommentary', () => {
  it('always produces a headline and at least one action, with no invented figures', () => {
    const c = deterministicCommentary(metrics);
    expect(c.source).toBe('deterministic');
    expect(c.headline).toMatch(/September 2026/);
    expect(c.actions.length).toBeGreaterThan(0);
    for (const line of [c.headline, ...c.highlights, ...c.risks, ...c.actions]) expect(isGrounded(line, facts)).toBe(true);
  });
});
