import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase', () => ({ supabase: { rpc } }));

import { fetchMyEntitlements, listAccountEntitlements, listEntitlementAudit, setEntitlement } from './entitlementsApi';

const payload = { module_id: 'pay', state: 'on', source: 'manual', expires_at: null, reason: 'Pilot agreement' } as const;

beforeEach(() => rpc.mockReset());

describe('entitlementsApi', () => {
  it('fetchMyEntitlements makes ONE rpc call and returns every row', async () => {
    rpc.mockResolvedValue({ data: [{ module_id: 'core' }, { module_id: 'pay' }], error: null });
    expect(await fetchMyEntitlements()).toHaveLength(2);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('get_my_entitlements');
  });

  it('fetchMyEntitlements treats null data as empty and hides database errors', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await fetchMyEntitlements()).toEqual([]);
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'relation x does not exist', code: 'XX000' } });
    await expect(fetchMyEntitlements()).rejects.toThrow('Could not load your modules.');
  });

  it('setEntitlement sends the exact staff RPC arguments', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await setEntitlement('t1', payload);
    expect(rpc).toHaveBeenCalledWith('staff_set_entitlement', {
      p_tenant: 't1', p_module: 'pay', p_state: 'on', p_source: 'manual', p_expires_at: null, p_reason: 'Pilot agreement',
    });
  });

  it('maps permission and validation errors to safe messages', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'Staff only' } });
    await expect(setEntitlement('t1', payload)).rejects.toThrow('Staff access is required for this action.');
    rpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'A reason of 5 to 300 characters is required' } });
    await expect(setEntitlement('t1', payload)).rejects.toThrow('A reason of 5 to 300 characters is required');
    rpc.mockResolvedValueOnce({ data: null, error: { code: '57014', message: 'internal detail' } });
    await expect(setEntitlement('t1', payload)).rejects.toThrow('Could not save the change.');
  });

  it('listEntitlementAudit coerces bigint ids to numbers', async () => {
    rpc.mockResolvedValue({ data: [{ id: '12', module_id: 'pay', action: 'grant' }], error: null });
    const rows = await listEntitlementAudit('t1');
    expect(rows[0].id).toBe(12);
    expect(rpc).toHaveBeenCalledWith('staff_list_entitlement_audit', { p_tenant: 't1', p_limit: 50 });
  });

  it('listAccountEntitlements surfaces staff-only errors', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'Staff only' } });
    await expect(listAccountEntitlements('t1')).rejects.toThrow('Staff access is required for this action.');
  });
});
