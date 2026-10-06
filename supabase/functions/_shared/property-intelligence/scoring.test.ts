import { describe, it, expect } from 'vitest';
import { buildAddressKey, normalizeStreet, hasUsableAddress, phoneCandidates, parseMatchedAddress } from './address';
import {
  assessHvac,
  buildGraph,
  buildVoiceContext,
  classifyPermit,
  climateFromMonthly,
  climateLifeFactor,
  deriveSignals,
  scoreFromAgeRatio,
  summarizeService,
} from './scoring';
import type { EquipmentLite, JobLite, ProfileFacts } from './types';

const NOW = Date.UTC(2026, 9, 2);
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;
const yearsAgo = (n: number) => new Date(NOW - n * YEAR_MS).toISOString().slice(0, 10);
const NOW_YEAR = 2026;

const hvacUnit = (installYearsAgo: number | null, extra: Partial<EquipmentLite> = {}): EquipmentLite => ({
  id: 'e1',
  equipment_type: 'Central Air Conditioner',
  make: 'Carrier',
  model: null,
  install_date: installYearsAgo === null ? null : yearsAgo(installYearsAgo),
  status: 'active',
  expected_lifespan_years: 15,
  last_service_date: null,
  ...extra,
});

const job = (id: string, service_type: string, monthsAgo: number, job_status = 'completed'): JobLite => ({
  id,
  service_type,
  job_status,
  scheduled_datetime: new Date(NOW - monthsAgo * 30.4375 * 24 * 60 * 60 * 1000).toISOString(),
});

const baseInput = { yearBuilt: null, equipment: [], jobs: [], permits: [], climate: null, nowMs: NOW };

describe('address helpers', () => {
  it('normalizes suffixes, directions and unit numbers', () => {
    expect(normalizeStreet('123 North Main Street, Apt 4B')).toBe('123 n main st');
    expect(normalizeStreet('500 Oak Avenue #12')).toBe('500 oak ave');
  });

  it('builds a stable key from street + 5-digit ZIP', () => {
    expect(buildAddressKey('123 N Main St', '78701-1234')).toBe('123 n main st|78701');
    expect(buildAddressKey('123 North Main Street', '78701')).toBe(buildAddressKey('123 n main st', '78701'));
  });

  it('requires a street plus ZIP or city+state', () => {
    expect(hasUsableAddress({ address: '1 Main St', city: null, state: null, postal_code: '78701' })).toBe(true);
    expect(hasUsableAddress({ address: '1 Main St', city: 'Austin', state: 'TX', postal_code: null })).toBe(true);
    expect(hasUsableAddress({ address: '1 Main St', city: 'Austin', state: null, postal_code: null })).toBe(false);
    expect(hasUsableAddress({ address: '', city: 'Austin', state: 'TX', postal_code: '78701' })).toBe(false);
  });

  it('expands phone formats and parses Census matched addresses', () => {
    expect(phoneCandidates('+15125551212')).toEqual(expect.arrayContaining(['+15125551212', '5125551212', '15125551212']));
    expect(phoneCandidates(null)).toEqual([]);
    expect(parseMatchedAddress('123 MAIN ST, AUSTIN, TX, 78701')).toEqual({ street1: '123 MAIN ST', city: 'AUSTIN', state: 'TX', zip: '78701' });
  });
});

describe('classifyPermit', () => {
  it('detects trades from type, description and permit-number tokens', () => {
    expect(classifyPermit(['2016-MECH-0003896'])).toBe('hvac');
    expect(classifyPermit(['Replace 3 ton AC condenser'])).toBe('hvac');
    expect(classifyPermit(['2018-ELEC-0014039'])).toBe('electrical');
    expect(classifyPermit(['Re-roof composition shingle'])).toBe('roofing');
    expect(classifyPermit(['Water heater replacement'])).toBe('water_heater');
    expect(classifyPermit(['Rooftop solar PV system'])).toBe('solar');
    expect(classifyPermit([null, undefined])).toBe('other');
  });
});

describe('climate', () => {
  const austinLike = [10, 12, 16, 20, 25, 28, 30, 30, 26, 21, 15, 11];

  it('estimates degree days and profile from monthly means', () => {
    const c = climateFromMonthly(austinLike);
    expect(c.cdd65f_est).toBeGreaterThan(2500);
    expect(c.hdd65f_est).toBeGreaterThan(800);
    expect(c.profile).toBe('cooling_dominated');
  });

  it('reduces expected life in harsh climates, never below the cap', () => {
    expect(climateLifeFactor(null)).toBe(1);
    expect(climateLifeFactor(climateFromMonthly(austinLike))).toBeLessThan(1);
    expect(climateLifeFactor(climateFromMonthly(Array(12).fill(40)))).toBeGreaterThanOrEqual(0.85);
  });
});

