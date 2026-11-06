// Batches canary/baseline request outcomes inside one edge isolate and flushes them as a single sample row.
// Lossy by design (an isolate can be recycled before its last batch flushes): fine for statistical SLO checks.

export interface HealthSample {
  flagKey: string; cohort: 'canary' | 'baseline';
  requests: number; errors: number; p95Ms: number; callsOffered: number; callsAnswered: number;
}

export interface HealthReporterOptions {
  flush: (sample: HealthSample) => Promise<void>;
  now?: () => number;
  maxBatch?: number;   // default 50 requests
  maxAgeMs?: number;   // default 30 s
}

interface Batch { requests: number; errors: number; latencies: number[]; offered: number; answered: number; startedAt: number }

export function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

export function createHealthReporter({ flush, now = Date.now, maxBatch = 50, maxAgeMs = 30_000 }: HealthReporterOptions) {
  const batches = new Map<string, Batch>();

  function take(id: string): Batch | null {
    const b = batches.get(id);
    batches.delete(id);
    return b ?? null;
  }

  async function send(flagKey: string, cohort: 'canary' | 'baseline', b: Batch): Promise<void> {
    try {
      await flush({ flagKey, cohort, requests: b.requests, errors: b.errors, p95Ms: p95(b.latencies), callsOffered: b.offered, callsAnswered: b.answered });
    } catch {
      // never let telemetry break a request
    }
  }

  function record(flagKey: string, cohort: 'canary' | 'baseline', apply: (b: Batch) => void): Promise<void> {
    const id = `${flagKey}|${cohort}`;
    let b = batches.get(id);
    if (!b) { b = { requests: 0, errors: 0, latencies: [], offered: 0, answered: 0, startedAt: now() }; batches.set(id, b); }
    apply(b);
    const due = b.requests >= maxBatch || now() - b.startedAt >= maxAgeMs;
    const full = due ? take(id) : null;
    return full ? send(flagKey, cohort, full) : Promise.resolve();
  }

  return {
    /** Returns a promise that resolves when a flush (if any) completes; safe to pass to waitUntil. */
    recordRequest(flagKey: string, cohort: 'canary' | 'baseline', o: { ok: boolean; latencyMs: number }) {
      return record(flagKey, cohort, (b) => { b.requests += 1; if (!o.ok) b.errors += 1; b.latencies.push(Math.max(0, Math.round(o.latencyMs))); });
    },
    recordCall(flagKey: string, cohort: 'canary' | 'baseline', answered: boolean) {
      return record(flagKey, cohort, (b) => { b.offered += 1; if (answered) b.answered += 1; });
    },
    /** Flush everything now (e.g. on shutdown). */
    async flushAll() {
      const pending: Promise<void>[] = [];
      for (const id of [...batches.keys()]) {
        const [flagKey, cohort] = id.split('|') as [string, 'canary' | 'baseline'];
        const b = take(id);
        if (b && (b.requests > 0 || b.offered > 0)) pending.push(send(flagKey, cohort, b));
      }
      await Promise.all(pending);
    },
  };
}
