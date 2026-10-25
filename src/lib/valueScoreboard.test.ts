import { describe, expect, it } from 'vitest';
import { PRICING_PLANS } from '@/lib/pricing';
import { PLAN_MONTHLY_CENTS } from '../../supabase/functions/_shared/value-scoreboard/engine';
import {
  defaultSettingsDraft, draftToRow, parsePercentToBp, rowToDraft, subscriptionFor, validateSettings,
} from '@/lib/valueScoreboard';

describe('plan prices stay in sync with pricing.ts', () => {
  it('matches every priced plan', () => {
    for (const p of PRICING_PLANS) {
      if (p.monthly === null) continue; // enterprise = custom
      expect(PLAN_MONTHLY_CENTS[p.id]).toBe(p.monthly * 100);
    }
  });
});

describe('settings form', () => {
  it('parses percentages to basis points', () => {
    expect(parsePercentToBp('25')).toBe(2500);
    expect(parsePercentToBp('25.5%')).toBe(2550);
    expect(parsePercentToBp('100')).toBe(10000);
    expect(parsePercentToBp('100.01')).toBeNull();
    expect(parsePercentToBp('-1')).toBeNull();
    expect(parsePercentToBp('')).toBeNull();
  });
  it('accepts the defaults', () => {
    expect(validateSettings(defaultSettingsDraft())).toEqual({});
  });
  it('flags bad input', () => {
    const e = validateSettings({ ...defaultSettingsDraft(), avgTicket: 'abc', minutesPerCall: '61', timezone: 'Mars/Phobos', extraRecipients: 'nope' });
    expect(Object.keys(e).sort()).toEqual(['avgTicket', 'extraRecipients', 'minutesPerCall', 'timezone']);
  });
  it('round-trips through the database row', () => {
    const draft = { ...defaultSettingsDraft(), avgTicket: '450.50', closeRate: '30', subscriptionOverride: '199', extraRecipients: 'a@b.co, c@d.co', caseStudyConsent: true };
    const row = draftToRow('u1', draft);
    expect(row.avg_ticket_cents).toBe(45050);
    expect(row.close_rate_bp).toBe(3000);
    expect(row.subscription_cents_override).toBe(19900);
    expect(rowToDraft(row as never)).toEqual({ ...draft, extraRecipients: 'a@b.co, c@d.co' });
  });
});

describe('subscription cost', () => {
  it('prefers the owner override, in the account currency', () => {
    expect(subscriptionFor({ plan: 'starter', currency: 'EUR', subscriptionOverrideCents: 9000 })).toEqual({ cents: 9000, currency: 'EUR' });
  });
  it('falls back to the USD list price and returns null for custom plans', () => {
    expect(subscriptionFor({ plan: 'professional', currency: 'USD', subscriptionOverrideCents: null })).toEqual({ cents: 19900, currency: 'USD' });
    expect(subscriptionFor({ plan: 'enterprise', currency: 'USD', subscriptionOverrideCents: null })).toBeNull();
  });
});
