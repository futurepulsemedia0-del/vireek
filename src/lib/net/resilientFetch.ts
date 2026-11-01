/**
 * Single network wrapper: timeouts, retry with full-jitter backoff for idempotent
 * calls, in-flight GET dedupe and a per-origin circuit breaker. Plugged into
 * supabase-js as `global.fetch`, so every Supabase call goes through it.
 *
 * Timeouts cover time-to-headers only, so streamed bodies (AI/SSE) are never cut.
 */
export type NetState = 'slow-start' | 'slow-end' | 'degraded' | 'recovered';
export const NET_EVENT = 'vireek:net-state';

export interface ResilientInit extends RequestInit {
  /** Time to response headers. Default: 15s, 60s for /functions/v1/, 120s for /storage/v1/. */
  timeoutMs?: number;
  /** Max retries. Default 2 for GET/HEAD, 0 otherwise. Never retries non-idempotent calls unless `idempotent: true`. */
  retries?: number;
  /** Override idempotency detection (e.g. a POST carrying an idempotency key). */
  idempotent?: boolean;
  /** Emit a "slow" state if the call is still running after this many ms. Default 4000 (10000 for edge functions, which may legitimately run AI work). */
  slowAfterMs?: number;
}

export class CircuitOpenError extends Error {
  readonly retryAfterMs: number;
  constructor(origin: string, retryAfterMs: number) {
    super(`Service temporarily unavailable (${origin})`);
    this.name = 'CircuitOpenError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class RequestTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs} ms`);
    this.name = 'RequestTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const BREAKER_STATUS = new Set([500, 502, 503, 504]);
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 30_000;

interface Breaker {
  failures: number;
  openedAt: number | null;
  probing: boolean;
}

const breakers = new Map<string, Breaker>();
const inflight = new Map<string, Promise<Response>>();

/** Test helper — clears breaker and dedupe state. */
export function __resetNetForTests(): void {
  breakers.clear();
  inflight.clear();
}

function emit(state: NetState): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<NetState>(NET_EVENT, { detail: state }));
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function originOf(url: string): string {
  try {
    return new URL(url, typeof window !== 'undefined' ? window.location.href : undefined).origin;
  } catch {
    return 'unknown';
  }
}

function defaultTimeout(url: string): number {
  if (url.includes('/storage/v1/')) return 120_000;
  if (url.includes('/functions/v1/')) return 60_000;
  return 15_000;
}

function breakerGate(origin: string): void {
  const b = breakers.get(origin);
  if (!b || b.openedAt === null) return;
  const elapsed = Date.now() - b.openedAt;
  if (elapsed < BREAKER_COOLDOWN_MS) throw new CircuitOpenError(origin, BREAKER_COOLDOWN_MS - elapsed);
  if (b.probing) throw new CircuitOpenError(origin, 1_000);
  b.probing = true; // half-open: exactly one probe request goes through
}

function releaseProbe(origin: string): void {
  const b = breakers.get(origin);
  if (b) b.probing = false;
}

function recordSuccess(origin: string): void {
  const b = breakers.get(origin);
  if (!b) return;
  breakers.delete(origin);
  if (b.openedAt !== null) emit('recovered');
}

function recordFailure(origin: string): void {
  const b = breakers.get(origin) ?? { failures: 0, openedAt: null, probing: false };
  b.failures += 1;
  b.probing = false;
  if (b.failures >= BREAKER_THRESHOLD || b.openedAt !== null) {
    const wasClosed = b.openedAt === null;
    b.openedAt = Date.now();
    if (wasClosed) emit('degraded');
  }
  breakers.set(origin, b);
}

function backoffMs(attempt: number, res?: Response): number {
  const retryAfter = Number(res?.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 10_000);
  return Math.random() * Math.min(8_000, 400 * 2 ** attempt); // full jitter
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function attemptOnce(
  input: RequestInfo | URL,
  rest: RequestInit,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
): Promise<Response> {
  if (callerSignal?.aborted) throw abortReason(callerSignal);
  const ctl = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => ctl.abort(callerSignal?.reason);
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, timeoutMs);
  try {
    const req = input instanceof Request ? input.clone() : input;
    return await fetch(req, { ...rest, signal: ctl.signal });
  } catch (err) {
    callerSignal?.removeEventListener('abort', onCallerAbort);
    if (timedOut) throw new RequestTimeoutError(timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer); // success path keeps the caller link so aborting still cancels a streaming body
  }
}

async function execute(
  input: RequestInfo | URL,
  rest: RequestInit,
  origin: string,
  timeoutMs: number,
  maxRetries: number,
  signal: AbortSignal | undefined,
  slowAfterMs: number,
): Promise<Response> {
  let slowFired = false;
  const slowTimer = setTimeout(() => {
    slowFired = true;
    emit('slow-start');
  }, slowAfterMs);
  try {
    for (let attempt = 0; ; attempt++) {
      breakerGate(origin);
      try {
        const res = await attemptOnce(input, rest, timeoutMs, signal);
        if (BREAKER_STATUS.has(res.status)) recordFailure(origin);
        else recordSuccess(origin);
        if (RETRY_STATUS.has(res.status) && attempt < maxRetries) {
          void res.body?.cancel();
          await sleep(backoffMs(attempt, res), signal);
          continue;
        }
        return res;
      } catch (err) {
        if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
          releaseProbe(origin);
          throw err;
        }
        recordFailure(origin);
        if (attempt >= maxRetries) throw err;
        await sleep(backoffMs(attempt), signal);
      }
    }
  } finally {
    clearTimeout(slowTimer);
    if (slowFired) emit('slow-end');
  }
}

function dedupeKey(method: string, url: string, init: RequestInit, signal: AbortSignal | undefined): string | null {
  if (method !== 'GET' || init.body || signal) return null;
  const h = new Headers(init.headers);
  return [method, url, h.get('authorization'), h.get('apikey'), h.get('accept'), h.get('range'), h.get('prefer')].join('|');
}

export async function resilientFetch(input: RequestInfo | URL, init?: ResilientInit): Promise<Response> {
  const { timeoutMs, retries, idempotent, slowAfterMs, signal, ...rest } = init ?? {};
  const url = urlOf(input);
  const method = (rest.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const origin = originOf(url);
  const canRetry = idempotent ?? (method === 'GET' || method === 'HEAD');
  const maxRetries = canRetry ? (retries ?? 2) : 0;
  const timeout = timeoutMs ?? defaultTimeout(url);
  const slowAfter = slowAfterMs ?? (url.includes('/functions/v1/') ? 10_000 : 4_000);
  const sig = signal ?? undefined;

  const key = dedupeKey(method, url, rest, sig);
  if (!key) return execute(input, rest, origin, timeout, maxRetries, sig, slowAfter);

  const existing = inflight.get(key);
  if (existing) return (await existing).clone();
  const p = execute(input, rest, origin, timeout, maxRetries, sig, slowAfter);
  inflight.set(key, p);
  const cleanup = () => {
    inflight.delete(key);
  };
  p.then(cleanup, cleanup);
  return (await p).clone();
}
