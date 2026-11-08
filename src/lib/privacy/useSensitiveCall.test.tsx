import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const readCallSensitive = vi.fn();
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
vi.mock('@/lib/privacy/accessLog', async (orig) => ({ ...(await orig<typeof import('@/lib/privacy/accessLog')>()), readCallSensitive: (...a: unknown[]) => readCallSensitive(...a) }));

import { useSensitiveCall } from './useSensitiveCall';
import { AccessLogError } from '@/lib/privacy/accessLog';

beforeEach(() => {
  readCallSensitive.mockReset();
});

describe('useSensitiveCall', () => {
  it('loads recording + transcript once per call id', async () => {
    readCallSensitive.mockResolvedValue({ recordingUrl: 'https://r/1', transcript: 'hi' });
    const { result, rerender } = renderHook(({ id }) => useSensitiveCall(id), { initialProps: { id: 'a' } });
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current).toMatchObject({ recordingUrl: 'https://r/1', transcript: 'hi' });
    rerender({ id: 'a' });
    expect(readCallSensitive).toHaveBeenCalledTimes(1);
    rerender({ id: 'b' });
    await waitFor(() => expect(readCallSensitive).toHaveBeenCalledTimes(2));
  });
  it('exposes a typed error and never leaks stale content', async () => {
    readCallSensitive.mockRejectedValue(new AccessLogError('rate_limited'));
    const { result } = renderHook(() => useSensitiveCall('x'));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current).toMatchObject({ kind: 'rate_limited', recordingUrl: null, transcript: null });
  });
});
