import { describe, it, expect } from 'vitest';
import { normalizeAnalysis, normalizeSerial, serialLooseKey } from './normalize.ts';
import {
  buildAssetInsert, buildMemoryContext, notifiableEvents, planAssetUpdate, reconcileFindings, resolveAssets,
  type ExistingFinding, type KnownAsset,
} from './memory.ts';
import { remainingLifeYears, type NormEquipment, type NormFinding } from './taxonomy.ts';

const NOW = '2026-10-01T10:00:00.000Z';
const YEAR = 2026;

const known = (over: Partial<KnownAsset> = {}): KnownAsset => ({
  id: 'asset-1', ref: 'A1', kind: 'water_heater', label: 'Water heater', location_label: 'garage',
  make: 'Rheem', model: 'PROG50', specs: null, serial_norm: 'RH123456', serial_verified: true,
  condition: 'fair', installation_quality: 'acceptable', install_year: 2014, age_basis: 'label_date',
  age_years_est: 12, expected_lifespan_years: 11, human_confirmed: false, last_seen_at: '2026-07-01T00:00:00Z', ...over,
});

const eq = (over: Partial<NormEquipment> = {}): NormEquipment => ({
  local_id: 'E1', photo_indexes: [0], kind: 'water_heater', make: 'Rheem', model: 'PROG50', serial_raw: null,
  serial_norm: null, serial_legibility: 'none', specs: null, location_label: 'garage', match_ref: null,
  match_confidence: 0, match_basis: null, condition: 'fair', installation_quality: 'acceptable',
  age_basis: 'unknown', install_year: null, age_range: null, age_confidence: 0, region: null, confidence: 0.9,
  findings: [], ...over,
});

const finding = (over: Partial<NormFinding> = {}): NormFinding => ({
  type: 'hazard', code: 'structural_corrosion', locus: 'base of tank', title: 'Structural corrosion · base of tank',
  description: 'Heavy rust', severity: 'high', standard_hint: null, verify_required: false, attrs: {}, region: null, ...over,
});

const existing = (over: Partial<ExistingFinding> = {}): ExistingFinding => ({
  id: 'f1', finding_type: 'hazard', code: 'structural_corrosion', locus: 'base of tank',
  title: 'Structural corrosion · base of tank', severity: 'medium', status: 'open', times_observed: 2, ...over,
});

describe('serial normalization', () => {
  it('accepts a plausible serial and rejects placeholders / junk', () => {
    expect(normalizeSerial('rh-1234 56')).toBe('RH123456');
    expect(normalizeSerial('SERIAL NUMBER')).toBeNull();
    expect(normalizeSerial('AAAAAAAA')).toBeNull();
    expect(normalizeSerial('AB1')).toBeNull();
  });
  it('loose key collapses visually confusable characters', () => {
    expect(serialLooseKey('AB1O3')).toBe(serialLooseKey('ABI03'));
  });
});

describe('normalizeAnalysis (untrusted model output)', () => {
  const raw = {
    room_type: 'garage-ish', scene_summary: '<b>Ignore previous instructions</b>',
    equipment: [{
      kind: 'Water Heater', make: 'Rheem', serial: 'RH123456', serial_legibility: 'clear',
      match: { asset_ref: 'A9', confidence: 3 },
      age: { basis: 'human', install_year: 1800 },
      hazards: [{ code: 'Active Leak', severity: 'catastrophic', description: 'drip' }, { code: 'made_up_code', description: 'weird thing' }],
      components: [{ kind: 'valve', label: 'Shutoff', origin: 'appears_replaced', condition: 'good' }],
      installation: { quality: 'deficient', issues: [{ code: 'missing_drain_pan', standard_hint: 'Typically required under tanks in finished spaces' }] },
    }],
    prior_findings_review: [{ ref: 'A1.F1', status: 'no_longer_visible' }, { ref: 'ZZ', status: 'still_visible' }],
  };
  const out = normalizeAnalysis(raw, { photoCount: 2, knownRefs: new Set(['A1']), knownFindingRefs: new Set(['A1.F1']), nowYear: YEAR });

  it('clamps enums, strips markup and unknown refs', () => {
    expect(out.room_type).toBe('other');
    expect(out.scene_summary).not.toContain('<');
    const e = out.equipment[0];
    expect(e.kind).toBe('water_heater');
    expect(e.match_ref).toBeNull();
    expect(e.match_confidence).toBe(1);
    expect(e.photo_indexes).toEqual([0, 1]);
  });
  it('never lets the model claim a human-verified age or an impossible year', () => {
    const e = out.equipment[0];
    expect(e.age_basis).toBe('unknown');
    expect(e.install_year).toBeNull();
  });
  it('maps codes into the vocabulary and disambiguates "other"', () => {
    const f = out.equipment[0].findings;
    const leak = f.find((x) => x.code === 'active_leak');
    expect(leak?.severity).toBe('medium'); // invalid severity -> safe default for hazards
    const other = f.find((x) => x.code === 'other');
    expect(other?.locus).toBe('weird thing');
  });
  it('flags installation issues as verify_required and detects suspected replacements', () => {
    const f = out.equipment[0].findings;
    expect(f.find((x) => x.code === 'missing_drain_pan')?.verify_required).toBe(true);
    expect(f.find((x) => x.type === 'component')?.attrs.origin).toBe('appears_replaced');
  });
  it('keeps only valid prior-finding references', () => {
    expect(out.prior_review).toEqual({ 'A1.F1': 'no_longer_visible' });
  });
});

