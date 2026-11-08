import { describe, it, expect } from 'vitest';
import { buildDigest, renderDigest, type DigestSnapshot, type PeriodRow } from './digest';

const period = (o: Partial<PeriodRow> = {}): PeriodRow => ({
  currency: 'usd', opening_mrr_cents: 100_000, closing_mrr_cents: 110_000, movements: {}, cohort_n: 40, ...o,
});
const snap = (o: Partial<DigestSnapshot> = {}): DigestSnapshot => ({
  generated_at: '2028-03-06T00:00:00Z', primary_currency: 'usd', week: [period()], prior_week: [period()], last_30d: [period()],
  history_days: 200, trials_in_flight: 0, trials_ending_7d: 0, past_due_accounts: 0, signups_7_14d: 0,
  activated_of_signups_7_14d: 0, open_alerts: [], events_without_fact_30d: 0, running_experiments: 0, ...o,
});

describe('buildDigest', () => {
  it('quiet week still returns one low-priority "nothing fired" action', () => {
    const d = buildDigest(snap({ signups_7_14d: 40, activated_of_signups_7_14d: 30 }), 'W10');
    expect(d.actions).toHaveLength(1);
    expect(d.actions[0].id).toBe('none');
  });
  it('data gap is the first (high) action', () => {
    const d = buildDigest(snap({ events_without_fact_30d: 3, past_due_accounts: 1 }), 'W10');
    expect(d.actions[0].id).toBe('data_gap');
    expect(d.actions[0].priority).toBe('high');
  });
  it('past_due escalates to high at 5', () => {
    expect(buildDigest(snap({ past_due_accounts: 4 }), 'W').actions.find((a) => a.id === 'past_due')?.priority).toBe('medium');
    expect(buildDigest(snap({ past_due_accounts: 5 }), 'W').actions.find((a) => a.id === 'past_due')?.priority).toBe('high');
  });
  it('churn above prior week is high; evidence uses the measured numbers', () => {
    const w = period({ movements: { churn: { cents: 20_000, n: 2 } } });
    const pw = period({ movements: { churn: { cents: 5_000, n: 1 } } });
    const a = buildDigest(snap({ week: [w], prior_week: [pw] }), 'W').actions.find((x) => x.id === 'churn_review');
    expect(a?.priority).toBe('high');
    expect(a?.evidence).toContain('2 account(s)');
  });
  it('activation is NOT assessed below the minimum sample (notice instead of action)', () => {
    const d = buildDigest(snap({ signups_7_14d: 10, activated_of_signups_7_14d: 1 }), 'W');
    expect(d.actions.find((a) => a.id === 'activation')).toBeUndefined();
    expect(d.notices.some((n) => n.includes('Activation not assessed'))).toBe(true);
  });
  it('low activation on a matured cohort >= 30 triggers a review', () => {
    const d = buildDigest(snap({ signups_7_14d: 40, activated_of_signups_7_14d: 10 }), 'W');
    expect(d.actions.find((a) => a.id === 'activation')?.evidence).toContain('10 of 40');
  });
  it('short history adds a reliability notice', () => {
    expect(buildDigest(snap({ history_days: 20 }), 'W').notices.some((n) => n.includes('not reliable'))).toBe(true);
  });
  it('no revenue history => explicit notice, no fabricated revenue headline', () => {
    const d = buildDigest(snap({ primary_currency: null, week: [], prior_week: [], last_30d: [] }), 'W');
    expect(d.headline.some((h) => h.label.startsWith('MRR'))).toBe(false);
    expect(d.notices[0]).toContain('not available');
  });
  it('open alerts become high-priority actions', () => {
    const d = buildDigest(snap({ open_alerts: [{ rule_key: 'past_due_accounts', value: 7, fired_at: '2028-03-01T00:00:00Z' }] }), 'W');
    expect(d.actions.some((a) => a.id === 'alert_past_due_accounts' && a.priority === 'high')).toBe(true);
  });
});

describe('renderDigest', () => {
  it('escapes HTML in dynamic strings', () => {
    const d = buildDigest(snap({ open_alerts: [{ rule_key: '<img src=x>', value: null, fired_at: '2028-03-01T00:00:00Z' }] }), 'W');
    const { html } = renderDigest(d, 'https://x.test/?a="b"');
    expect(html.includes('<img src=x>')).toBe(false);
    expect(html.includes('&lt;img')).toBe(true);
    expect(html.includes('href="https://x.test/?a=&quot;b&quot;"')).toBe(true);
  });
});
