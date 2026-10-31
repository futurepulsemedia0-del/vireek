import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

afterEach(cleanup);
import { useAction } from './useAction';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

afterEach(cleanup);

describe('useAction', () => {
  it('ignores a second call while the first is in flight (same tick)', async () => {
    const d = deferred<string>();
    const fn = vi.fn(() => d.promise);
    const { result } = renderHook(() => useAction(fn));
    let a: Promise<unknown>, b: Promise<unknown>;
    act(() => {
      a = result.current.run();
      b = result.current.run();
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBe(true);
    await act(async () => {
      d.resolve('ok');
      await a;
    });
    expect(await b!).toBeUndefined();
    expect(result.current.pending).toBe(false);
  });

  it('reuses the idempotency key when the same args are retried after a failure, new key after success', async () => {
    const keys: string[] = [];
    let fail = true;
    const { result } = renderHook(() =>
      useAction(async (ctx, _amount: number) => {
        keys.push(ctx.idempotencyKey);
        if (fail) throw new Error('network');
        return 'paid';
      }),
    );
    await act(async () => void (await result.current.run(100)));
    await act(async () => void (await result.current.run(100)));
    expect(keys[0]).toBe(keys[1]);
    fail = false;
    await act(async () => void (await result.current.run(100)));
    expect(keys[2]).toBe(keys[0]);
    await act(async () => void (await result.current.run(100))); // after success: new logical action
    expect(keys[3]).not.toBe(keys[2]);
  });

  it('generates a new key when the args change', async () => {
    const keys: string[] = [];
    const { result } = renderHook(() =>
      useAction(async (ctx, _n: number) => {
        keys.push(ctx.idempotencyKey);
        throw new Error('x');
      }),
    );
    await act(async () => void (await result.current.run(1)));
    await act(async () => void (await result.current.run(2)));
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('exposes the error, calls onError, and unlocks for retry', async () => {
    const onError = vi.fn();
    const fn = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('ok');
    const { result } = renderHook(() => useAction(fn, { onError }));
    await act(async () => void (await result.current.run()));
    expect((result.current.error as Error).message).toBe('boom');
    expect(onError).toHaveBeenCalledOnce();
    let out: unknown;
    await act(async () => void (out = await result.current.run()));
    expect(out).toBe('ok');
    expect(result.current.error).toBeNull();
  });

  it('aborts the signal on unmount and does not call onSuccess afterwards', async () => {
    const d = deferred<string>();
    let signal!: AbortSignal;
    const onSuccess = vi.fn();
    const { result, unmount } = renderHook(() =>
      useAction(async (ctx) => {
        signal = ctx.signal;
        return d.promise;
      }, { onSuccess }),
    );
    act(() => void result.current.run());
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => d.resolve('late'));
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('cooldownMs blocks immediate re-runs after completion', async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockResolvedValue('ok');
    const { result } = renderHook(() => useAction(fn, { cooldownMs: 1000 }));
    await act(async () => void (await result.current.run()));
    await act(async () => void (await result.current.run()));
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1001);
    await act(async () => void (await result.current.run()));
    expect(fn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
