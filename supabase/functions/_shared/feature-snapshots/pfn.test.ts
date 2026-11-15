// @vitest-environment node
// Feature-store pilot (docs/adr/0001-feature-store-pilot.md): the PFN snapshot builder is pure, so everything
// here is a real executed check — no mocks. The DB side is covered by supabase/tests/database/ml_feature_snapshots.test.sql.
import { describe, expect, it } from 'vitest';
import {
  ENGINE_VERSION,
  predictUnit,
  type Learning,
  type ModeDef,
  type UnitInput,
} from '../predictive-failure/engine';
import {
  MAX_SNAPSHOT_ATLAS_CELLS,
  MAX_SNAPSHOT_EVENTS,
  PFN_FEATURE_SET_VERSION,
  PFN_SNAPSHOT_CONFLICT_TARGET,
  buildPfnFeatureVector,
  buildPfnSnapshotRow,
  unitInputFromPfnFeatures,
} from './pfn';
import { fingerprintOf } from '../import-framework/hash';

const NOW = new Date('2026-10-04T12:00:00Z');
const DAY = 86_400_000;
/** Full-precision ISO timestamp N years before NOW (no date truncation, so month maths is exact). */
const yearsAgo = (y: number) => new Date(NOW.getTime() - y * 365.25 * DAY).toISOString();

const OWNER = '00000000-0000-0000-0000-0000000000a1';
const EQUIPMENT_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';

const CATALOG: ModeDef[] = [
  {
    key: 'capacitor_failure', label: 'Capacitor failure', families: ['hvac_cooling'], shape: 2, scaleMonths: 96,
    aliases: [], partKeywords: ['capacitor'], maintenanceSensitive: true, runtimeDriven: false,
    seasonal: 'cooling', safetyCritical: false, typicalCostCents: 25_000,
    intervention: { key: 'rc', label: 'Test and replace the run capacitor', kind: 'preventive_repair', parts: ['Run capacitor'], estMinutes: 45 },
  },
  {
    key: 'end_of_life_wearout', label: 'End-of-life wear-out', families: ['hvac_cooling', 'generic'], shape: 4, scaleMonths: null,
    aliases: [], partKeywords: [], maintenanceSensitive: false, runtimeDriven: false,
    seasonal: 'none', safetyCritical: false, typicalCostCents: 350_000,
    intervention: { key: 'rp', label: 'Plan a replacement', kind: 'replacement_planning', parts: [], estMinutes: 240 },
  },
];
const LEARNING: Learning = { modeStats: {}, bins: null, resolvedCount: 0, costByMode: {} };

function unit(over: Partial<UnitInput> = {}): UnitInput {
  return {
    equipmentId: EQUIPMENT_ID, customerId: CUSTOMER_ID, equipmentType: 'Central AC', make: 'Carrier', model: '24ACC',
    installDate: yearsAgo(10), lastServiceDate: yearsAgo(0.5), expectedLifespanYears: 15, serviceIntervalMonths: 12,
    customerType: 'residential', profile: { dutyClass: 'heavy', environment: 'coastal' },
    history: {
      events: [
        { at: yearsAgo(0.3), type: 'repair', rootCause: 'bad capacitor', parts: ['Run capacitor'], callback: false, single: true },
        { at: yearsAgo(2), type: 'maintenance', rootCause: null, parts: [], callback: false, single: false },
      ],
      repairs12m: 1, repairs6m: 1, repairsPrev6m: 0, callbacks12m: 0, companies24m: 1,
      repeatPart: null, repeatPartCount: 0, lastServiceAt: yearsAgo(0.3), crossCompany: false,
    },
    atlas: [
      { failureMode: 'capacitor_failure', unitsObserved: 120, failureRatePct: 14.5, medianAgeMonths: 96, p25AgeMonths: 70, p75AgeMonths: 120, contributorCount: 9 },
    ],
    weather: { heat30d: 4, cold30d: 0 },
    ...over,
  };
}

