import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { LiveCall, ScreenPopData } from '@/lib/csrScreenPop';
import { EMPTY_BALANCE } from '@/lib/csrScreenPop';

type Handler = (p: unknown) => void;
let handler: Handler = () => {};
let status: 'connecting' | 'live' | 'reconnecting' = 'live';

vi.mock('@/lib/realtime', () => ({
  useRealtimeSubscription: (cfg: { onChange: Handler }) => {
    handler = cfg.onChange;
    return status;
  },
}));

const fetchLiveCalls = vi.fn();
const fetchScreenPop = vi.fn();
vi.mock('@/lib/csrScreenPopApi', () => ({
  fetchLiveCalls: (...a: unknown[]) => fetchLiveCalls(...a),
  fetchScreenPop: (...a: unknown[]) => fetchScreenPop(...a),
}));

import { useCsrScreenPop } from './useCsrScreenPop';

const row = (over: Partial<LiveCall> = {}): LiveCall => ({
  id: 'c1', caller_phone: '+15550102030', caller_name: null, call_datetime: new Date().toISOString(),
  duration_seconds: null, is_emergency: false, is_voicemail: false, human_transfer_requested: false,
  status: 'new_lead', sentiment: null, summary: null, intent: null, ...over,
});

const pop = (name = 'Maria'): ScreenPopData => ({
  matched: true,
  customer: { id: 'cu', name, phone: null, email: null, address: null, customer_type: 'residential', lifecycle_stage: 'active', tags: [], notes: null },
  open_jobs: [], recent_jobs: [], equipment: [], balance: { ...EMPTY_BALANCE }, open_quotes: [],
  last_conversation: null, memory: [], history: { total_calls: 0, last_call_at: null },
});

beforeEach(() => {
  status = 'live';
  fetchLiveCalls.mockReset();
  fetchScreenPop.mockReset();
  fetchLiveCalls.mockResolvedValue([]);
  fetchScreenPop.mockResolvedValue(pop());
});

describe('useCsrScreenPop', () => {
  it('auto-selects and loads the pop for an already-live call on mount', async () => {
    fetchLiveCalls.mockResolvedValue([row()]);
    const { result } = renderHook(() => useCsrScreenPop('owner-1'));
    await waitFor(() => expect(result.current.data?.customer?.name).toBe('Maria'));
    expect(result.current.selectedId).toBe('c1');
    expect(fetchScreenPop).toHaveBeenCalledWith('c1');
  });

  it('pops a brand-new realtime call when the desk is idle', async () => {
    const { result } = renderHook(() => useCsrScreenPop('owner-1'));
    await waitFor(() => expect(result.current.queueLoading).toBe(false));
    act(() => handler({ eventType: 'INSERT', new: row({ id: 'c9' }), old: {} }));
    await waitFor(() => expect(result.current.selectedId).toBe('c9'));
    expect(result.current.calls).toHaveLength(1);
  });

  it('does not steal focus from an open call — flags the incoming one instead', async () => {
    fetchLiveCalls.mockResolvedValue([row()]);
    const { result } = renderHook(() => useCsrScreenPop('owner-1'));
    await waitFor(() => expect(result.current.selectedId).toBe('c1'));
    act(() => handler({ eventType: 'INSERT', new: row({ id: 'c2' }), old: {} }));
    expect(result.current.selectedId).toBe('c1');
    expect(result.current.incomingId).toBe('c2');
    expect(result.current.calls.map((c) => c.id).sort()).toEqual(['c1', 'c2']);
  });

  it('marks a call ended (kept for wrap-up) when its duration arrives', async () => {
    fetchLiveCalls.mockResolvedValue([row()]);
    const { result } = renderHook(() => useCsrScreenPop('owner-1'));
    await waitFor(() => expect(result.current.selectedId).toBe('c1'));
    act(() => handler({ eventType: 'UPDATE', new: row({ duration_seconds: 90 }), old: { id: 'c1' } }));
    expect(result.current.calls[0].ended).toBe(true);
    expect(result.current.selectedCall?.ended).toBe(true);
  });

  it('re-runs the lookup when the caller is identified mid-call', async () => {
    fetchLiveCalls.mockResolvedValue([row()]);
    const { result } = renderHook(() => useCsrScreenPop('owner-1'));
    await waitFor(() => expect(result.current.data).not.toBeNull());
    fetchScreenPop.mockResolvedValue(pop('Maria Lopez'));
    act(() => handler({ eventType: 'UPDATE', new: row({ caller_name: 'Maria Lopez' }), old: { id: 'c1' } }));
    await waitFor(() => expect(result.current.data?.customer?.name).toBe('Maria Lopez'));
  });

  it('surfaces a lookup failure and recovers on retry', async () => {
    fetchLiveCalls.mockResolvedValue([row()]);
    fetchScreenPop.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useCsrScreenPop('owner-1'));
    await waitFor(() => expect(result.current.popError).toBe('boom'));
    act(() => result.current.retryPop());
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.popError).toBeNull();
  });

  it('reports queue load errors', async () => {
    fetchLiveCalls.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useCsrScreenPop('owner-1'));
    await waitFor(() => expect(result.current.queueError).toBe('offline'));
    expect(result.current.queueLoading).toBe(false);
  });

  it('does nothing without an account id', () => {
    renderHook(() => useCsrScreenPop(undefined));
    expect(fetchLiveCalls).not.toHaveBeenCalled();
  });
});