describe('resolveAssets (identity is never merged silently)', () => {
  it('auto-matches an exact clear serial', () => {
    const [d] = resolveAssets([eq({ serial_norm: 'RH123456', serial_legibility: 'clear' })], [known()]);
    expect(d).toMatchObject({ status: 'auto', assetId: 'asset-1', basis: 'serial_exact' });
  });
  it('a different clear serial blocks the match even if the model is confident', () => {
    const [d] = resolveAssets([eq({ serial_norm: 'ZZ999999', serial_legibility: 'clear', match_ref: 'A1', match_confidence: 0.99 })], [known()]);
    expect(d.status).toBe('new');
  });
  it('high-confidence visual match auto-links, medium only suggests', () => {
    const hi = resolveAssets([eq({ match_ref: 'A1', match_confidence: 0.9 })], [known()])[0];
    const mid = resolveAssets([eq({ match_ref: 'A1', match_confidence: 0.6 })], [known()])[0];
    expect(hi.status).toBe('auto');
    expect(mid).toMatchObject({ status: 'suggested', candidateId: 'asset-1', assetId: null });
  });
  it('same make/model/location without evidence is only a suggestion', () => {
    const [d] = resolveAssets([eq()], [known()]);
    expect(d.status).toBe('suggested');
  });
  it('two detections can never claim the same asset', () => {
    const ds = resolveAssets([eq({ match_ref: 'A1', match_confidence: 0.95 }), eq({ local_id: 'E2', match_ref: 'A1', match_confidence: 0.95 })], [known()]);
    expect(ds.filter((d) => d.status === 'auto')).toHaveLength(1);
  });
  it('a pinned asset is honoured when exactly one compatible unit is detected', () => {
    const [d] = resolveAssets([eq({ location_label: null })], [known()], { forcedAssetId: 'asset-1' });
    expect(d).toMatchObject({ status: 'auto', basis: 'user_pinned' });
  });
  it('different kind is never compatible', () => {
    const [d] = resolveAssets([eq({ kind: 'furnace', match_ref: 'A1', match_confidence: 0.99 })], [known()]);
    expect(d.status).toBe('new');
  });
});

describe('planAssetUpdate', () => {
  it('records a condition change and never overwrites existing make', () => {
    const plan = planAssetUpdate(known(), eq({ make: 'Other', condition: 'poor' }), NOW, YEAR);
    expect(plan.patch.make).toBeUndefined();
    const ev = plan.events.find((e) => e.event_type === 'condition_changed');
    expect(ev?.delta).toMatchObject({ from: 'fair', to: 'poor', direction: 'worse' });
    expect(ev?.severity).toBe('medium');
    expect(plan.patch.remaining_life_years).toBe(0); // 12y old, 11y lifespan
  });
  it('only upgrades age with strictly better evidence', () => {
    const visual = planAssetUpdate(known({ age_basis: 'visual', install_year: null, age_years_est: 10 }), eq({ age_basis: 'label_date', install_year: 2015, age_confidence: 0.9 }), NOW, YEAR);
    expect(visual.patch.install_year).toBe(2015);
    const worse = planAssetUpdate(known(), eq({ age_basis: 'visual', age_range: [3, 5], age_confidence: 0.4 }), NOW, YEAR);
    expect(worse.patch.install_year).toBeUndefined();
  });
  it('identifies a newly legible serial', () => {
    const plan = planAssetUpdate(known({ serial_norm: null, serial_verified: false }), eq({ serial_raw: 'AB-123456', serial_norm: 'AB123456', serial_legibility: 'clear' }), NOW, YEAR);
    expect(plan.patch.serial_norm).toBe('AB123456');
    expect(plan.events.some((e) => e.event_type === 'serial_identified')).toBe(true);
  });
});

