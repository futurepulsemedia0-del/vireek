import { describe, it, expect } from 'vitest';
import { parseUnitCosts, parseCoverage, parseReconciliation, parseOutcomeFeeInputs, parseMarketplace, toNum, fmtMicroUsd } from './economicsApi';

describe('economics API parsers', () => {
  it('toNum accepts numbers and numeric strings (Postgres numeric), rejects junk', () => {
    expect(toNum('12.5')).toBe(12.5); expect(toNum(3)).toBe(3); expect(toNum('')).toBeNull(); expect(toNum('x')).toBeNull(); expect(toNum(null)).toBeNull();
  });
  it('parseUnitCosts keeps null (unknown) distinct from 0 and rejects non-objects', () => {
    expect(parseUnitCosts(null)).toBeNull();
    const u = parseUnitCosts({ calls_handled: 10, calls_with_cost: '8', micro_per_call: '125000', micro_per_booking_direct: null, notes: ['a', 3] });
    expect(u?.callsWithCost).toBe(8); expect(u?.microPerCall).toBe(125000); expect(u?.microPerBookingDirect).toBeNull(); expect(u?.notes).toEqual(['a']);
  });
  it('parseCoverage / parseMarketplace tolerate garbage rows', () => {
    expect(parseCoverage('nope')).toEqual([]);
    expect(parseCoverage([{ resource_type: 'stt', events: 4, with_correlation: 3, cost_micro: '9' }, 5])).toHaveLength(1);
    expect(parseMarketplace([{ agent_id: 'a', runs: 2, vireek_margin_cents: null }])[0].vireekMarginCents).toBeNull();
  });
  it('parseReconciliation coerces unknown status safely', () => {
    expect(parseReconciliation([{ provider: 'vapi', status: 'weird' }])[0].status).toBe('no_invoice');
    expect(parseReconciliation([{ provider: 'vapi', status: 'over_threshold', variance_pct: '-20.00' }])[0].variancePct).toBe(-20);
  });
  it('parseOutcomeFeeInputs drops rows without an account id', () => {
    expect(parseOutcomeFeeInputs([{ plan: 'starter' }, { account_id: 'x', plan: 'starter', booked_jobs: '4' }])).toHaveLength(1);
  });
  it('fmtMicroUsd', () => { expect(fmtMicroUsd(1_234_567)).toBe('$1.2346'); expect(fmtMicroUsd(null)).toBe('n/a'); });
});
