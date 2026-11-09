import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ user: null as { id: string } | null }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: auth.user }) }));
const api = vi.hoisted(() => ({ fetchMyEntitlements: vi.fn() }));
vi.mock('@/lib/entitlementsApi', () => api);

const row = (module_id: string, over: Record<string, unknown> = {}) => ({ module_id, state: 'on', source: 'plan', expires_at: null, active: true, ...over });

// The hook keeps one app-wide store, so every test gets a fresh module instance.
async function load() {
  vi.resetModules();
  return import('./useEntitlement');
}

beforeEach(() => { auth.user = null; api.fetchMyEntitlements.mockReset(); });
afterEach(() => cleanup());

describe('useEntitlement', () => {
  it('denies and never fetches while signed out', () => {
    return load().then(({ useEntitlement }) => {
      const { result } = renderHook(() => useEntitlement('core'));
      expect(result.current.allowed).toBe(false);
      expect(api.fetchMyEntitlements).not.toHaveBeenCalled();
    });
  });

  it('is denied (loading) first, then allowed once rows arrive', async () => {
    auth.user = { id: 'u1' };
    api.fetchMyEntitlements.mockResolvedValue([row('core'), row('pay', { state: 'trial', expires_at: new Date(Date.now() + 3 * 86_400_000).toISOString() })]);
    const { useEntitlement } = await load();
    const { result } = renderHook(() => ({ core: useEntitlement('core'), pay: useEntitlement('pay'), ai: useEntitlement('ai') }));
    expect(result.current.core).toMatchObject({ allowed: false, status: 'loading' });
    await waitFor(() => expect(result.current.core.allowed).toBe(true));
    expect(result.current.pay).toMatchObject({ allowed: true, state: 'trial' });
    expect(result.current.ai.allowed).toBe(false); // no row = default deny
  });

  it('uses ONE request for many hooks and modules (no N+1)', async () => {
    auth.user = { id: 'u1' };
    api.fetchMyEntitlements.mockResolvedValue([row('core'), row('pay')]);
    const { useEntitlement, useEntitlements } = await load();
    const { result } = renderHook(() => ({ a: useEntitlement('core'), b: useEntitlement('pay'), c: useEntitlements() }));
    await waitFor(() => expect(result.current.c.ready).toBe(true));
    expect(result.current.c.has('pay')).toBe(true);
    expect(result.current.c.has('finance')).toBe(false);
    expect(api.fetchMyEntitlements).toHaveBeenCalledTimes(1);
  });

  it('stays denied and reports an error when the first load fails', async () => {
    auth.user = { id: 'u1' };
    api.fetchMyEntitlements.mockRejectedValue(new Error('boom'));
    const { useEntitlement } = await load();
    const { result } = renderHook(() => useEntitlement('core'));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.allowed).toBe(false);
  });

  it('denies an expired grant even though the server said active', async () => {
    auth.user = { id: 'u1' };
    api.fetchMyEntitlements.mockResolvedValue([row('pay', { expires_at: new Date(Date.now() - 1000).toISOString() })]);
    const { useEntitlement } = await load();
    const { result } = renderHook(() => useEntitlement('pay'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current).toMatchObject({ allowed: false, expired: true });
  });

  it('refreshEntitlements forces a refetch and picks up a new grant', async () => {
    auth.user = { id: 'u1' };
    api.fetchMyEntitlements.mockResolvedValueOnce([row('core')]).mockResolvedValueOnce([row('core'), row('pay')]);
    const { useEntitlement, refreshEntitlements } = await load();
    const { result } = renderHook(() => useEntitlement('pay'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.allowed).toBe(false);
    await act(async () => { await refreshEntitlements(); });
    expect(result.current.allowed).toBe(true);
    expect(api.fetchMyEntitlements).toHaveBeenCalledTimes(2);
  });
});