describe('scoreFromAgeRatio', () => {
  it('is continuous at the band edges and capped at 95', () => {
    expect(scoreFromAgeRatio(0.5)).toBeCloseTo(20);
    expect(scoreFromAgeRatio(0.8)).toBeCloseTo(50);
    expect(scoreFromAgeRatio(1)).toBeCloseTo(75);
    expect(scoreFromAgeRatio(5)).toBe(95);
    expect(scoreFromAgeRatio(-1)).toBe(0);
  });
});

describe('assessHvac', () => {
  it('scores an aged tracked system as high with high confidence', () => {
    const a = assessHvac({ ...baseInput, equipment: [hvacUnit(16)] });
    expect(a.basis).toBe('equipment_record');
    expect(a.level).toBe('high');
    expect(a.score).toBeGreaterThanOrEqual(70);
    expect(a.confidence).toBe(0.9);
    expect(a.ceiling_score).toBeNull();
  });

  it('caps the score for a recently replaced system', () => {
    const a = assessHvac({ ...baseInput, equipment: [hvacUnit(1)], jobs: [job('a', 'AC repair', 1), job('b', 'AC repair', 2), job('c', 'AC repair', 3)] });
    expect(a.score).toBeLessThanOrEqual(12);
    expect(a.level).toBe('low');
  });

  it('adds a bounded bump for repeat repairs and ignores non-HVAC / non-completed jobs', () => {
    const jobs = [
      job('1', 'AC repair', 2), job('2', 'Furnace repair', 5), job('3', 'HVAC diagnostic', 8),
      job('4', 'Drain cleaning', 3), job('5', 'AC repair', 4, 'cancelled'), job('6', 'AC repair', 40),
    ];
    const a = assessHvac({ ...baseInput, equipment: [hvacUnit(10)], jobs });
    expect(a.hvac_repairs_24m).toBe(3);
    const without = assessHvac({ ...baseInput, equipment: [hvacUnit(10)] });
    expect((a.score ?? 0) - (without.score ?? 0)).toBe(18);
  });

  it('prefers the most recent replacement evidence', () => {
    const a = assessHvac({
      ...baseInput,
      equipment: [hvacUnit(20)],
      jobs: [job('i', 'AC replacement install', 24)],
    });
    expect(a.basis).toBe('service_history');
    expect(a.estimated_age_years).toBeCloseTo(2, 0);
  });

  it('uses an HVAC permit when it is the best evidence, and asks whether it was a full replacement', () => {
    const a = assessHvac({ ...baseInput, permits: [{ work_category: 'hvac', issued_date: yearsAgo(12) }] });
    expect(a.basis).toBe('permit');
    expect(a.ask_caller).toMatch(/full replacement/i);
  });

  it('ignores replaced/removed equipment and future install dates', () => {
    const a = assessHvac({
      ...baseInput,
      equipment: [hvacUnit(18, { status: 'replaced' }), hvacUnit(-2, { id: 'e2' })],
      yearBuilt: NOW_YEAR - 5,
    });
    expect(a.basis).toBe('year_built');
  });

  it('falls back to year built with an honest range and low confidence for an old home', () => {
    const a = assessHvac({ ...baseInput, yearBuilt: NOW_YEAR - 24 });
    expect(a.basis).toBe('year_built');
    expect(a.score).toBe(30);
    expect(a.ceiling_score).toBe(95);
    expect(a.confidence).toBe(0.25);
    expect(a.ask_caller).toBeTruthy();
  });

  it('treats a young home as likely still original (higher confidence)', () => {
    const a = assessHvac({ ...baseInput, yearBuilt: NOW_YEAR - 6 });
    expect(a.confidence).toBe(0.4);
    expect(a.ceiling_score).toBeNull();
    expect(a.level).toBe('low');
  });

  it('returns unknown — never invents a score — when nothing is known', () => {
    const a = assessHvac(baseInput);
    expect(a.level).toBe('unknown');
    expect(a.score).toBeNull();
    expect(a.confidence).toBe(0);
  });
});

