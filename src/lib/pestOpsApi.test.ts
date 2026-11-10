import { describe, it, expect, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase', () => ({ supabase: { rpc, from: vi.fn() } }));

import { adjustStock, fetchPestOpsEnabled, friendlyPestOpsError, registerCallback } from './pestOpsApi';

describe('friendlyPestOpsError', () => {
  it('maps database error codes to plain language', () => {
    expect(friendlyPestOpsError(new Error('pest_ops_not_enabled'))).toContain('not enabled');
    expect(friendlyPestOpsError(new Error('no_service_record: log the original treatment before registering a callback'))).toContain('Log the original treatment');
    expect(friendlyPestOpsError({ message: 'plan_exists: x' })).toContain('already has a pest plan');
  });
  it('passes through the detail after the code for coded messages without a fixed text', () => {
    expect(friendlyPestOpsError(new Error('invalid_term: the term must start on/after the agreement start'))).toBe('the term must start on/after the agreement start');
  });
  it('falls back for unknown or empty errors and never leaks raw SQL', () => {
    expect(friendlyPestOpsError(new Error('relation "x" does not exist'), 'Nope')).toBe('Nope');
    expect(friendlyPestOpsError(undefined, 'Nope')).toBe('Nope');
  });
});

describe('fetchPestOpsEnabled', () => {
  it('fails closed on error', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    expect(await fetchPestOpsEnabled()).toBe(false);
  });
  it('is true only for an explicit true', async () => {
    rpc.mockResolvedValueOnce({ data: true, error: null });
    expect(await fetchPestOpsEnabled()).toBe(true);
    rpc.mockResolvedValueOnce({ data: 'true', error: null });
    expect(await fetchPestOpsEnabled()).toBe(false);
  });
});

describe('rpc wiring', () => {
  it('adjustStock sends a fresh idempotency key per action', async () => {
    rpc.mockResolvedValue({ data: { applied: true }, error: null });
    await adjustStock({ productId: 'p', kind: 'receipt', quantity: 1, unit: 'gal' });
    await adjustStock({ productId: 'p', kind: 'receipt', quantity: 1, unit: 'gal' });
    const keys = rpc.mock.calls.filter((c) => c[0] === 'pest_stock_adjust').map((c) => c[1].p_idempotency_key as string);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0].length).toBeGreaterThanOrEqual(8);
  });
  it('registerCallback trims the override and sends null when empty', async () => {
    rpc.mockResolvedValue({ data: { id: 'c', outcome: 'covered', billable: false, covered_until: '2027-01-01', existing: false }, error: null });
    await registerCallback({ originalJobId: 'a', callbackJobId: 'b', requestedOn: '2027-01-02', targets: ['Ants'], timeZone: 'UTC', overrideReason: '   ' });
    expect(rpc.mock.calls.at(-1)?.[1].p_override_reason).toBeNull();
  });
  it('propagates RPC errors', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: new Error('not_permitted') });
    await expect(registerCallback({ originalJobId: 'a', callbackJobId: 'b', requestedOn: '2027-01-02', targets: ['Ants'], timeZone: 'UTC' })).rejects.toThrow();
  });
});
