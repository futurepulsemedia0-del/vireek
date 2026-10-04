import { describe, expect, it } from 'vitest';
import {
  buildChain,
  climateBandFromLatitude,
  computeCalibration,
  confidenceTier,
  daysUntilMature,
  friendlyOinError,
  normalizeKey,
  suggestFromText,
  tradeFromIndustry,
  type OinCase,
  type TaxonomyItem,
} from '@/lib/outcomeNetwork';

function makeCase(over: Partial<OinCase> = {}): OinCase {
  return {
    id: 'c1',
    job_id: 'j1',
    trade: 'hvac',
    equipment_type: 'furnace',
    equipment_make: 'carrier',
    equipment_model: '59tp6a',
    climate_band: 'temperate',
    symptom_keys: ['no_heat'],
    failure_mode: 'failed_igniter',
    action_key: 'replace_igniter',
    part_keys: ['igniter'],
    technician_id: 't1',
    cost_cents: 34000,
    duration_minutes: 65,
    resolution: 'fixed_first_visit',
    first_visit_fix: true,
    caused_callback: false,
    customer_disputed: false,
    customer_rating: 5,
    status: 'matured',
    success: true,
    matured_at: '2026-10-01T00:00:00Z',
    predicted_success: null,
    predicted_action_key: null,
    created_at: '2026-08-01T00:00:00Z',
    ...over,
  };
}

describe('normalisation (must mirror SQL)', () => {
  it('normalizes keys like oin_norm', () => {
    expect(normalizeKey('Carrier 24ACC636A003!')).toBe('carrier24acc636a003');
    expect(normalizeKey('  ')).toBe('unknown');
    expect(normalizeKey(null)).toBe('unknown');
    expect(normalizeKey('x'.repeat(80))).toHaveLength(40);
  });

  it('maps industries to supported trades', () => {
    expect(tradeFromIndustry('Heating & Cooling')).toBe('hvac');
    expect(tradeFromIndustry('Plumbing')).toBe('plumbing');
    expect(tradeFromIndustry('Electrician')).toBe('electrical');
    expect(tradeFromIndustry('Landscaping')).toBe('other');
    expect(tradeFromIndustry(null)).toBe('other');
  });

  it('bands latitude symmetrically and rejects garbage', () => {
    expect(climateBandFromLatitude(10)).toBe('tropical');
    expect(climateBandFromLatitude(-33.8)).toBe('subtropical');
    expect(climateBandFromLatitude(41.5)).toBe('temperate');
    expect(climateBandFromLatitude(52)).toBe('cold');
    expect(climateBandFromLatitude(70)).toBe('subarctic');
    expect(climateBandFromLatitude(null)).toBe('unknown');
    expect(climateBandFromLatitude(Number.NaN)).toBe('unknown');
    expect(climateBandFromLatitude(120)).toBe('unknown');
  });
});

describe('suggestFromText', () => {
  const items: TaxonomyItem[] = [
    { kind: 'symptom', trade: 'hvac', key: 'no_cooling', label: 'No Cooling' },
    { kind: 'symptom', trade: 'hvac', key: 'no_heat', label: 'No Heat' },
    { kind: 'symptom', trade: 'hvac', key: 'short_cycling', label: 'Short Cycling' },
  ];
  it('matches on label words and ignores tiny words', () => {
    expect(suggestFromText('Customer says there is no heat since Monday', items)).toEqual(['no_heat']);
    expect(suggestFromText('unit short cycling, also no cooling', items)).toEqual(['no_cooling', 'short_cycling']);
  });
  it('returns nothing for empty or unrelated text', () => {
    expect(suggestFromText('', items)).toEqual([]);
    expect(suggestFromText('replaced thermostat battery', items)).toEqual([]);
  });
});

