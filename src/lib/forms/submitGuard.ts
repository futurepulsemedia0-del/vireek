// Single-flight submit with a stable idempotency key and safe network retries.
// Pure (no React) so it is unit-testable; useSubmitGuard wraps it for components.

import { newIdempotencyKey } from './idempotency';

export interface SubmitContext {
  /** Reused across retries AND across user re-clicks of the same payload until success. */
  idempotencyKey: string;
  attempt: number;
  signal: AbortSignal;
}

export type SubmitOutcome<T> =
  | { status: 'success'; value: T }
  | { status: 'error'; error: unknown; offline: boolean }
  | { status: 'ignored' };

export interface SubmitGuardOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  isRetryable?: (error: unknown) => boolean;
  isOnline?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  newKey?: () => string;
  onSubmittingChange?: (submitting: boolean) => void;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true; // fetch() network failure
  if (error && typeof error === 'object') {
    const e = error as { name?: unknown; status?: unknown };
    if (e.name === 'FunctionsFetchError' || e.name === 'NetworkError') return true;
    if (typeof e.status === 'number' && RETRYABLE_STATUS.has(e.status)) return true;
  }
  return false;
}

function signatureOf(args: unknown): string {
  try {
    return JSON.stringify(args) ?? '';
  } catch {
    return String(Math.random());
  }
}

export function createSubmitGuard<TArgs, TResult>(
  fn: (args: TArgs, ctx: SubmitContext) => Promise<TResult>,
  options: SubmitGuardOptions = {},
) {
  const maxRetries = options.maxRetries ?? 2;
  const baseDelay = options.baseDelayMs ?? 600;
  const retryable = options.isRetryable ?? isNetworkError;
  const online = options.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const makeKey = options.newKey ?? newIdempotencyKey;

  let inFlight = false;
  let key: string | null = null;
  let keySignature = '';
  let controller: AbortController | null = null;

  const setSubmitting = (v: boolean) => {
    inFlight = v;
    options.onSubmittingChange?.(v);
  };

  return {
    isSubmitting: () => inFlight,
    abort: () => controller?.abort(),
    async run(args: TArgs): Promise<SubmitOutcome<TResult>> {
      if (inFlight) return { status: 'ignored' }; // synchronous guard: blocks same-tick double clicks
      setSubmitting(true);
      const sig = signatureOf(args);
      if (key === null || sig !== keySignature) {
        key = makeKey();
        keySignature = sig;
      }
      const opKey: string = key;
      controller = new AbortController();
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            const value = await fn(args, { idempotencyKey: opKey, attempt, signal: controller.signal });
            key = null; // a later submit is a NEW operation
            return { status: 'success', value };
          } catch (error) {
            const offline = !online();
            if (offline || attempt >= maxRetries || !retryable(error)) {
              return { status: 'error', error, offline };
            }
            await sleep(baseDelay * 2 ** attempt + Math.floor(Math.random() * 150));
          }
        }
      } finally {
        setSubmitting(false);
      }
    },
  };
}
