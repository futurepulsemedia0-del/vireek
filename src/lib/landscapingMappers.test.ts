import { describe, it, expect } from 'vitest';
import { billingContract, contractSchedule, friendlyLandscapingError, toContract } from './landscapingMappers';
import { planVisits, validateSchedule } from './tradePacks/landscaping/index';

const row = {
  id: 'c1', customer_id: 'u1', property_id: null, title: 'Smith weekly', status: 'active', start_date: '2027-04-05', end_date: null,
  seasons: [{ fromMonth: 4, toMonth: 10, intervalWeeks: 1 }], holiday_policy: 'shift_next', holiday_set: 'us_core', extra_holidays: ['2027-07-05'],
  workdays: [1, 2, 3, 4, 5], preferred_time: '09:00:00', timezone: 'America/Chicago', duration_minutes: 45, default_crew_id: null,
  billing_mode: 'per_visit', visit_price_cents: 5500, monthly_fee_cents: 0, tax_percent: '8.25', weather_policy: { rules: [], makeup: 'next_workday' },
  checklist: [], require_photos: true, notes: null,
};

describe('landscaping client mappers', () => {
  it('maps a database row: time trimmed to HH:MM, numerics coerced', () => {
    const c = toContract(row);
    expect(c.preferred_time).toBe('09:00');
    expect(c.tax_percent).toBe(8.25);
    expect(c.visit_price_cents).toBe(5500);
    expect(c.pauses).toEqual([]);
  });
  it('a mapped row is a valid engine schedule that generates visits', () => {
    const c = { ...toContract(row), pauses: [{ from: '2027-04-12', to: '2027-04-18' }] };
    const s = contractSchedule(c);
    expect(validateSchedule(s)).toEqual([]);
    const v = planVisits(s, { from: '2027-04-05', to: '2027-04-19' });
    expect(v.map((x) => `${x.date}:${x.status}`)).toEqual(['2027-04-05:scheduled', '2027-04-12:skipped', '2027-04-19:scheduled']);
  });
  it('billing contract carries pauses and money fields through', () => {
    const b = billingContract({ ...toContract(row), pauses: [{ from: '2027-04-12', to: null }] });
    expect(b.pauses).toEqual([{ from: '2027-04-12', to: null }]);
    expect(b.tax_percent).toBe(8.25);
  });
  it('maps known server errors to plain language and never leaks SQL internals for unknown ones', () => {
    expect(friendlyLandscapingError({ message: 'photos_required' })).toMatch(/BEFORE and one AFTER/);
    expect(friendlyLandscapingError({ message: 'landscaping_not_enabled' })).toMatch(/not enabled/);
    expect(friendlyLandscapingError({ message: 'new row violates row-level security policy' })).toBe('You do not have permission to do that.');
    expect(friendlyLandscapingError(null)).toMatch(/Something went wrong/);
  });
});