describe('confidenceTier', () => {
  it('requires volume, diversity and a tight interval for high confidence', () => {
    expect(confidenceTier({ case_count: 80, contributor_count: 12, wilson_low: 0.8, wilson_high: 0.95 })).toBe('high');
    expect(confidenceTier({ case_count: 80, contributor_count: 12, wilson_low: 0.5, wilson_high: 0.95 })).toBe('low');
    expect(confidenceTier({ case_count: 25, contributor_count: 7, wilson_low: 0.6, wilson_high: 0.9 })).toBe('medium');
    expect(confidenceTier({ case_count: 12, contributor_count: 5, wilson_low: 0.4, wilson_high: 0.9 })).toBe('low');
  });
});

describe('daysUntilMature', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');
  it('counts down the 30-day window and floors at zero', () => {
    expect(daysUntilMature('2026-09-21T00:00:00Z', now)).toBe(20);
    expect(daysUntilMature('2026-08-01T00:00:00Z', now)).toBe(0);
    expect(daysUntilMature(null, now)).toBeNull();
    expect(daysUntilMature('garbage', now)).toBeNull();
  });
});

describe('friendlyOinError', () => {
  it('extracts the human message from a server error', () => {
    expect(friendlyOinError({ message: 'OIN_CASE_LOCKED: this case already matured and is sealed' })).toBe(
      'this case already matured and is sealed',
    );
    expect(friendlyOinError({ message: 'permission denied' }, 'fallback')).toBe('fallback');
    expect(friendlyOinError(null, 'fallback')).toBe('fallback');
  });
});

describe('buildChain', () => {
  const labels = new Map<string, string>([['failure_mode:failed_igniter', 'Failed Igniter']]);

  it('builds the full 10-step chain for a resolved matured case', () => {
    const chain = buildChain(makeCase(), labels, 'Sam');
    expect(chain.map((s) => s.id)).toEqual(['problem', 'symptoms', 'diagnosis', 'technician', 'part', 'action', 'cost', 'outcome', 'callback', 'customer']);
    expect(chain.find((s) => s.id === 'diagnosis')?.value).toBe('Failed Igniter');
    expect(chain.find((s) => s.id === 'technician')?.value).toBe('Sam');
    expect(chain.find((s) => s.id === 'outcome')?.state).toBe('good');
    expect(chain.find((s) => s.id === 'callback')?.value).toBe('No callback');
    expect(chain.find((s) => s.id === 'customer')?.value).toBe('5/5');
  });

  it('marks callbacks and disputes as bad, and open cases as pending', () => {
    const bad = buildChain(makeCase({ success: false, caused_callback: true, customer_disputed: true }), labels);
    expect(bad.find((s) => s.id === 'outcome')?.state).toBe('bad');
    expect(bad.find((s) => s.id === 'callback')?.state).toBe('bad');
    expect(bad.find((s) => s.id === 'customer')?.value).toBe('Disputed');

    const open = buildChain(makeCase({ status: 'open', success: null, matured_at: null }), labels);
    expect(open.find((s) => s.id === 'outcome')?.state).toBe('pending');
    expect(open.find((s) => s.id === 'customer')?.value).toBe('Pending');
  });
});

describe('computeCalibration', () => {
  it('needs at least 10 predicted + matured cases', () => {
    expect(computeCalibration([makeCase({ predicted_success: 0.8 })])).toBeNull();
  });

  it('computes Brier score and bins', () => {
    const cases: OinCase[] = [];
    for (let i = 0; i < 10; i++) cases.push(makeCase({ id: `a${i}`, predicted_success: 0.9, success: i < 9 }));
    for (let i = 0; i < 10; i++) cases.push(makeCase({ id: `b${i}`, predicted_success: 0.3, success: i < 3 }));
    const cal = computeCalibration(cases);
    expect(cal).not.toBeNull();
    expect(cal?.sample).toBe(20);
    expect(cal?.brier).toBeCloseTo((9 * 0.01 + 0.81 + 3 * 0.49 + 7 * 0.09) / 20, 6);
    expect(cal?.bins.map((b) => b.label)).toEqual(['< 50%', '85–100%']);
    expect(cal?.bins[1].actual).toBeCloseTo(0.9, 6);
  });
});