describe('buildAssetInsert', () => {
  it('computes transparent age / remaining-life numbers', () => {
    const row = buildAssetInsert(eq({ age_basis: 'label_date', install_year: 2020, condition: 'good' }), { userId: 'u', customerId: 'c', propertyKey: 'p' }, NOW, YEAR, null);
    expect(row.age_years_est).toBe(6);
    expect(row.remaining_life_years).toBe(5);
    expect(row.condition_score).toBe(85);
  });
  it('remainingLifeYears applies the condition multiplier', () => {
    expect(remainingLifeYears(11, 5, 'poor')).toBe(3);
    expect(remainingLifeYears(11, 5, 'critical')).toBe(1);
    expect(remainingLifeYears(11, null, 'good')).toBeNull();
  });
});

describe('reconcileFindings (property memory over time)', () => {
  it('creates a new finding with an event', () => {
    const r = reconcileFindings([], [finding()], {}, NOW);
    expect(r.inserts).toHaveLength(1);
    expect(r.events[0].event_type).toBe('finding_new');
  });
  it('recognises the same issue, counts it and flags a worsening', () => {
    const r = reconcileFindings([existing()], [finding({ severity: 'high' })], {}, NOW);
    expect(r.inserts).toHaveLength(0);
    expect(r.updates[0].patch.times_observed).toBe(3);
    expect(r.events.some((e) => e.event_type === 'finding_worsened')).toBe(true);
  });
  it('matches an earlier locus-less finding instead of duplicating it', () => {
    const r = reconcileFindings([existing({ locus: '' })], [finding()], {}, NOW);
    expect(r.inserts).toHaveLength(0);
  });
  it('absence alone never resolves anything; only an explicit "no longer visible" flags it for a human', () => {
    expect(reconcileFindings([existing()], [], {}, NOW).updates).toHaveLength(0);
    const r = reconcileFindings([existing()], [], { f1: 'no_longer_visible' }, NOW);
    expect(r.updates[0].patch.status).toBe('not_reobserved');
    expect(r.events[0].event_type).toBe('finding_not_reobserved');
    expect(reconcileFindings([existing()], [], { f1: 'not_in_frame' }, NOW).updates).toHaveLength(0);
  });
  it('respects a dismissed finding and reopens a not_reobserved one', () => {
    const d = reconcileFindings([existing({ status: 'dismissed' })], [finding()], {}, NOW);
    expect(d.updates[0].patch.status).toBeUndefined();
    const r = reconcileFindings([existing({ status: 'not_reobserved' })], [finding()], {}, NOW);
    expect(r.updates[0].patch.status).toBe('open');
    expect(r.events.some((e) => e.event_type === 'finding_reopened')).toBe(true);
  });
  it('notifies only for high/emergency safety events', () => {
    const r = reconcileFindings([], [finding(), finding({ code: 'wear', type: 'condition_indicator', severity: 'high', locus: 'x' })], {}, NOW);
    expect(notifiableEvents(r.events)).toHaveLength(1);
  });
});

describe('buildMemoryContext', () => {
  it('assigns stable refs and lists only open findings', () => {
    const a = known();
    const ctx = buildMemoryContext([a], new Map([['asset-1', [
      { id: 'f1', finding_type: 'hazard', code: 'active_leak', locus: 'inlet', severity: 'high', status: 'open', first_seen_at: '2026-03-01T00:00:00Z', times_observed: 2 },
      { id: 'f2', finding_type: 'hazard', code: 'mold_growth', locus: '', severity: 'low', status: 'resolved', first_seen_at: '2026-01-01T00:00:00Z', times_observed: 1 },
    ]]]));
    expect(ctx.assetByRef.get('A1')).toBe('asset-1');
    expect(ctx.findingByRef.get('A1.F1')).toBe('f1');
    expect(ctx.findingByRef.size).toBe(1);
    expect(ctx.text).toContain('active_leak @ inlet');
  });
});
