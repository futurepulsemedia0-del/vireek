import { describe, it, expect } from 'vitest';
import { resolveAttribute, resolveAssetState, scoreClaim, predicateFor, sameValue, ATTRIBUTES, type AssetClaim } from '../../supabase/functions/_shared/asset-reality/state';
import { ASSET_POLICIES, ASSET_SOURCES, HALF_LIFE_DAYS } from '../../supabase/functions/_shared/asset-reality/sources';

const NOW = new Date('2026-11-07T12:00:00Z');
const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const c = (o: Partial<AssetClaim> & { id: string }): AssetClaim => ({
  attribute: 'superheat', value: 8, source_key: 'technician_measurement', method: 'manual', measured_at: ago(0.1), verified: false, ...o,
});

describe('asset state resolution', () => {
  it('no claims => unknown (never a guess); unregistered attribute => unknown', () => {
    expect(resolveAttribute('superheat', [], NOW)).toMatchObject({ status: 'unknown', value: null, winning_claim_id: null });
    expect(resolveAttribute('mystery', [c({ id: 'a', attribute: 'mystery' })], NOW).status).toBe('unknown');
  });
  it('instrument beats manual when they agree within tolerance', () => {
    const r = resolveAttribute('superheat', [c({ id: 'm', value: 8 }), c({ id: 'i', value: 8.5, source_key: 'instrument_bluetooth', method: 'instrument' })], NOW);
    expect(r).toMatchObject({ status: 'ok', winning_claim_id: 'i' });
  });
  it('verified beats unverified', () => {
    const r = resolveAttribute('model', [
      c({ id: 'u', attribute: 'model', value: 'ABC-1', source_key: 'nameplate_ocr', method: 'ocr', verified: false, confirmed: true }),
      c({ id: 'v', attribute: 'model', value: 'ABC-1', source_key: 'technician_measurement', method: 'manual', verified: true })], NOW);
    expect(r.winning_claim_id).toBe('v');
  });
  it('newer beats older within tolerance (identical method)', () => {
    const r = resolveAttribute('refrigerant_charge_kg', [c({ id: 'old', attribute: 'refrigerant_charge_kg', value: 3.0, measured_at: ago(60) }), c({ id: 'new', attribute: 'refrigerant_charge_kg', value: 3.05, measured_at: ago(2) })], NOW);
    expect(r).toMatchObject({ status: 'ok', winning_claim_id: 'new' });
  });
  it('disagreement beyond tolerance opens a conflict, is not safety-eligible, and is never silently overwritten', () => {
    const r = resolveAttribute('refrigerant_charge_kg', [
      c({ id: 'a', attribute: 'refrigerant_charge_kg', value: 3.0, source_key: 'instrument_bluetooth', method: 'instrument', measured_at: ago(5) }),
      c({ id: 'b', attribute: 'refrigerant_charge_kg', value: 4.2, source_key: 'owner_attested', method: 'attestation', measured_at: ago(5) })], NOW);
    expect(r.status).toBe('conflict');
    expect(r.safety_eligible).toBe(false);
    expect(r.conflict_claim_ids.sort()).toEqual(['a', 'b']);
  });
  it('vitals measured days apart do not conflict (the newer reading supersedes)', () => {
    const r = resolveAttribute('superheat', [c({ id: 'a', value: 20, source_key: 'instrument_bluetooth', method: 'instrument', measured_at: ago(3) }), c({ id: 'b', value: 8, source_key: 'instrument_bluetooth', method: 'instrument', measured_at: ago(0.1) })], NOW);
    expect(r).toMatchObject({ status: 'ok', winning_claim_id: 'b', value: 8 });
  });
  it('same origin correcting itself is not a dispute', () => {
    const r = resolveAttribute('refrigerant_charge_kg', [
      c({ id: 'o', attribute: 'refrigerant_charge_kg', value: 3.0, independent_key: 't1', measured_at: ago(10) }),
      c({ id: 'n', attribute: 'refrigerant_charge_kg', value: 3.6, independent_key: 't1', measured_at: ago(1) })], NOW);
    expect(r.status).toBe('ok');
    expect(r.winning_claim_id).toBe('n');
  });
  it('unconfirmed OCR is never safety-eligible; confirmation unlocks it', () => {
    const ocr = c({ id: 'o', attribute: 'rated_amps', value: 15, source_key: 'nameplate_ocr', method: 'ocr', measured_at: ago(30) });
    expect(resolveAttribute('rated_amps', [ocr], NOW).safety_eligible).toBe(false);
    expect(resolveAttribute('rated_amps', [{ ...ocr, confirmed: true }], NOW).safety_eligible).toBe(true);
  });
  it('freshness: vitals decay fast, identity barely', () => {
    const v = scoreClaim(c({ id: 'v', source_key: 'instrument_bluetooth', method: 'instrument', measured_at: ago(HALF_LIFE_DAYS.vital) }), 'vital', NOW)!;
    expect(v.confidence).toBeCloseTo(ASSET_SOURCES.instrument_bluetooth.reliability / 2, 3);
    const i = scoreClaim(c({ id: 'i', attribute: 'make', value: 'X', source_key: 'oem_database', method: 'database', measured_at: ago(365) }), 'identity', NOW)!;
    expect(i.confidence).toBeGreaterThan(0.8);
  });
  it('very stale low-weight vitals fall out entirely => unknown', () => {
    expect(resolveAttribute('superheat', [c({ id: 'x', measured_at: ago(120) })], NOW).status).toBe('unknown');
  });
  it('rejects future-dated claims (spoofed timestamps)', () => {
    expect(resolveAttribute('superheat', [c({ id: 'f', measured_at: '2027-01-01T00:00:00Z' })], NOW).status).toBe('unknown');
  });
  it('is deterministic regardless of input order', () => {
    const cs = [c({ id: 'a', value: 8 }), c({ id: 'b', value: 8.2 }), c({ id: 'c', value: 8.1, source_key: 'installed_sensor', method: 'sensor' })];
    expect(resolveAttribute('superheat', cs, NOW)).toEqual(resolveAttribute('superheat', [...cs].reverse(), NOW));
  });
  it('resolveAssetState lists each attribute once, sorted', () => {
    const s = resolveAssetState([c({ id: '1' }), c({ id: '2', attribute: 'delta_t', value: 10 })], NOW);
    expect(s.map((x) => x.attribute)).toEqual(['delta_t', 'superheat']);
  });
  it('predicates match the truth_facts regex and have a policy', () => {
    const re = /^[a-z][a-z0-9_]*(\.[a-z0-9_:-]+)+$/;
    for (const a of Object.keys(ATTRIBUTES)) {
      const p = predicateFor(a)!;
      expect(re.test(p)).toBe(true);
      expect(ASSET_POLICIES.some((x) => p.startsWith(x.predicate))).toBe(true);
    }
  });
  it('numeric tolerance helper', () => {
    expect(sameValue(10, 10.4, { cls: 'vital', rel: 0.05 })).toBe(true);
    expect(sameValue(10, 11, { cls: 'vital', rel: 0.05 })).toBe(false);
    expect(sameValue('abc-1 ', 'ABC-1', { cls: 'identity' })).toBe(true);
  });
});

