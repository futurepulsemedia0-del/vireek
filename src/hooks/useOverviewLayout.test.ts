import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';

const fetchMock = vi.fn();
const saveMock = vi.fn();
const deleteMock = vi.fn();
vi.mock('@/lib/overviewLayoutApi', () => ({
  fetchOverviewLayout: (...a: unknown[]) => fetchMock(...a),
  saveOverviewLayout: (...a: unknown[]) => saveMock(...a),
  deleteOverviewLayout: (...a: unknown[]) => deleteMock(...a),
}));

import { useOverviewLayout } from './useOverviewLayout';
import { buildPresetLayout } from '@/lib/overviewLayout';

const opts = { userId: 'u1', defaultPreset: 'owner' as const, can: () => true };

beforeEach(() => {
  vi.clearAllMocks();
  saveMock.mockResolvedValue(undefined);
  deleteMock.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useOverviewLayout', () => {
  it('uses the role preset when nothing is saved', async () => {
    fetchMock.mockResolvedValue(null);
    const { result } = renderHook(() => useOverviewLayout(opts));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.layout).toEqual(buildPresetLayout('owner'));
  });

  it('loads and sanitizes a saved layout', async () => {
    const saved = { ...buildPresetLayout('csr'), preset: 'custom' };
    fetchMock.mockResolvedValue(saved);
    const { result } = renderHook(() => useOverviewLayout(opts));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.layout.preset).toBe('custom');
    expect(result.current.layout.items[0].id).toBe(saved.items[0].id);
  });

  it('falls back to the preset and flags loadFailed when the read fails', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useOverviewLayout(opts));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.loadFailed).toBe(true);
    expect(result.current.layout).toEqual(buildPresetLayout('owner'));
  });

  it('debounces rapid edits into one save of the latest layout', async () => {
    fetchMock.mockResolvedValue(null);
    const { result } = renderHook(() => useOverviewLayout(opts));
    await waitFor(() => expect(result.current.ready).toBe(true));
    vi.useFakeTimers();
    act(() => {
      result.current.hide('kpi_calls');
      result.current.hide('kpi_jobs');
      result.current.resize('call_volume', { w: 8 });
    });
    expect(saveMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(saveMock).toHaveBeenCalledTimes(1);
    const saved = saveMock.mock.calls[0][1];
    expect(saved.preset).toBe('custom');
    expect(saved.items.filter((i: { hidden: boolean }) => i.hidden).map((i: { id: string }) => i.id)).toEqual(
      expect.arrayContaining(['kpi_calls', 'kpi_jobs']),
    );
  });

  it('flush saves immediately', async () => {
    fetchMock.mockResolvedValue(null);
    const { result } = renderHook(() => useOverviewLayout(opts));
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.hide('kpi_calls'));
    await act(async () => {
      await result.current.flush();
    });
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(result.current.saveState).toBe('saved');
  });

  it('reports a save error and retries on flush', async () => {
    fetchMock.mockResolvedValue(null);
    saveMock.mockRejectedValueOnce(new Error('x'));
    const { result } = renderHook(() => useOverviewLayout(opts));
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.hide('kpi_calls'));
    await act(async () => {
      await result.current.flush();
    });
    expect(result.current.saveState).toBe('error');
    await act(async () => {
      await result.current.flush();
    });
    expect(saveMock).toHaveBeenCalledTimes(2);
    expect(result.current.saveState).toBe('saved');
  });

  it('reset deletes the stored row, restores the preset and cancels pending saves', async () => {
    fetchMock.mockResolvedValue(null);
    const { result } = renderHook(() => useOverviewLayout(opts));
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.hide('kpi_calls'));
    await act(async () => {
      await result.current.reset();
    });
    expect(deleteMock).toHaveBeenCalledWith('u1');
    expect(result.current.layout).toEqual(buildPresetLayout('owner'));
    await act(async () => {
      await result.current.flush();
    });
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('does nothing until a user id is known', () => {
    const { result } = renderHook(() => useOverviewLayout({ ...opts, userId: undefined }));
    expect(result.current.ready).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
