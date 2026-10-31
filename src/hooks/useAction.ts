// src/hooks/useAction.ts
//
// One safe way to run an async user action (pay, submit, delete, send):
//  - synchronous in-flight lock (a ref, not state), so a double-click in the
//    same tick can never start two runs
//  - optional cooldown after completion
//  - AbortSignal passed to the action; aborted on unmount, no state updates after
//  - idempotency key per logical attempt: reused when the SAME args are retried
//    after a failure, regenerated after a success or when the args change
import { useCallback, useEffect, useRef, useState } from 'react';

export function createIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface ActionContext {
  signal: AbortSignal;
  /** Send as the Idempotency-Key header / idempotency_key field for sensitive writes. */
  idempotencyKey: string;
}

export interface UseActionOptions<T> {
  /** Ignore new runs for this long after a run settles (default 0). */
  cooldownMs?: number;
  onSuccess?: (result: T) => void;
  onError?: (error: unknown) => void;
}

function argsSignature(args: unknown[]): string | null {
  try {
    return JSON.stringify(args);
  } catch {
    return null; // not serializable: never reuse a key
  }
}

export function useAction<A extends unknown[], T>(
  fn: (ctx: ActionContext, ...args: A) => Promise<T>,
  options: UseActionOptions<T> = {},
) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const inFlight = useRef(false);
  const cooldownUntil = useRef(0);
  const mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const keyRef = useRef<{ key: string; sig: string | null } | null>(null);

  // Always call the latest fn/options without re-creating `run`.
  const latest = useRef({ fn, options });
  latest.current = { fn, options };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);

  const run = useCallback(async (...args: A): Promise<T | undefined> => {
    if (inFlight.current || Date.now() < cooldownUntil.current) return undefined;
    inFlight.current = true;

    const sig = argsSignature(args);
    if (!keyRef.current || sig === null || keyRef.current.sig !== sig) {
      keyRef.current = { key: createIdempotencyKey(), sig };
    }
    const ctl = new AbortController();
    controller.current = ctl;
    setPending(true);
    setError(null);

    try {
      const result = await latest.current.fn({ signal: ctl.signal, idempotencyKey: keyRef.current.key }, ...args);
      keyRef.current = null; // success: next attempt is a new logical action
      if (mounted.current) latest.current.options.onSuccess?.(result);
      return result;
    } catch (e) {
      if (ctl.signal.aborted) return undefined;
      if (mounted.current) {
        setError(e);
        latest.current.options.onError?.(e);
      }
      return undefined;
    } finally {
      inFlight.current = false;
      controller.current = null;
      cooldownUntil.current = Date.now() + (latest.current.options.cooldownMs ?? 0);
      if (mounted.current) setPending(false);
    }
  }, []);

  const abort = useCallback(() => controller.current?.abort(), []);
  const reset = useCallback(() => {
    keyRef.current = null;
    setError(null);
  }, []);

  return { run, pending, error, abort, reset };
}
