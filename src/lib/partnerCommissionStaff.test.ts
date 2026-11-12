import { describe, expect, it } from 'vitest';
import { cleanGuardrailMessage, formatUsdCents, parseLedger, parseOverview } from './partnerCommissionStaff';

describe('parseOverview', () => {
  it('parses rows, coerces numeric strings and skips junk', () => {
    const rows = parseOverview([
      { id: 'p1', company_name: 'Acme', tier: 'affiliate', status: 'approved', commission_rate: '20', commission_months: 12, referrals: 3, payable_cents: 6000, held_cents: 100, paid_cents: 0, clawed_back_cents: -50, commission_override_active: true },
      { nope: true },
      null,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'p1', commission_rate: 20, payable_cents: 6000, commission_override_active: true, commission_override_approved: false });
  });
  it('returns [] for non-arrays', () => {
    expect(parseOverview(null)).toEqual([]);
    expect(parseOverview({})).toEqual([]);
  });
});

describe('parseLedger', () => {
  it('keeps valid entries and drops unknown types or statuses', () => {
    const l = parseLedger({
      entries: [
        { id: 'e1', entry_type: 'earn', status: 'pending', amount_cents: 1580, base_cents: 7900, rate_pct: 20, period_index: 1, payable: true },
        { id: 'e2', entry_type: 'bogus', status: 'pending', amount_cents: 1 },
        { id: 'e3', entry_type: 'clawback', status: 'weird', amount_cents: -1 },
      ],
      audit: [{ op: 'update', old_rate: 20, new_rate: 25, new_months: 12, override_active: true, reason: 'signed deal' }],
    });
    expect(l.entries.map((e) => e.id)).toEqual(['e1']);
    expect(l.entries[0].payable).toBe(true);
    expect(l.audit[0]).toMatchObject({ new_rate: 25, override_active: true });
  });
  it('is safe on garbage', () => {
    expect(parseLedger(undefined)).toEqual({ entries: [], audit: [] });
  });
});

describe('formatting', () => {
  it('formats signed dollars with cents', () => {
    expect(formatUsdCents(1580)).toBe('$15.80');
    expect(formatUsdCents(-1580)).toBe('-$15.80');
    expect(formatUsdCents(Number.NaN)).toBe('$0.00');
  });
  it('extracts the guardrail message', () => {
    expect(cleanGuardrailMessage('ERROR: commission_guardrail: payable balance 100 cents is below the minimum payout of 5000 cents.')).toBe('payable balance 100 cents is below the minimum payout of 5000 cents.');
    expect(cleanGuardrailMessage('Staff only.')).toBe('Staff only.');
    expect(cleanGuardrailMessage('boom')).toBe('boom');
  });
});
