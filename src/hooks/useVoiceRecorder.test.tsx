import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useVoiceRecorder } from '@/hooks/useVoiceRecorder';

vi.mock('@/lib/jobMessages', () => ({
  MAX_VOICE_SECONDS: 2,
  pickRecorderMime: (ok: (t: string) => boolean) => (ok('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : null),
}));

class FakeRecorder {
  static throwOnCreate = false;
  static isTypeSupported = () => true;
  state: 'inactive' | 'recording' = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    if (FakeRecorder.throwOnCreate) throw new Error('boom');
  }
  start() {
    this.state = 'recording';
    this.ondataavailable?.({ data: new Blob(['audio-bytes']) });
  }
  stop() {
    this.state = 'inactive';
    this.onstop?.();
  }
}

const track = () => ({ stop: vi.fn() });
let tracks: ReturnType<typeof track>[];
let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  tracks = [track()];
  getUserMedia = vi.fn(async () => ({ getTracks: () => tracks }));
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  FakeRecorder.throwOnCreate = false;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useVoiceRecorder', () => {
  it('records, stops and delivers a clip with a normalised mime, releasing the mic', async () => {
    const onClip = vi.fn();
    const { result } = renderHook(() => useVoiceRecorder(onClip));
    await act(async () => void (await result.current.start()));
    expect(result.current.state).toBe('recording');
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    act(() => result.current.stop());
    expect(onClip).toHaveBeenCalledTimes(1);
    expect(onClip.mock.calls[0][0]).toMatchObject({ mime: 'audio/webm' });
    expect(onClip.mock.calls[0][0].durationMs).toBeGreaterThanOrEqual(600);
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(result.current.state).toBe('idle');
  });

  it('cancel discards the clip and releases the mic', async () => {
    const onClip = vi.fn();
    const { result } = renderHook(() => useVoiceRecorder(onClip));
    await act(async () => void (await result.current.start()));
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    act(() => result.current.cancel());
    expect(onClip).not.toHaveBeenCalled();
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it('reports too_short for a tap', async () => {
    const onClip = vi.fn();
    const { result } = renderHook(() => useVoiceRecorder(onClip));
    await act(async () => void (await result.current.start()));
    act(() => result.current.stop());
    expect(onClip).not.toHaveBeenCalled();
    expect(result.current.error).toBe('too_short');
  });

  it('auto-stops at the maximum duration', async () => {
    const onClip = vi.fn();
    const { result } = renderHook(() => useVoiceRecorder(onClip));
    await act(async () => void (await result.current.start()));
    await act(async () => {
      vi.advanceTimersByTime(2600);
    });
    await waitFor(() => expect(onClip).toHaveBeenCalledTimes(1));
    expect(onClip.mock.calls[0][0].durationMs).toBeLessThanOrEqual(2000);
  });

  it('ignores a second start while the permission prompt is pending (no leaked stream)', async () => {
    let release!: (v: unknown) => void;
    getUserMedia.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const { result } = renderHook(() => useVoiceRecorder(vi.fn()));
    act(() => void result.current.start());
    act(() => void result.current.start());
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    await act(async () => release({ getTracks: () => tracks }));
  });

  it('releases the mic when MediaRecorder cannot be created (previous version leaked it)', async () => {
    FakeRecorder.throwOnCreate = true;
    const { result } = renderHook(() => useVoiceRecorder(vi.fn()));
    await act(async () => void (await result.current.start()));
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(result.current.state).toBe('idle');
    expect(result.current.error).toBe('unsupported');
  });

  it('never leaves the mic on if unmounted while the permission prompt is open', async () => {
    let release!: (v: unknown) => void;
    getUserMedia.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const { result, unmount } = renderHook(() => useVoiceRecorder(vi.fn()));
    act(() => void result.current.start());
    unmount();
    await act(async () => release({ getTracks: () => tracks }));
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it('maps permission errors', async () => {
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'NotAllowedError' }));
    const { result } = renderHook(() => useVoiceRecorder(vi.fn()));
    await act(async () => void (await result.current.start()));
    expect(result.current.state).toBe('denied');
    expect(result.current.error).toBe('denied');
  });

  it('reports unsupported without MediaRecorder', () => {
    vi.stubGlobal('MediaRecorder', undefined);
    const { result } = renderHook(() => useVoiceRecorder(vi.fn()));
    expect(result.current.state).toBe('unsupported');
  });
});