const opts = { now: NOW, horizonDays: 90 };
/** What the DB does to the JSON between write and read. */
const viaDb = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('buildPfnFeatureVector', () => {
  it('records the feature-set version, the instant it describes and the input vector', () => {
    const f = buildPfnFeatureVector(unit(), NOW);
    expect(f.feature_set_version).toBe(PFN_FEATURE_SET_VERSION);
    expect(f.as_of).toBe(NOW.toISOString());
    expect(f.inputs.equipment_type).toBe('Central AC');
    expect(f.inputs.profile).toEqual({ duty_class: 'heavy', environment: 'coastal' });
    expect(f.inputs.history.repairs12m).toBe(1);
    expect(f.inputs.atlas[0].failure_mode).toBe('capacitor_failure');
    expect(f.meta).toEqual({ events_total: 2, events_kept: 2, atlas_total: 1, atlas_kept: 1, replayable: true });
  });

  it('derives age, lifespan use and overdue ratio at as_of', () => {
    const f = buildPfnFeatureVector(unit({ installDate: yearsAgo(10), lastServiceDate: yearsAgo(2), serviceIntervalMonths: 12,
      history: { ...unit().history, lastServiceAt: null } }), NOW);
    expect(f.derived.age_months).toBeCloseTo(120, 3);
    expect(f.derived.lifespan_months).toBe(180);
    expect(f.derived.lifespan_used_ratio).toBeCloseTo(120 / 180, 3);
    expect(f.derived.months_since_service).toBeCloseTo(24, 3);
    expect(f.derived.service_overdue_ratio).toBeCloseTo(2, 3);
  });

  it('uses the most recent of last_service_date, install_date and history.last_service_at', () => {
    const f = buildPfnFeatureVector(unit({ lastServiceDate: yearsAgo(3), installDate: yearsAgo(10),
      history: { ...unit().history, lastServiceAt: yearsAgo(1) } }), NOW);
    expect(f.derived.months_since_service).toBeCloseTo(12, 3);
  });

  it('never invents age: missing, invalid or future install dates give null', () => {
    for (const installDate of [null, 'not-a-date', new Date(NOW.getTime() + 30 * DAY).toISOString()]) {
      const f = buildPfnFeatureVector(unit({ installDate }), NOW);
      expect(f.derived.age_months).toBeNull();
      expect(f.derived.lifespan_used_ratio).toBeNull();
    }
  });

  it('keeps the 15-year fallback only for a missing lifespan and leaves overdue null without an interval', () => {
    const f = buildPfnFeatureVector(unit({ expectedLifespanYears: 0, serviceIntervalMonths: 0 }), NOW);
    expect(f.derived.lifespan_months).toBe(180);
    expect(f.derived.service_overdue_ratio).toBeNull();
  });

  it('turns non-finite numbers into explicit 0 / null instead of silent JSON nulls', () => {
    const f = buildPfnFeatureVector(unit({ weather: { heat30d: Number.NaN, cold30d: Infinity } }), NOW);
    expect(f.inputs.weather).toEqual({ heat30d: 0, cold30d: 0 });
  });

  it('rejects an invalid as_of', () => {
    expect(() => buildPfnFeatureVector(unit(), new Date('nope'))).toThrow(RangeError);
  });

  it('stores no customer or equipment identifier inside features', () => {
    const json = JSON.stringify(buildPfnFeatureVector(unit(), NOW));
    expect(json).not.toContain(CUSTOMER_ID);
    expect(json).not.toContain(EQUIPMENT_ID);
  });

  it('caps oversized arrays and marks the snapshot non-replayable instead of pretending', () => {
    const events = Array.from({ length: MAX_SNAPSHOT_EVENTS + 5 }, (_, n) => ({
      at: yearsAgo(1 + n / 1000), type: 'repair', rootCause: null, parts: [], callback: false, single: false,
    }));
    const atlas = Array.from({ length: MAX_SNAPSHOT_ATLAS_CELLS + 3 }, (_, n) => ({
      failureMode: `m${n}`, unitsObserved: 10, failureRatePct: 1, medianAgeMonths: 50, p25AgeMonths: 40, p75AgeMonths: 60, contributorCount: 6,
    }));
    const f = buildPfnFeatureVector(unit({ history: { ...unit().history, events }, atlas }), NOW);
    expect(f.inputs.history.events).toHaveLength(MAX_SNAPSHOT_EVENTS);
    expect(f.inputs.atlas).toHaveLength(MAX_SNAPSHOT_ATLAS_CELLS);
    expect(f.meta).toMatchObject({ events_total: MAX_SNAPSHOT_EVENTS + 5, atlas_total: MAX_SNAPSHOT_ATLAS_CELLS + 3, replayable: false });
    const r = unitInputFromPfnFeatures(viaDb(f), { equipmentId: EQUIPMENT_ID, customerId: null });
    expect(r).toEqual({ ok: false, reason: 'snapshot is not replayable (arrays were capped)' });
  });
});

