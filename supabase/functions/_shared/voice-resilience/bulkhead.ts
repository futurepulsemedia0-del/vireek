// Bulkhead isolation for external provider calls (Twilio, Telnyx, Vapi).
//
// Problem it solves: when one vendor gets slow, every in-flight call to it holds an isolate's
// resources until its timeout, and a burst of new calls piles on. One degraded provider must not be
// able to consume every slot and starve the others. A bulkhead gives each provider its own
// concurrency limit, a bounded wait queue, and a queue timeout; excess work is rejected FAST with a
// typed error so the caller's existing fallback (next SMS provider, in-app notice, retry next tick)
// runs instead of everything hanging.
//
// HONEST SCOPE: state is per edge-function ISOLATE (module memory), not global across isolates. It
// bounds each isolate's exposure to a slow vendor; it is not a cluster-wide rate limiter and does not
// replace the circuit breaker (circuitBreaker.ts), which reacts to vendor failures. A bulkhead
// rejection is OUR load-shedding, not a vendor failure, so callers must not count it as one.
//
// Feature flag: VOICE_BULKHEAD_ENABLED=true. Default OFF -> bulkheadGuard() returns undefined and
// adapters behave exactly as before. No Deno globals here: env is injected, timers are injectable.

export type BulkheadReason = "queue_full" | "queue_timeout";

export class BulkheadRejectedError extends Error {
  readonly provider: string;
  readonly reason: BulkheadReason;
  constructor(provider: string, reason: BulkheadReason) {
    super(`bulkhead_saturated:${provider}:${reason}`);
    this.name = "BulkheadRejectedError";
    this.provider = provider;
    this.reason = reason;
  }
}

export function isBulkheadRejection(e: unknown): e is BulkheadRejectedError {
  return e instanceof BulkheadRejectedError || (e instanceof Error && e.name === "BulkheadRejectedError");
}

export interface BulkheadConfig {
  /** Calls allowed to run at once. */
  maxConcurrent: number;
  /** Calls allowed to wait for a slot. 0 = never queue, reject immediately when full. */
  maxQueue: number;
  /** Longest a call may wait for a slot before it is rejected. */
  queueTimeoutMs: number;
}

export interface BulkheadMetrics {
  key: string;
  inFlight: number;
  queued: number;
  peakInFlight: number;
  peakQueued: number;
  accepted: number;
  completed: number;
  failed: number;
  rejectedQueueFull: number;
  rejectedQueueTimeout: number;
  totalQueueWaitMs: number;
  maxQueueWaitMs: number;
}

export interface BulkheadClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export const SYSTEM_CLOCK: BulkheadClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export type BulkheadEvent = { type: "rejected"; key: string; reason: BulkheadReason; inFlight: number; queued: number };

export interface Bulkhead {
  readonly key: string;
  run<T>(fn: () => Promise<T>): Promise<T>;
  metrics(): BulkheadMetrics;
}

/** `<T>(fn) => Promise<T>` — what adapters receive. Undefined means "no bulkhead". */
export type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

interface Waiter {
  resolve: () => void;
  reject: (e: Error) => void;
  timer: unknown;
  enqueuedAt: number;
}

export function sanitizeConfig(raw: Partial<BulkheadConfig> | undefined, base: BulkheadConfig): BulkheadConfig {
  const int = (v: unknown, lo: number, hi: number, d: number) => {
    const n = typeof v === "number" ? v : Number.NaN;
    return Number.isInteger(n) && n >= lo && n <= hi ? n : d;
  };
  return {
    maxConcurrent: int(raw?.maxConcurrent, 1, 100, base.maxConcurrent),
    maxQueue: int(raw?.maxQueue, 0, 1000, base.maxQueue),
    queueTimeoutMs: int(raw?.queueTimeoutMs, 50, 30_000, base.queueTimeoutMs),
  };
}