describe('deriveSignals', () => {
  it('flags era-specific risks by year built', () => {
    const hvac = assessHvac(baseInput);
    const ids = (y: number) => deriveSignals({ yearBuilt: y, hvac, climate: null, permits: [], nowMs: NOW }).map((s) => s.id);
    expect(ids(1970)).toEqual(expect.arrayContaining(['lead_paint_era', 'aluminum_wiring_era']));
    expect(ids(1985)).toEqual(expect.arrayContaining(['polybutylene_era']));
    expect(ids(1985)).not.toContain('lead_paint_era');
    expect(ids(2005)).toEqual([]);
  });

  it('flags repeat repairs and recent permitted HVAC work', () => {
    const jobs = [job('1', 'AC repair', 1), job('2', 'AC repair', 4), job('3', 'AC repair', 9)];
    const hvac = assessHvac({ ...baseInput, equipment: [hvacUnit(8)], jobs });
    const signals = deriveSignals({ yearBuilt: 2010, hvac, climate: null, permits: [{ work_category: 'hvac', issued_date: yearsAgo(2) }], nowMs: NOW });
    expect(signals.map((s) => s.id)).toEqual(expect.arrayContaining(['repeat_hvac_repairs', 'recent_hvac_permit']));
  });
});

describe('voice context (privacy allowlist)', () => {
  const profile: ProfileFacts = {
    formatted_address: '123 SECRET ST, AUSTIN, TX, 78701',
    apn: 'APN-999-111',
    property_type: 'Single Family',
    year_built: 2002,
    year_built_source: 'provider',
    living_sqft: 1850,
    lot_sqft: 7000,
    bedrooms: 3,
    bathrooms: 2,
    stories: 1,
    heating_type: 'Gas Forced Air',
    cooling_type: 'Central',
    has_heating: true,
    has_cooling: true,
    census_tract: '001234',
    climate: climateFromMonthly([10, 12, 16, 20, 25, 28, 30, 30, 26, 21, 15, 11]),
    energy: null,
  };

  it('never leaks address, APN or tract, and carries the do-not-recite rules', () => {
    const hvac = assessHvac({ ...baseInput, yearBuilt: 2002, climate: profile.climate });
    const signals = deriveSignals({ yearBuilt: 2002, hvac, climate: profile.climate, permits: [], nowMs: NOW });
    const text = buildVoiceContext({ profile, hvac, signals, service: summarizeService([], 0), nowMs: NOW });
    expect(text).not.toMatch(/SECRET|APN-999|001234|78701/i);
    expect(text).toMatch(/never read records aloud/i);
    expect(text).toMatch(/built 2002/);
    expect(text.length).toBeLessThanOrEqual(1400);
  });
});

describe('buildGraph', () => {
  it('returns the full 11-node chain and lower coverage when data is missing', () => {
    const hvac = assessHvac(baseInput);
    const service = summarizeService([], 0);
    const empty = buildGraph({ addressLine: '1 Main St, Austin, TX 78701', profile: null, providers: {}, equipment: [], permits: [], service, hvac, nowMs: NOW });
    expect(empty.nodes.map((n) => n.kind)).toEqual([
      'address', 'parcel', 'characteristics', 'building_age', 'square_footage',
      'permits', 'equipment', 'climate', 'utility', 'energy', 'service_history',
    ]);
    expect(empty.nodes.find((n) => n.id === 'parcel')?.state).toBe('missing');

    const hvac2 = assessHvac({ ...baseInput, yearBuilt: 2002 });
    const full = buildGraph({
      addressLine: null,
      profile: { formatted_address: '1 MAIN ST', apn: '1', property_type: 'Single Family', year_built: 2002, year_built_source: 'manual', living_sqft: 1800, lot_sqft: 6000, bedrooms: 3, bathrooms: 2, stories: 1, heating_type: 'Gas', cooling_type: 'Central', has_heating: true, has_cooling: true, census_tract: null, climate: climateFromMonthly([10, 12, 16, 20, 25, 28, 30, 30, 26, 21, 15, 11]), energy: { source: 'eia', state: 'TX', residential_cents_per_kwh: 14.2, residential_cents_per_kwh_12m_avg: 14.0, period: '2026-07' } },
      providers: { attom_permits: { state: 'ok' } },
      equipment: [hvacUnit(5)], permits: [], service, hvac: hvac2, nowMs: NOW,
    });
    expect(full.coverage).toBeGreaterThan(empty.coverage);
    expect(full.nodes.find((n) => n.id === 'building_age')?.source).toMatch(/entered by your team/);
    expect(full.nodes.find((n) => n.id === 'permits')?.value).toBe('None on record');
  });
});