describe('buildPfnSnapshotRow', () => {
  const args = { owner: OWNER, unit: unit(), asOf: NOW, engineVersion: ENGINE_VERSION, sourceId: '33333333-3333-4333-8333-333333333333' };

  it('fills every column the table requires and matches its CHECK constraints', () => {
    const row = buildPfnSnapshotRow(args);
    expect(row).toMatchObject({
      user_id: OWNER, engine: 'pfn', engine_version: ENGINE_VERSION, feature_set_version: PFN_FEATURE_SET_VERSION,
      entity_type: 'equipment', entity_id: EQUIPMENT_ID, as_of: NOW.toISOString(),
      source_table: 'pfn_forecasts', source_id: args.sourceId,
    });
    expect(row.features_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(row.engine).toMatch(/^[a-z][a-z0-9_]{1,47}$/);
    expect(row.feature_set_version).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/);
    expect(JSON.stringify(row.features).length).toBeLessThanOrEqual(262_144);
  });

  it('keeps source_table and source_id paired (both null for ad-hoc snapshots)', () => {
    const row = buildPfnSnapshotRow({ ...args, sourceId: null });
    expect(row.source_table).toBeNull();
    expect(row.source_id).toBeNull();
  });

  it('hashes deterministically, independent of key order, and changes when a feature changes', () => {
    const a = buildPfnSnapshotRow(args);
    const b = buildPfnSnapshotRow({ ...args, unit: unit() });
    expect(a.features_hash).toBe(b.features_hash);
    // the hash must not depend on JSON key order (Postgres jsonb does not preserve it)
    const f = buildPfnFeatureVector(unit(), NOW);
    const shuffled = Object.fromEntries(Object.entries(f).reverse());
    expect(fingerprintOf(shuffled)).toBe(a.features_hash);
    const changed = buildPfnSnapshotRow({ ...args, unit: unit({ weather: { heat30d: 5, cold30d: 0 } }) });
    expect(changed.features_hash).not.toBe(a.features_hash);
  });

  it('advertises the conflict target the unique index uses', () => {
    expect(PFN_SNAPSHOT_CONFLICT_TARGET).toBe('user_id,engine,feature_set_version,entity_type,entity_id,as_of');
  });
});

describe('replay determinism (point-in-time correctness)', () => {
  const variants: Array<[string, Partial<UnitInput>]> = [
    ['healthy unit', {}],
    ['no profile, no history', { profile: null, history: { ...unit().history, events: [], repairs12m: 0, repairs6m: 0, lastServiceAt: null } }],
    ['old, overdue, repeatedly repaired', {
      installDate: yearsAgo(14), lastServiceDate: yearsAgo(4), weather: { heat30d: 6, cold30d: 0 },
      history: { events: [], repairs12m: 3, repairs6m: 2, repairsPrev6m: 1, callbacks12m: 2, companies24m: 2,
        repeatPart: 'run capacitor', repeatPartCount: 3, lastServiceAt: null, crossCompany: true },
    }],
    ['no network atlas', { atlas: [] }],
  ];

  it.each(variants)('predictUnit() on a stored snapshot reproduces the original forecast: %s', (_name, over) => {
    const original = unit(over);
    const expected = predictUnit(original, CATALOG, LEARNING, opts);
    expect(expected).not.toBeNull();

    const stored = viaDb(buildPfnFeatureVector(original, NOW));
    const replay = unitInputFromPfnFeatures(stored, { equipmentId: EQUIPMENT_ID, customerId: CUSTOMER_ID });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(predictUnit(replay.unit, CATALOG, LEARNING, opts)).toEqual(expected);
  });

  it('refuses unknown versions and malformed shapes instead of guessing', () => {
    const ids = { equipmentId: EQUIPMENT_ID, customerId: null };
    const good = viaDb(buildPfnFeatureVector(unit(), NOW));
    expect(unitInputFromPfnFeatures(null, ids).ok).toBe(false);
    expect(unitInputFromPfnFeatures([], ids).ok).toBe(false);
    expect(unitInputFromPfnFeatures({ ...good, feature_set_version: 'pfn-features-999' }, ids))
      .toEqual({ ok: false, reason: 'unsupported feature_set_version: pfn-features-999' });
    expect(unitInputFromPfnFeatures({ ...good, inputs: { ...good.inputs, atlas: 'x' } }, ids))
      .toEqual({ ok: false, reason: 'inputs are malformed' });
    expect(unitInputFromPfnFeatures({ ...good, inputs: { ...good.inputs, equipment_type: 7 } }, ids).ok).toBe(false);
  });
});

describe('derived features stay pinned to the engine (guards silent training/serving skew)', () => {
  it('age_months equals the unit age the engine itself used', () => {
    const u = unit({ installDate: yearsAgo(7.25) });
    const f = predictUnit(u, CATALOG, LEARNING, opts);
    const eol = f?.modes.find((m) => m.mode === 'end_of_life_wearout');
    expect(eol?.ageSource).toBe('unit_age');
    expect(buildPfnFeatureVector(u, NOW).derived.age_months).toBeCloseTo(eol?.ageMonths ?? Number.NaN, 1);
  });

  it('service_overdue_ratio equals the ratio behind the engine overdue_service factor', () => {
    // engine: factor.ratio = 1 + 0.4 * min(r - 1, 2)  =>  r = 1 + (ratio - 1) / 0.4  (valid while r - 1 < 2)
    const u = unit({ lastServiceDate: yearsAgo(1.75), history: { ...unit().history, lastServiceAt: null, events: [] }, installDate: yearsAgo(8) });
    const f = predictUnit(u, CATALOG, LEARNING, opts);
    const factor = f?.modes.find((m) => m.mode === 'capacitor_failure')?.factors.find((x) => x.key === 'overdue_service');
    expect(factor).toBeDefined();
    const engineRatio = 1 + ((factor?.ratio ?? 1) - 1) / 0.4;
    expect(buildPfnFeatureVector(u, NOW).derived.service_overdue_ratio).toBeCloseTo(engineRatio, 1);
  });
});
