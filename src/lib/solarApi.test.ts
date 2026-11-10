import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase', () => ({ supabase: { rpc } }));
vi.mock('@/lib/customFieldsApi', () => ({ useAccountOwnerId: () => undefined }));

import { friendlySolarError, parseSerials, setClaimStatus, setStageStatus, unitPayload, type UnitInput } from './solarApi';
import { installPack, updatePack } from './tradePacksApi';
import { SOLAR_PACK, clearSolarFinancingHooks, registerSolarFinancingHook, type SolarFinancingEvent } from './tradePacks';

beforeEach(() => {
  rpc.mockReset();
  clearSolarFinancingHooks();
});

describe('friendlySolarError', () => {
  it('keeps the rule message and maps known codes', () => {
    expect(friendlySolarError(new Error('solar_stage_blocked: earlier stages must be approved or skipped first'))).toBe('earlier stages must be approved or skipped first');
    expect(friendlySolarError({ message: 'solar_duplicate_serial: a serial number is already registered on another active unit' })).toContain('already registered');
    expect(friendlySolarError(new Error('solar_module_not_available: x'))).toBe('The Solar module is not enabled for this account.');
    expect(friendlySolarError(new Error('boom'), 'Nope')).toBe('Nope');
    expect(friendlySolarError(null, 'Nope')).toBe('Nope');
  });
});

describe('unit payload', () => {
  const base: UnitInput = { component_kind: 'panel', make: ' Acme ', model: '', quantity: '24', serials: 'A1, A2\nA3;;', installed_on: '', warranty_start: '2030-01-01', product_warranty_years: '12', performance_warranty_years: '', warranty_expires_override: '', warranty_terms: '' };
  it('parses serials, trims, nulls blanks', () => {
    expect(parseSerials('A1, A2\nA3;; ')).toEqual(['A1', 'A2', 'A3']);
    expect(unitPayload(base)).toMatchObject({ make: 'Acme', model: null, quantity: 24, serials: ['A1', 'A2', 'A3'], product_warranty_years: 12, performance_warranty_years: null, installed_on: null });
  });
  it('rejects non-integer years instead of sending them', () => {
    expect(unitPayload({ ...base, product_warranty_years: '1.5' }).product_warranty_years).toBeNull();
  });
});

describe('status RPCs', () => {
  const stage = { id: 's1', project_id: 'p1', stage_key: 'permit' as const, status: 'submitted' as const };
  it('stage move calls the RPC with trimmed args and notifies financing hooks', async () => {
    rpc.mockResolvedValue({ data: {}, error: null });
    const seen: SolarFinancingEvent[] = [];
    registerSolarFinancingHook({ id: 't', onEvent: (e) => { seen.push(e); } });
    await setStageStatus(stage, 'approved', '  ok  ', ' PRM-1 ');
    expect(rpc).toHaveBeenCalledWith('solar_set_stage_status', { p_stage_id: 's1', p_to: 'approved', p_note: 'ok', p_reference: 'PRM-1' });
    await Promise.resolve();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'stage_changed', stageKey: 'permit', from: 'submitted', to: 'approved' });
  });
  it('a database rejection throws and does NOT notify financing', async () => {
    rpc.mockResolvedValue({ data: null, error: new Error('solar_stage_invalid: nope') });
    const seen: unknown[] = [];
    registerSolarFinancingHook({ id: 't', onEvent: (e) => { seen.push(e); } });
    await expect(setStageStatus(stage, 'approved')).rejects.toThrow('solar_stage_invalid');
    expect(seen).toEqual([]);
  });
  it('a failing financing hook never fails the stage move', async () => {
    rpc.mockResolvedValue({ data: {}, error: null });
    registerSolarFinancingHook({ id: 'bad', onEvent: () => { throw new Error('lender down'); } });
    await expect(setStageStatus(stage, 'approved')).resolves.toBeUndefined();
  });
  it('claim move passes resolution and reference', async () => {
    rpc.mockResolvedValue({ data: {}, error: null });
    await setClaimStatus('c1', 'resolved', { resolution: 'replace', reference: 'RMA-9' });
    expect(rpc).toHaveBeenCalledWith('solar_set_claim_status', { p_claim_id: 'c1', p_to: 'resolved', p_note: null, p_resolution: 'replace', p_reference: 'RMA-9' });
  });
});

describe('pack install / rollback', () => {
  it('install seeds prefixed fields + forms through install_trade_pack', async () => {
    rpc.mockResolvedValue({ data: { fields_added: 7, fields_skipped: 0, forms_added: 5 }, error: null });
    const r = await installPack(SOLAR_PACK);
    expect(r).toEqual({ fields_added: 7, fields_skipped: 0, forms_added: 5 });
    const [fn, args] = rpc.mock.calls[0];
    expect(fn).toBe('install_trade_pack');
    expect(args.p_pack).toBe('solar');
    expect(args.p_fields).toHaveLength(SOLAR_PACK.customFields.length);
    expect(args.p_fields.every((f: { key: string }) => f.key.startsWith('solar_'))).toBe(true);
    expect(args.p_forms.map((f: { slug: string }) => f.slug)).toEqual(SOLAR_PACK.forms.map((f) => f.slug));
  });
  it('install is refused (not silently ignored) when the module is not entitled', async () => {
    rpc.mockResolvedValue({ data: null, error: new Error('solar_module_not_available: the Solar pack is not enabled for this account') });
    await expect(installPack(SOLAR_PACK)).rejects.toThrow('solar_module_not_available');
  });
  it('rollback = turn the pack off via update_trade_pack; no destructive call', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await updatePack('solar', { enabled: false });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('update_trade_pack', { p_pack: 'solar', p_enabled: false, p_enforce_credentials: null, p_config: null });
  });
});