import { getSource, resolvePolicy, resolveTruth, isUserAssertable } from '../../supabase/functions/_shared/truth/engine';
describe('Operational Truth integration', () => {
  it('asset sources and policies are registered in the existing engine', () => {
    expect(getSource('instrument_bluetooth').reliability).toBe(0.92);
    expect(getSource('regulatory_record').authoritative).toBe(true);
    expect(isUserAssertable('instrument_bluetooth')).toBe(false); // device-only: users cannot self-assert it
    expect(resolvePolicy('asset.vital.superheat').max_age_days).toBe(14);
    expect(resolvePolicy('asset.identity.serial_number').max_age_days).toBe(3650);
  });
  it('a fresh instrument claim verifies; a stale vital does not', () => {
    const f = (age: number) => ({ id: 'f', subject_type: 'asset', subject_id: 'p1', predicate: 'asset.vital.superheat', value: true, source_key: 'instrument_bluetooth', source_ref: null, verified_at: new Date(NOW.getTime() - age * 86_400_000).toISOString(), expires_at: null, base_confidence: 0.92, evidence_count: 1 });
    const pol = resolvePolicy('asset.vital.superheat');
    expect(resolveTruth([f(1)], pol, { now: NOW }).verdict).toBe('verified');
    expect(resolveTruth([f(30)], pol, { now: NOW }).verdict).not.toBe('verified');
  });
});