export function createBulkhead(
  key: string,
  config: BulkheadConfig,
  opts: { clock?: BulkheadClock; onEvent?: (e: BulkheadEvent) => void } = {},
): Bulkhead {
  const cfg = sanitizeConfig(config, GENERIC_BULKHEAD); // invalid fields fall back to safe defaults, never to a deadlock
  const clock = opts.clock ?? SYSTEM_CLOCK;
  const queue: Waiter[] = [];
  const m: BulkheadMetrics = {
    key, inFlight: 0, queued: 0, peakInFlight: 0, peakQueued: 0, accepted: 0, completed: 0, failed: 0,
    rejectedQueueFull: 0, rejectedQueueTimeout: 0, totalQueueWaitMs: 0, maxQueueWaitMs: 0,
  };

  const reject = (reason: BulkheadReason): BulkheadRejectedError => {
    if (reason === "queue_full") m.rejectedQueueFull++;
    else m.rejectedQueueTimeout++;
    try { opts.onEvent?.({ type: "rejected", key, reason, inFlight: m.inFlight, queued: queue.length }); } catch { /* telemetry must never break the call path */ }
    return new BulkheadRejectedError(key, reason);
  };

  const start = (waitedMs: number) => {
    m.accepted++;
    m.totalQueueWaitMs += waitedMs;
    m.maxQueueWaitMs = Math.max(m.maxQueueWaitMs, waitedMs);
  };

  function acquire(): Promise<void> {
    if (m.inFlight < cfg.maxConcurrent) {
      m.inFlight++;
      m.peakInFlight = Math.max(m.peakInFlight, m.inFlight);
      start(0);
      return Promise.resolve();
    }
    if (queue.length >= cfg.maxQueue) return Promise.reject(reject("queue_full"));
    return new Promise<void>((resolve, rejectP) => {
      const w: Waiter = { resolve, reject: rejectP, enqueuedAt: clock.now(), timer: null };
      w.timer = clock.setTimeout(() => {
        const i = queue.indexOf(w);
        if (i === -1) return; // already handed a slot
        queue.splice(i, 1);
        m.queued = queue.length;
        rejectP(reject("queue_timeout"));
      }, cfg.queueTimeoutMs);
      queue.push(w);
      m.queued = queue.length;
      m.peakQueued = Math.max(m.peakQueued, queue.length);
    });
  }

  function release() {
    const next = queue.shift();
    m.queued = queue.length;
    if (!next) {
      m.inFlight--;
      return;
    }
    // Hand the slot straight to the oldest waiter: inFlight stays the same, so a new arrival cannot jump the queue.
    clock.clearTimeout(next.timer);
    start(Math.max(0, clock.now() - next.enqueuedAt));
    next.resolve();
  }

  return {
    key,
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        const out = await fn();
        m.completed++;
        return out;
      } catch (e) {
        m.failed++;
        throw e;
      } finally {
        release();
      }
    },
    metrics: () => ({ ...m, queued: queue.length }),
  };
}

// ------------------------------------------------------------------ registry + feature flag

export const BULKHEAD_FLAG = "VOICE_BULKHEAD_ENABLED";
export const BULKHEAD_CONFIG_ENV = "VOICE_BULKHEAD_CONFIG";

export const GENERIC_BULKHEAD: BulkheadConfig = { maxConcurrent: 5, maxQueue: 10, queueTimeoutMs: 2_000 };

/**
 * Starting points, NOT measured values. [VERIFY] tune from real concurrency/latency data
 * (voice_provider_health + Staff Voice Observability) before enabling in production.
 */
export const DEFAULT_BULKHEADS: Readonly<Record<string, BulkheadConfig>> = {
  "twilio:carrier": { maxConcurrent: 8, maxQueue: 16, queueTimeoutMs: 2_000 },
  "twilio:sms": { maxConcurrent: 8, maxQueue: 32, queueTimeoutMs: 3_000 },
  "telnyx:sms": { maxConcurrent: 8, maxQueue: 32, queueTimeoutMs: 3_000 },
  "vapi:voice_engine": { maxConcurrent: 10, maxQueue: 20, queueTimeoutMs: 5_000 },
};

export interface EnvReader {
  get(name: string): string | undefined;
}

export function bulkheadEnabled(env: EnvReader): boolean {
  return env.get(BULKHEAD_FLAG) === "true";
}

/** Defaults + optional VOICE_BULKHEAD_CONFIG JSON overrides, per key and per field. Never throws. */
export function resolveConfig(key: string, env: EnvReader): BulkheadConfig {
  const base = DEFAULT_BULKHEADS[key] ?? GENERIC_BULKHEAD;
  const raw = env.get(BULKHEAD_CONFIG_ENV);
  if (!raw) return base;
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<BulkheadConfig>> | null;
    const own = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed[key] : undefined;
    return own && typeof own === "object" ? sanitizeConfig(own, base) : base;
  } catch {
    return base;
  }
}

const registry = new Map<string, Bulkhead>();

function logEvent(e: BulkheadEvent) {
  // Structured, no payloads, no credentials.
  console.warn(JSON.stringify({ evt: "voice_bulkhead", ...e }));
}

export function getBulkhead(key: string, env: EnvReader): Bulkhead {
  let b = registry.get(key);
  if (!b) {
    b = createBulkhead(key, resolveConfig(key, env), { onEvent: logEvent });
    registry.set(key, b);
  }
  return b;
}

/** Test helper / graceful reset. */
export function resetBulkheads(): void {
  registry.clear();
}

export function allBulkheadMetrics(): BulkheadMetrics[] {
  return [...registry.values()].map((b) => b.metrics());
}

/**
 * The only thing edge functions need: `bulkheadGuard("twilio:carrier", Deno.env)`.
 * Returns undefined when the flag is off, so adapters take their original code path untouched.
 */
export function bulkheadGuard(key: string, env: EnvReader): Guard | undefined {
  if (!bulkheadEnabled(env)) return undefined;
  const b = getBulkhead(key, env);
  return <T>(fn: () => Promise<T>) => b.run(fn);
}
