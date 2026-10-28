import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';

const fetchOwnMock = vi.fn();
const saveMock = vi.fn();
const deleteMock = vi.fn();
const fetchRoleMock = vi.fn();
vi.mock('@/lib/overviewLayoutApi', () => ({
  fetchOverviewLayout: (...a: unknown[]) => fetchOwnMock(...a),
  saveOverviewLayout: (...a: unknown[]) => saveMock(...a),
  deleteOverviewLayout: (...a: unknown[]) => deleteMock(...a),
}));
vi.mock('@/lib/dashboardRoleLayoutsApi', () => ({
  fetchRoleLayout: (...a: unknown[]) => fetchRoleMock(...a),
}));

import { useOverviewLayout } from './useOverviewLayout';
import { buildPresetLayout, setWidgetHidden } from '@/lib/overviewLayout';
import { resolveBaseLayout } from '@/lib/dashboardRoleLayouts';

const opts = { userId: 'u1', defaultPreset: 'owner' as const, accountOwnerId: 'acct-1', can: () => true };
const accountLayout = setWidgetHidden(buildPresetLayout('owner'), 'ai_insights', true);
const ownLayout = setWidgetHidden(buildPresetLayout('owner'), 'attribution', true);

beforeEach(() => {
  vi.clearAllMocks();
  saveMock.mockResolvedValue(undefined);
  deleteMock.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useOverviewLayout with an account role layout', () => {
  it('starts from the layout the account published for the role', async () => {
    fetchOwnMock.mockResolvedValue(null);
    fetchRoleMock.mockResolvedValue(accountLayout);
    const { result } = renderHook(() => useOverviewLayout(opts));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(fetchRoleMock).toHaveBeenCalledWith('acct-1', 'owner');
    expect(result.current.layout.items.find((i) => i.id === 'ai_insights')?.hidden).toBe(true);
    expect(result.current.loadFailed).toBe(false);
  });

  it("keeps the person's own layout over the account layout", async () => {
    fetchOwnMock.mockResolvedValue(ownLayout);
    fetchRoleMock.mockResolvedValue(accountLayout);
    const { result } = renderHook(() => useOverviewLayout(opts));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.layout.items.find((i) => i.id === 'attribution')?.hidden).toBe(true);
    expect(result.current.layout.items.find((i) => i.id === 'ai_insights')?.hidden).toBe(false);
  });

  it('falls back to the built-in preset when the account layout cannot be read', async () => {
    fetchOwnMock.mockResolvedValue(null);
    fetchRoleMock.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useOverviewLayout(opts));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.layout).toEqual(buildPresetLayout('owner'));
    expect(result.current.loadFailed).toBe(false);
  });

  it('still shows the account layout when only the personal read fails', async () => {
    fetchOwnMock.mockRejectedValue(new Error('offline'));
    fetchRoleMock.mockResolvedValue(accountLayout);
    const { result } = renderHook(() => useOverviewLayout(opts));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.loadFailed).toBe(true);
    expect(result.current.layout).toEqual(resolveBaseLayout(accountLayout, 'owner'));
  });

  it('does not look up an account layout without an account id', async () => {
    fetchOwnMock.mockResolvedValue(null);
    const { result } = renderHook(() => useOverviewLayout({ ...opts, accountOwnerId: undefined }));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(fetchRoleMock).not.toHaveBeenCalled();
    expect(result.current.layout).toEqual(buildPresetLayout('owner'));
  });

  it('"reset" returns to the account layout, not the built-in preset', async () => {
    fetchOwnMock.mockResolvedValue(ownLayout);
    fetchRoleMock.mockResolvedValue(accountLayout);
    const { result } = renderHook(() => useOverviewLayout(opts));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => {
      await result.current.reset();
    });
    expect(deleteMock).toHaveBeenCalledWith('u1');
    expect(result.current.layout).toEqual(resolveBaseLayout(accountLayout, 'owner'));
  });
});
