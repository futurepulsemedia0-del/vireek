import { describe, it, expect, vi } from 'vitest';
import { recordMeasurement, assetGate, idempotencyKey, type Db } from '../../supabase/functions/_shared/asset-reality/service';
import { normalizeMeasurement } from '../../supabase/functions/_shared/asset-reality/measurement';

const NOW = new Date('2026-11-07T12:00:00Z');
const AT = '2026-11-07T11:59:00Z';
type Call = { fn: string; args: Record<string, unknown> };

function fakeDb(o: { facts?: unknown[]; state?: unknown; flags?: unknown; rpcError?: string } = {}) {
  const calls: Call[] = [];
  const chain = (data: unknown) => { const c: any = { select: () => c, eq: () => c, maybeSingle: async () => ({ data, error: null }), then: (r: any) => r({ data, error: null }) }; return c; };
  const db: Db = {
    rpc: async (fn, args) => { calls.push({ fn, args }); return o.rpcError && fn === 'asset_measurement_record' ? { data: null, error: { message: 'x', code: o.rpcError } } : { data: fn === 'asset_measurement_record' ? 'm-1' : fn === 'truth_write_claim' ? 'c-1' : null, error: null }; },
    from: (t: string) => chain(t === 'truth_facts' ? o.facts ?? [] : t === 'asset_state' ? o.state ?? null : t === 'asset_reality_flags' ? o.flags ?? null : null),
  };
  return { db, calls };
}

describe('recordMeasurement', () => {
  it('normalizes, stores, writes an Operational Truth claim and refreshes state', async () => {
    const { db, calls } = fakeDb();
    const r = await recordMeasurement(db, 'u1', { kind: 'superheat', value: 14.4, unit: 'dF', measured_at: AT, method: 'instrument', instrument: { id: 'g1', calibrated_on: '2026-06-01' }, equipment_id: 'e1' }, 'job_form', NOW);
    expect(r).toEqual({ ok: true, measurement_id: 'm-1', claim_id: 'c-1' });
    expect(calls.map((c) => c.fn)).toEqual(['asset_measurement_record', 'truth_write_claim', 'asset_state_upsert']);
    expect((calls[0].args.p_row as any).value).toBeCloseTo(8, 6);
    expect(calls[1].args).toMatchObject({ p_predicate: 'asset.vital.superheat', p_source_key: 'instrument_bluetooth', p_subject_type: 'asset' });
  });
  it('rejects invalid input before touching the database', async () => {
    const { db, calls } = fakeDb();
    expect(await recordMeasurement(db, 'u1', { kind: 'zone_temp', value: 900, measured_at: AT, method: 'sensor', equipment_id: 'e1' }, 'telemetry', NOW)).toEqual({ ok: false, reason: 'out_of_physical_range' });
    expect(calls).toHaveLength(0);
  });
  it('unconfirmed OCR is stored but makes NO claim', async () => {
    const { db, calls } = fakeDb();
    const r = await recordMeasurement(db, 'u1', { kind: 'compressor_current', value: 15, measured_at: AT, method: 'ocr', equipment_id: 'e1' }, 'nameplate', NOW);
    expect(r).toMatchObject({ ok: true, claim_id: null });
    expect(calls.some((c) => c.fn === 'truth_write_claim')).toBe(false);
  });
  it('maps cross-tenant rejection to forbidden', async () => {
    const { db } = fakeDb({ rpcError: '42501' });
    expect(await recordMeasurement(db, 'u1', { kind: 'zone_temp', value: 20, measured_at: AT, method: 'sensor', equipment_id: 'eX' }, 'telemetry', NOW)).toEqual({ ok: false, reason: 'forbidden' });
  });
  it('replayed reading yields the same idempotency key; different instrument differs', async () => {
    const m = (id: string) => { const n = normalizeMeasurement({ kind: 'zone_temp', value: 20, measured_at: AT, method: 'sensor', instrument: { id } }, NOW); if (!n.ok) throw new Error(); return n.measurement; };
    expect(await idempotencyKey('e1', m('a'), 'telemetry')).toBe(await idempotencyKey('e1', m('a'), 'telemetry'));
    expect(await idempotencyKey('e1', m('a'), 'telemetry')).not.toBe(await idempotencyKey('e1', m('b'), 'telemetry'));
  });
});

describe('assetGate', () => {
  const okState = { status: 'ok', winning_claim_id: 'c9', conflict_claim_ids: [], safety_eligible: true, confidence: 0.9 };
  it('SHADOW (default): never changes behavior, but logs what would be blocked with claim ids', async () => {
    const { db, calls } = fakeDb({ state: { ...okState, status: 'conflict', conflict_claim_ids: ['a', 'b'] } });
    const d = await assetGate(db, 'u1', 'dispatch', 'e1', 'refrigerant_charge_kg');
    expect(d).toMatchObject({ allow: true, shadow: true, would_change_behavior: true, claim_ids: ['a', 'b'] });
    expect(calls.find((c) => c.fn === 'asset_decision_log_write')!.args).toMatchObject({ p_shadow: true, p_would_change: true, p_claim_ids: ['a', 'b'] });
  });
  it('ENFORCE: blocks unknown, conflict and low-confidence; fails closed when state unreadable', async () => {
    const enf = { shadow: false, enforce: true };
    expect((await assetGate(fakeDb({ flags: enf }).db, 'u1', 'voice', 'e1', 'superheat')).allow).toBe(false); // unknown (no row)
    expect((await assetGate(fakeDb({ flags: enf, state: { ...okState, status: 'conflict' } }).db, 'u1', 'voice', 'e1', 'superheat')).allow).toBe(false);
    expect((await assetGate(fakeDb({ flags: enf, state: { ...okState, confidence: 0.5 } }).db, 'u1', 'voice', 'e1', 'superheat')).allow).toBe(false);
    expect((await assetGate(fakeDb({ flags: enf, state: okState }).db, 'u1', 'voice', 'e1', 'superheat')).allow).toBe(true);
  });
  it('ENFORCE + safetyCritical requires safety_eligible', async () => {
    const enf = { shadow: false, enforce: true };
    expect((await assetGate(fakeDb({ flags: enf, state: { ...okState, safety_eligible: false } }).db, 'u1', 'quote', 'e1', 'rated_amps', { safetyCritical: true })).allow).toBe(false);
  });
});
